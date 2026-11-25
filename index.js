/**
 * DSH Hook & Notification Plugin Host Entry (@tavlo-dsh/dsh-plugin-hooks).
 * Mounts owner-only HTTP/RPC/SSE/upload routes, DSH event bridge, script runner,
 * config & credential persistence, and multi-channel notification dispatcher.
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection'
import s from '@deepseek-ai/schemastery'
import { createConfigStore, ConfigStoreError } from './src/config-store.js'
import { createDshHookBridge } from './src/dsh-hook-bridge.js'
import { createEventHub } from './src/event-hub.js'
import { CATEGORY_META, HOOK_MOUNT_POINTS, getMountPoint } from './src/hook-catalog.js'
import { createNotificationDispatcher } from './src/notification-dispatcher.js'
import {
  createScriptRunner,
  MAX_SCRIPT_BYTES,
  readScriptSource,
  saveUploadedScript,
  ScriptRunnerError,
} from './src/script-runner.js'
import {
  clearCustomSound,
  getCustomSoundInfo,
  getCustomSoundPath,
  MAX_WAV_BYTES,
  saveCustomSound,
  validateWavBuffer,
} from './src/sound-manager.js'
import { clearTaskbarAttention, isWsl } from './src/system-notifier.js'
import {
  getSecretFieldKeys,
  PROVIDER_DEFINITIONS,
  PROVIDER_IDS,
  validateProviderConfig,
} from './src/third-party-providers.js'

export const name = 'tavlo-hooks'
export const inject = ['connection', 'storageDomain', 'credentials']
export const Config = s.object({})

const RPC_METHOD = 'tavlo-hooks/rpc'
const RPC_PATH = `/api/${RPC_METHOD}`
const EVENTS_PATH = '/api/tavlo-hooks/events'
const CLIENT_STATE_PATH = '/api/tavlo-hooks/client-state'
const SCRIPT_UPLOAD_PATH = '/api/tavlo-hooks/scripts/upload'
const SCRIPT_SOURCE_PATH = '/api/tavlo-hooks/scripts/source'
const SOUND_UPLOAD_PATH = '/api/tavlo-hooks/sound/upload'
const SOUND_CURRENT_PATH = '/api/tavlo-hooks/sound/current'

const MAX_RPC_BODY_BYTES = 512 * 1024
const UPLOAD_TIMEOUT_MS = 30_000

const SAFE_CONTENT_HEADERS = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "sandbox; default-src 'none'",
}

const NO_STORE_HEADERS = {
  'cache-control': 'no-store',
}

function defaultDataDir(ctx) {
  const resolver = ctx?.get?.('dshHomePath')
  if (typeof resolver === 'function') {
    return resolver()
  }
  const envHome = process.env.DSH_HOME?.trim()
  return envHome ? path.resolve(envHome) : path.join(homedir(), '.dsh')
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function errorPayload(code, message, details) {
  return {
    ok: false,
    error: {
      code,
      message,
      details: isPlainObject(details) ? details : {},
    },
  }
}

function mapError(error) {
  if (error instanceof ConfigStoreError) {
    return errorPayload(`hooks/${error.code}`, error.message)
  }
  if (error instanceof ScriptRunnerError) {
    return errorPayload(error.code, error.message)
  }
  if (error?.code && typeof error.code === 'string' && error.code.includes('/')) {
    return errorPayload(error.code, error.message || 'Operation failed')
  }
  return errorPayload('hooks/internal-error', error?.message || 'Operation failed')
}

async function readStreamedBody(request, maxBytes, timeoutMs = UPLOAD_TIMEOUT_MS) {
  const reader = request.body?.getReader?.()
  if (!reader) {
    return { ok: false, status: 400, code: 'hooks/empty-body', message: 'Request body is required' }
  }
  const chunks = []
  let size = 0
  let expired = false
  const timer = setTimeout(() => {
    expired = true
    void reader.cancel().catch(() => {})
  }, timeoutMs)
  timer.unref?.()

  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (!value) continue
      size += value.byteLength
      if (size > maxBytes) {
        return {
          ok: false,
          status: 413,
          code: 'hooks/payload-too-large',
          message: `Upload exceeds ${maxBytes} bytes limit`,
        }
      }
      chunks.push(value)
    }
  } catch {
    return expired
      ? { ok: false, status: 408, code: 'hooks/upload-timeout', message: 'Upload timed out' }
      : { ok: false, status: 400, code: 'hooks/bad-request', message: 'Failed to read upload body' }
  } finally {
    clearTimeout(timer)
    try {
      reader.releaseLock()
    } catch {
      // ignore
    }
  }

  if (expired) {
    return { ok: false, status: 408, code: 'hooks/upload-timeout', message: 'Upload timed out' }
  }
  if (size === 0) {
    return { ok: false, status: 400, code: 'hooks/empty-body', message: 'Uploaded file is empty' }
  }
  return { ok: true, buffer: Buffer.concat(chunks, size) }
}

/**
 * Create the complete Hooks plugin runtime (dependency-injectable for tests).
 */
export async function createHooksPluginRuntime(ctx, opts = {}) {
  const logger = opts.logger ?? ctx?.get?.('logger')
  const platform = opts.platform ?? process.platform
  const getDataDir = () => opts.dataDir ?? defaultDataDir(ctx)
  const storageDomain = opts.storageDomain ?? ctx?.get?.('storageDomain')
  const credentials = opts.credentials ?? ctx?.get?.('credentials')
  const connection = opts.connection ?? ctx?.get?.('connection')
  const getSubprocess = () => opts.subprocess ?? ctx?.get?.('subprocess')

  const eventHub =
    opts.eventHub ??
    createEventHub({
      heartbeatMs: opts.heartbeatMs,
      maxBufferBytes: opts.maxBufferBytes,
      clientTtlMs: opts.clientTtlMs,
    })

  const configStore =
    opts.configStore ??
    createConfigStore({
      getDataDir,
      storageDomain,
      credentials,
      logger,
    })

  await configStore.init()

  const scriptRunner =
    opts.scriptRunner ??
    createScriptRunner({
      getDataDir,
      getSubprocess,
      eventHub,
      spawnImpl: opts.spawnImpl,
      platform,
      logger,
    })

  await scriptRunner.init?.()

  const dispatcher =
    opts.dispatcher ??
    createNotificationDispatcher({
      getConfig: () => configStore.getSnapshot().config,
      getResolvedSecrets: (targetId) => configStore.getResolvedSecrets(targetId),
      getDataDir,
      eventHub,
      logger,
      fetchImpl: opts.fetchImpl,
      spawnImpl: opts.spawnImpl,
      platform,
    })

  const bridge =
    opts.bridge ??
    createDshHookBridge({
      ctx,
      configStore,
      scriptRunner,
      dispatcher,
      logger,
      turnCompleteDebounceMs: opts.turnCompleteDebounceMs,
    })

  let hadUnfocusedOrFlashing = false

  async function buildStateView() {
    const { revision, config } = configStore.getSnapshot()
    const customSound = await getCustomSoundInfo(getDataDir())
    config.systemNotifications.customSoundFilename = customSound?.filename ?? null
    return {
      revision,
      isWindows: platform === 'win32',
      platform,
      isWsl: isWsl({ platform }),
      config,
      customSound,
      mountPoints: HOOK_MOUNT_POINTS,
      categories: CATEGORY_META,
      providers: PROVIDER_DEFINITIONS,
      logs: scriptRunner.getLogs(),
    }
  }

  function mergeTargetForTest(rawTarget) {
    const inputTarget = isPlainObject(rawTarget) ? rawTarget : null
    if (!inputTarget || !PROVIDER_IDS.includes(inputTarget.provider)) {
      throw new ConfigStoreError('invalid-config', 'Invalid third-party provider')
    }
    const provider = inputTarget.provider
    const secretKeys = getSecretFieldKeys(provider) ?? []
    const secretSet = new Set(secretKeys)
    const savedSecrets = inputTarget.id ? configStore.getResolvedSecrets(inputTarget.id) : {}

    const rawConfig = isPlainObject(inputTarget.config) ? inputTarget.config : {}
    const rawSecrets = isPlainObject(inputTarget.secrets) ? inputTarget.secrets : {}

    const nonSecretConfig = {}
    for (const [k, v] of Object.entries(rawConfig)) {
      if (!secretSet.has(k) && v !== undefined) {
        nonSecretConfig[k] = v
      }
    }

    const mergedSecrets = {}
    for (const key of secretKeys) {
      const candidate = rawSecrets[key] !== undefined ? rawSecrets[key] : rawConfig[key]
      if (typeof candidate === 'string' && candidate.trim() !== '') {
        mergedSecrets[key] = candidate.trim()
      } else if (typeof savedSecrets[key] === 'string' && savedSecrets[key].length > 0) {
        mergedSecrets[key] = savedSecrets[key]
      }
    }

    const check = validateProviderConfig(provider, { ...nonSecretConfig, ...mergedSecrets })
    if (check && check.valid === false) {
      throw new ConfigStoreError('invalid-config', check.message || check.error || 'Invalid provider configuration')
    }

    return {
      target: {
        id: typeof inputTarget.id === 'string' ? inputTarget.id : 'draft',
        name: typeof inputTarget.name === 'string' && inputTarget.name.trim() ? inputTarget.name.trim() : provider,
        provider,
        enabled: true,
        events: isPlainObject(inputTarget.events) ? inputTarget.events : {},
        config: nonSecretConfig,
      },
      mergedSecrets,
    }
  }

  async function executeRpc(operation, input = {}, signal) {
    if (!isPlainObject(input)) {
      return errorPayload('hooks/bad-request', 'RPC input must be a plain object')
    }
    try {
      switch (operation) {
        case 'getState':
          return { ok: true, value: await buildStateView() }

        case 'saveSettings':
          await configStore.saveSettings(input)
          return { ok: true, value: await buildStateView() }

        case 'toggleMountPoint':
          await configStore.toggleMountPoint(input)
          return { ok: true, value: await buildStateView() }

        case 'toggleMountPointBell':
          await configStore.toggleMountPointBell(input)
          return { ok: true, value: await buildStateView() }

        case 'toggleScript':
          await configStore.toggleScript(input)
          return { ok: true, value: await buildStateView() }

        case 'updateScriptMeta': {
          const updated = await configStore.updateScriptMeta(input)
          return { ok: true, value: { ...(await buildStateView()), script: updated.script } }
        }

        case 'deleteScript':
          await configStore.deleteScript(input)
          return { ok: true, value: await buildStateView() }

        case 'resetDefaultScripts':
          await configStore.resetDefaultScripts(input)
          return { ok: true, value: await buildStateView() }

        case 'testMountPoint': {
          const outcome = await bridge.testMountPoint(input.mountPointId)
          if (configStore.getSnapshot().config.systemNotifications.taskbarAttentionEnabled) {
            hadUnfocusedOrFlashing = true
          }
          return { ok: true, value: { ...outcome, state: await buildStateView() } }
        }

        case 'testScript': {
          const outcome = await bridge.testScript(input.mountPointId, input.scriptId)
          return { ok: true, value: outcome }
        }

        case 'getExecutionLogs':
          return { ok: true, value: { logs: scriptRunner.getLogs(input.limit) } }

        case 'saveThirdPartyTarget':
          await configStore.saveThirdPartyTarget({
            target: input.target ?? input,
            expectedRevision: input.expectedRevision,
          })
          return { ok: true, value: await buildStateView() }

        case 'toggleThirdPartyTarget':
          await configStore.toggleThirdPartyTarget(input)
          return { ok: true, value: await buildStateView() }

        case 'deleteThirdPartyTarget':
          await configStore.deleteThirdPartyTarget(input)
          return { ok: true, value: await buildStateView() }

        case 'testThirdPartyTarget': {
          let targetObj = isPlainObject(input.target) ? input.target : undefined
          if (!targetObj && typeof input.targetId === 'string') {
            targetObj = configStore
              .getSnapshot()
              .config.thirdParty.targets.find((t) => t.id === input.targetId)
          } else if (!targetObj && typeof input.provider === 'string') {
            targetObj = input
          }
          if (targetObj && typeof input.targetId === 'string' && !targetObj.id) {
            targetObj = { ...targetObj, id: input.targetId }
          }
          const { target, mergedSecrets } = mergeTargetForTest(targetObj)
          const res = await dispatcher.testThirdPartyTarget(target, mergedSecrets, { signal })
          return { ok: true, value: res }
        }

        case 'clearCustomSound':
          await clearCustomSound(getDataDir())
          await configStore.setCustomSoundFilename({
            filename: null,
            expectedRevision: input.expectedRevision,
          })
          return { ok: true, value: await buildStateView() }

        case 'testSystemNotification': {
          const res = await dispatcher.testSystemNotification()
          return { ok: true, value: res }
        }

        case 'testTaskbarFlash': {
          hadUnfocusedOrFlashing = true
          const res = await dispatcher.testTaskbarFlash(input)
          return { ok: true, value: res }
        }

        default:
          return errorPayload('hooks/not-found', `Unknown operation: ${String(operation)}`)
      }
    } catch (error) {
      return mapError(error)
    }
  }

  async function handleRpcRequest(request) {
    const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    if (mediaType !== 'application/json') {
      return new Response('content type must be application/json', { status: 415, headers: NO_STORE_HEADERS })
    }
    let text
    try {
      text = await request.text()
    } catch {
      return new Response('Bad request', { status: 400, headers: NO_STORE_HEADERS })
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_RPC_BODY_BYTES) {
      return new Response('Request too large', { status: 413, headers: NO_STORE_HEADERS })
    }
    let parsedJson
    try {
      parsedJson = JSON.parse(text)
    } catch {
      return new Response('body is not JSON', { status: 400, headers: NO_STORE_HEADERS })
    }

    const envelope = clientRequestSchema.safeParse(parsedJson)
    if (envelope.success) {
      const { rpcId, method, payload } = envelope.data
      if (method !== RPC_METHOD) {
        return Response.json(
          {
            type: 'server-response',
            rpcId,
            result: errorPayload('gateway/bad-request', `Unexpected RPC method: ${method}`),
          },
          { headers: NO_STORE_HEADERS },
        )
      }
      if (!isPlainObject(payload) || typeof payload.operation !== 'string') {
        return Response.json(
          {
            type: 'server-response',
            rpcId,
            result: errorPayload('hooks/bad-request', 'Expected { operation, input }'),
          },
          { headers: NO_STORE_HEADERS },
        )
      }
      const result = await executeRpc(payload.operation, payload.input ?? {}, request.signal)
      return Response.json({ type: 'server-response', rpcId, result }, { headers: NO_STORE_HEADERS })
    }

    if (isPlainObject(parsedJson) && parsedJson.type === 'client-request') {
      const rpcId = typeof parsedJson.rpcId === 'string' ? parsedJson.rpcId : 'invalid-request'
      return Response.json(
        {
          type: 'server-response',
          rpcId,
          result: errorPayload('gateway/bad-request', 'Invalid RPC envelope'),
        },
        { headers: NO_STORE_HEADERS },
      )
    }

    if (isPlainObject(parsedJson) && typeof parsedJson.operation === 'string') {
      const result = await executeRpc(parsedJson.operation, parsedJson.input ?? {}, request.signal)
      return Response.json(result, { headers: NO_STORE_HEADERS })
    }

    return Response.json(errorPayload('hooks/bad-request', 'Invalid RPC request'), {
      status: 400,
      headers: NO_STORE_HEADERS,
    })
  }

  async function handleClientStateRequest(request) {
    let body
    try {
      body = await request.json()
    } catch {
      return Response.json(errorPayload('hooks/bad-request', 'Invalid JSON body'), {
        status: 400,
        headers: NO_STORE_HEADERS,
      })
    }
    if (!isPlainObject(body) || typeof body.clientId !== 'string' || !body.clientId.trim()) {
      return Response.json(errorPayload('hooks/bad-request', 'clientId is required'), {
        status: 400,
        headers: NO_STORE_HEADERS,
      })
    }

    const focused = Boolean(body.focused)
    const visible = Boolean(body.visible)
    const closing = Boolean(body.closing)
    const wasFocused = eventHub.hasFocusedVisibleClient()

    if (!focused || !visible) {
      hadUnfocusedOrFlashing = true
    }

    eventHub.updateClientState({
      clientId: body.clientId,
      focused,
      visible,
      closing,
    })

    if (focused && visible && !closing && (hadUnfocusedOrFlashing || !wasFocused)) {
      hadUnfocusedOrFlashing = false
      if (typeof dispatcher.clearTaskbarAttention === 'function') {
        void dispatcher.clearTaskbarAttention().catch(() => {})
      } else {
        void clearTaskbarAttention({ platform, spawnImpl: opts.spawnImpl }).catch(() => {})
      }
    }

    return Response.json(
      {
        ok: true,
        value: {
          focusedClients: eventHub.getFocusedClientCount(),
          connectedClients: eventHub.getConnectedClientCount(),
        },
      },
      { headers: NO_STORE_HEADERS },
    )
  }

  async function handleScriptUploadRequest(request) {
    const params = new URL(request.url).searchParams
    const mountPointId = params.get('mountPointId') || ''
    if (!getMountPoint(mountPointId)) {
      return Response.json(errorPayload('hooks/not-found', `Unknown mount point: ${mountPointId}`), {
        status: 404,
        headers: NO_STORE_HEADERS,
      })
    }

    const expectedRevRaw = params.get('expectedRevision')
    const expectedRevision = expectedRevRaw !== null && expectedRevRaw !== '' ? Number(expectedRevRaw) : undefined
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
      return Response.json(errorPayload('hooks/bad-request', 'Invalid expectedRevision'), {
        status: 400,
        headers: NO_STORE_HEADERS,
      })
    }

    const streamed = await readStreamedBody(request, MAX_SCRIPT_BYTES)
    if (!streamed.ok) {
      return Response.json(errorPayload(streamed.code, streamed.message), {
        status: streamed.status,
        headers: NO_STORE_HEADERS,
      })
    }

    try {
      const scriptEntry = await saveUploadedScript(getDataDir(), {
        filename: params.get('filename') || '',
        buffer: streamed.buffer,
        name: params.get('name') || undefined,
        matcher: params.get('matcher') ?? '',
        timeoutSeconds: params.get('timeoutSeconds'),
      })
      try {
        const saved = await configStore.addCustomScript({
          mountPointId,
          scriptEntry,
          expectedRevision,
        })
        return Response.json(
          { ok: true, value: { ...(await buildStateView()), script: saved.script } },
          { headers: NO_STORE_HEADERS },
        )
      } catch (error) {
        const { deleteCustomScriptFile } = await import('./src/script-runner.js')
        await deleteCustomScriptFile(getDataDir(), scriptEntry.filename).catch(() => {})
        const status = error instanceof ConfigStoreError && error.code === 'revision-conflict' ? 409 : 400
        return Response.json(mapError(error), { status, headers: NO_STORE_HEADERS })
      }
    } catch (error) {
      return Response.json(mapError(error), { status: 400, headers: NO_STORE_HEADERS })
    }
  }

  async function handleScriptSourceRequest(request) {
    const params = new URL(request.url).searchParams
    const mountPointId = params.get('mountPointId') || ''
    const scriptId = params.get('scriptId') || ''
    const mp = configStore.getSnapshot().config.mountPoints?.[mountPointId]
    const scriptEntry = mp?.scripts?.find((s) => s.id === scriptId)
    if (!scriptEntry) {
      return Response.json(errorPayload('hooks/not-found', 'Script not found'), {
        status: 404,
        headers: NO_STORE_HEADERS,
      })
    }

    try {
      const content = await readScriptSource(getDataDir(), scriptEntry)
      return Response.json(
        {
          ok: true,
          value: {
            scriptId: scriptEntry.id,
            mountPointId,
            filename: scriptEntry.filename,
            kind: scriptEntry.kind,
            content,
          },
        },
        { headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } },
      )
    } catch (error) {
      const status = error instanceof ScriptRunnerError && error.code === 'hooks/script-not-found' ? 404 : 400
      return Response.json(mapError(error), { status, headers: NO_STORE_HEADERS })
    }
  }

  async function handleSoundUploadRequest(request) {
    const params = new URL(request.url).searchParams
    const expectedRevRaw = params.get('expectedRevision')
    const expectedRevision = expectedRevRaw !== null && expectedRevRaw !== '' ? Number(expectedRevRaw) : undefined
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
      return Response.json(errorPayload('hooks/bad-request', 'Invalid expectedRevision'), {
        status: 400,
        headers: NO_STORE_HEADERS,
      })
    }
    if (expectedRevision !== undefined && expectedRevision !== configStore.getSnapshot().revision) {
      return Response.json(
        errorPayload(
          'hooks/revision-conflict',
          'Revision conflict: settings changed. Reload the latest settings before saving.',
        ),
        { status: 409, headers: NO_STORE_HEADERS },
      )
    }

    const streamed = await readStreamedBody(request, MAX_WAV_BYTES)
    if (!streamed.ok) {
      return Response.json(errorPayload(streamed.code, streamed.message), {
        status: streamed.status,
        headers: NO_STORE_HEADERS,
      })
    }

    const wavCheck = validateWavBuffer(streamed.buffer)
    if (!wavCheck.valid) {
      return Response.json(errorPayload(wavCheck.errorCode || 'sound/invalid-wav', wavCheck.reason || 'Invalid WAV file'), {
        status: 400,
        headers: NO_STORE_HEADERS,
      })
    }

    try {
      const sound = await saveCustomSound(getDataDir(), streamed.buffer, params.get('filename') || 'custom.wav')
      await configStore.setCustomSoundFilename({
        filename: sound.filename,
        expectedRevision,
      })
      return Response.json(
        { ok: true, value: await buildStateView() },
        { headers: NO_STORE_HEADERS },
      )
    } catch (error) {
      const status = error instanceof ConfigStoreError && error.code === 'revision-conflict' ? 409 : 400
      return Response.json(mapError(error), { status, headers: NO_STORE_HEADERS })
    }
  }

  async function handleSoundCurrentRequest() {
    const dataDir = getDataDir()
    const info = await getCustomSoundInfo(dataDir)
    if (!info) {
      return Response.json(errorPayload('hooks/sound-not-found', 'No custom sound configured'), {
        status: 404,
        headers: NO_STORE_HEADERS,
      })
    }
    try {
      const bytes = await readFile(getCustomSoundPath(dataDir))
      return new Response(bytes, {
        status: 200,
        headers: {
          ...SAFE_CONTENT_HEADERS,
          'Content-Type': 'audio/wav',
        },
      })
    } catch {
      return Response.json(errorPayload('hooks/sound-not-found', 'Custom sound file unavailable'), {
        status: 404,
        headers: NO_STORE_HEADERS,
      })
    }
  }

  const routeDisposers = []
  function registerRoutes() {
    if (!connection?.fetch?.register) return
    const register = (route) => {
      const dispose = connection.fetch.register(route)
      if (typeof dispose === 'function') routeDisposers.push(dispose)
    }

    register({
      path: RPC_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: handleRpcRequest,
    })
    register({
      path: EVENTS_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: (request) => eventHub.open(request),
    })
    register({
      path: CLIENT_STATE_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: handleClientStateRequest,
    })
    register({
      path: SCRIPT_UPLOAD_PATH,
      methods: ['POST'],
      requestBody: 'streaming',
      fetch: handleScriptUploadRequest,
    })
    register({
      path: SCRIPT_SOURCE_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: handleScriptSourceRequest,
    })
    register({
      path: SOUND_UPLOAD_PATH,
      methods: ['POST'],
      requestBody: 'streaming',
      fetch: handleSoundUploadRequest,
    })
    register({
      path: SOUND_CURRENT_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: handleSoundCurrentRequest,
    })
  }

  bridge.mount()
  registerRoutes()

  async function dispose() {
    while (routeDisposers.length > 0) {
      const fn = routeDisposers.pop()
      try {
        await fn?.()
      } catch {
        // ignore route disposal failures
      }
    }
    bridge.dispose()
    eventHub.close()
    await dispatcher.dispose?.()
    await scriptRunner.flushLogs?.()
    await configStore.close()
  }

  return {
    configStore,
    eventHub,
    scriptRunner,
    dispatcher,
    bridge,
    executeRpc,
    buildStateView,
    dispose,
  }
}

/**
 * Cordis plugin activation entry.
 */
export async function apply(ctx) {
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })

  const runtime = await createHooksPluginRuntime(ctx)
  ctx.effect(() => () => runtime.dispose(), 'tavlo-hooks: runtime lifecycle')

  const logger = ctx.get('logger')
  logger?.info?.('tavlo-hooks: hook bridge, script runner, SSE events, and notification dispatcher ready')
}
