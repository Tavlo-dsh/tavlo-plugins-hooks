import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { Context } from '@deepseek-ai/cordis'
import * as HostConnection from '@deepseek-ai/dsh-client-connection'
import { installConnection } from '@deepseek-ai/dsh-client-connection/client'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import React from 'react'
import * as hooksPlugin from '../index.js'

const RPC_ENDPOINT = 'tavlo-hooks/rpc'
const RPC_PATH = `/api/${RPC_ENDPOINT}`
const EVENTS_PATH = '/api/tavlo-hooks/events'
const CLIENT_STATE_PATH = '/api/tavlo-hooks/client-state'
const SCRIPT_UPLOAD_PATH = '/api/tavlo-hooks/scripts/upload'
const SCRIPT_SOURCE_PATH = '/api/tavlo-hooks/scripts/source'
const SOUND_UPLOAD_PATH = '/api/tavlo-hooks/sound/upload'
const SOUND_CURRENT_PATH = '/api/tavlo-hooks/sound/current'

function createValidWavBuffer(payloadBytes = 16) {
  const buf = Buffer.alloc(44 + payloadBytes)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + payloadBytes, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(8000, 24)
  buf.writeUInt32LE(8000, 28)
  buf.writeUInt16LE(1, 32)
  buf.writeUInt16LE(8, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(payloadBytes, 40)
  return buf
}

async function mountRealHost(t, { useApply = true, runtimeOpts = {} } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-hooks-host-'))
  const ctx = new Context()
  const fibers = []
  const own = (fiber) => {
    fibers.push(fiber)
    return fiber
  }

  t.after(async () => {
    for (const fiber of [...fibers].reverse()) {
      await fiber.dispose().catch(() => {})
    }
    await rm(root, { recursive: true, force: true })
  })

  await own(ctx.plugin(Storage)).await()
  await own(ctx.plugin(StorageJson, { root })).await()
  await own(ctx.plugin(StorageDomain, { backend: 'json' })).await()

  ctx.provide('dshHomePath', (...parts) => path.join(root, ...parts))
  const credentialRecords = new Map()
  ctx.provide('credentials', {
    readRecord: async (key) => credentialRecords.get(key),
    modifyRecord: async (key, mutate) => {
      const next = await mutate(credentialRecords.get(key))
      if (next !== undefined) credentialRecords.set(key, next)
      return next
    },
    deleteRecord: async (key) => {
      credentialRecords.delete(key)
    },
  })
  ctx.provide('settings', { configure() {} })

  await own(ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })).await()
  await own(ctx.plugin(HostConnection)).await()

  let pluginFiber
  let runtime
  if (useApply) {
    pluginFiber = own(ctx.plugin(hooksPlugin))
    await pluginFiber.await()
  } else {
    runtime = await hooksPlugin.createHooksPluginRuntime(ctx, {
      dataDir: root,
      ...runtimeOpts,
    })
    t.after(() => runtime.dispose())
  }

  const connection = ctx.get('connection')
  const origin = ctx.get('webServer').getOrigin()
  const login = new URL(connection.authenticatedUrl(`${origin}/`))
  let cookie
  assert.equal(
    connection.authorizeIndex(
      {
        method: 'GET',
        url: login.pathname + login.search,
        headers: { host: login.host },
      },
      {
        writeHead(status, headers) {
          assert.equal(status, 303)
          cookie = headers['set-cookie'].split(';')[0]
        },
        end() {},
      },
    ),
    false,
  )
  assert.equal(typeof cookie, 'string')

  const fetchAuthenticated = (input, init = {}) => {
    const headers = new Headers(init.headers)
    headers.set('cookie', cookie)
    return fetch(new URL(input, `${origin}/`), { ...init, headers })
  }

  const clientCtx = new Context()
  await own(
    clientCtx.plugin({
      apply(c) {
        installConnection(c, { transport: { fetch: fetchAuthenticated } })
      },
    }),
  ).await()

  return {
    root,
    ctx,
    origin,
    connection,
    fetchAuthenticated,
    rpc: clientCtx.get('connection').rpc,
    pluginFiber,
    runtime,
  }
}

function callHooksRpc(rpc, operation, input = {}, signal) {
  return rpc.call('/api', RPC_ENDPOINT, { operation, input }, signal)
}

async function openSseStream(fetchAuthenticated, signal) {
  const res = await fetchAuthenticated(EVENTS_PATH, {
    method: 'GET',
    headers: { accept: 'text/event-stream' },
    signal,
  })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') || '', /^text\/event-stream/i)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  async function nextEvent(timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      let match
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, match.index)
        buffer = buffer.slice(match.index + match[0].length)
        let eventName = 'message'
        const dataLines = []
        for (const line of frame.split(/\r?\n/)) {
          if (!line || line.startsWith(':')) continue
          if (line.startsWith('event:')) eventName = line.slice(6).trim()
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
        }
        if (dataLines.length > 0) {
          return { event: eventName, data: JSON.parse(dataLines.join('\n')) }
        }
      }
      const remaining = Math.max(10, deadline - Date.now())
      const readPromise = reader.read()
      const timeoutPromise = new Promise((_res, rej) =>
        setTimeout(() => rej(new Error(`SSE read timed out after ${timeoutMs}ms`)), remaining),
      )
      const { done, value } = await Promise.race([readPromise, timeoutPromise])
      if (done) throw new Error('SSE stream ended unexpectedly')
      buffer += decoder.decode(value, { stream: true })
    }
    throw new Error(`SSE event not received within ${timeoutMs}ms`)
  }

  async function nextEventOf(eventName, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const remaining = Math.max(10, deadline - Date.now())
      const ev = await nextEvent(remaining)
      if (ev.event === eventName) return ev
    }
    throw new Error(`SSE event ${eventName} not received within ${timeoutMs}ms`)
  }

  return {
    nextEvent,
    nextEventOf,
    close: async () => {
      await reader.cancel().catch(() => {})
    },
  }
}

test('host-rpc: unauthenticated and untrusted-origin requests are rejected across all routes', async (t) => {
  const { origin, fetchAuthenticated, connection } = await mountRealHost(t)

  // Unauthenticated requests -> 401
  assert.equal((await fetch(`${origin}${RPC_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401)
  assert.equal((await fetch(`${origin}${EVENTS_PATH}`, { method: 'GET' })).status, 401)
  assert.equal(
    (await fetch(`${origin}${SCRIPT_UPLOAD_PATH}?mountPointId=turn.completed&filename=a.mjs`, {
      method: 'POST',
      body: 'console.log(1)\n',
    })).status,
    401,
  )
  assert.equal(
    (await fetch(`${origin}${SOUND_UPLOAD_PATH}?filename=a.wav`, {
      method: 'POST',
      body: createValidWavBuffer(),
    })).status,
    401,
  )

  // Authenticated but untrusted Origin header -> 403
  assert.equal(
    (await fetchAuthenticated(RPC_PATH, {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: '{}',
    })).status,
    403,
  )
  assert.equal(
    (await fetchAuthenticated(EVENTS_PATH, {
      method: 'GET',
      headers: { origin: 'https://evil.example' },
    })).status,
    403,
  )

  // Non-owner guest peer rejected -> 403
  const guest = connection.createPeer({ principal: { kind: 'guest-probe' } })
  t.after(() => guest.dispose())
  const sharedHandler = connection.createSharedFetchHandler('/api')
  const guestReq = new Request(`${origin}${RPC_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'g1', method: RPC_ENDPOINT, payload: { operation: 'getState', input: {} } }),
  })
  assert.equal((await sharedHandler.fetch(guestReq, guest)).status, 403)
})

test('host-rpc: owner-authenticated RPCs, optimistic concurrency, target secrets, WAV upload, script upload/source/test, and SSE delivery', async (t) => {
  const { ctx, fetchAuthenticated, rpc } = await mountRealHost(t)

  // 1. Initial getState & silence native OS system notifications during automated HTTP test
  const initState = await callHooksRpc(rpc, 'getState')
  assert.equal(initState.ok, true)
  assert.equal(initState.value.revision, 0)
  assert.equal(initState.value.mountPoints.length, 19)
  assert.equal(initState.value.providers.length, 11)

  const savedSysOff = await callHooksRpc(rpc, 'saveSettings', {
    expectedRevision: 0,
    systemNotifications: { enabled: false, taskbarAttentionEnabled: false },
    inApp: { enabled: true, autoCloseEnabled: true, autoCloseSeconds: 30 },
  })
  assert.equal(savedSysOff.ok, true)
  assert.equal(savedSysOff.value.revision, 1)
  assert.equal(savedSysOff.value.config.inApp.autoCloseSeconds, 30)

  // Stale expectedRevision -> hooks/revision-conflict
  const conflict = await callHooksRpc(rpc, 'saveSettings', {
    expectedRevision: 0,
    inApp: { enabled: false },
  })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.error.code, 'hooks/revision-conflict')

  // 2. toggleMountPoint & toggleMountPointBell
  const toggledMount = await callHooksRpc(rpc, 'toggleMountPoint', {
    mountPointId: 'tool.pre',
    enabled: true,
    expectedRevision: 1,
  })
  assert.equal(toggledMount.ok, true)
  assert.equal(toggledMount.value.config.mountPoints['tool.pre'].enabled, true)

  const toggledBell = await callHooksRpc(rpc, 'toggleMountPointBell', {
    mountPointId: 'turn.completed',
    bellEnabled: false,
    expectedRevision: toggledMount.value.revision,
  })
  assert.equal(toggledBell.ok, true)
  assert.equal(toggledBell.value.config.mountPoints['turn.completed'].bellEnabled, false)

  // 3. saveThirdPartyTarget + secret masking + preserve-on-blank
  const savedTarget = await callHooksRpc(rpc, 'saveThirdPartyTarget', {
    expectedRevision: toggledBell.value.revision,
    target: {
      name: 'DingOps',
      provider: 'dingtalk',
      enabled: true,
      events: { Stop: true, PermissionRequest: true },
      config: {
        webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=ding_secret_1234',
        secret: 'SEC_ding_9876',
      },
    },
  })
  assert.equal(savedTarget.ok, true)
  const targetView = savedTarget.value.config.thirdParty.targets[0]
  assert.equal(JSON.stringify(targetView).includes('ding_secret_1234'), false)
  assert.equal(JSON.stringify(targetView).includes('SEC_ding_9876'), false)
  assert.deepEqual(targetView.secretState, {
    webhookUrl: { configured: true, preview: '••••1234' },
    secret: { configured: true, preview: '••••9876' },
  })

  // Re-save target name without secret fields -> preserves both secrets
  const updatedTarget = await callHooksRpc(rpc, 'saveThirdPartyTarget', {
    expectedRevision: savedTarget.value.revision,
    target: {
      id: targetView.id,
      name: 'DingOps Renamed',
      provider: 'dingtalk',
      enabled: true,
      events: { Stop: true },
      config: {},
    },
  })
  assert.equal(updatedTarget.ok, true)
  assert.equal(updatedTarget.value.config.thirdParty.targets[0].name, 'DingOps Renamed')
  assert.deepEqual(updatedTarget.value.config.thirdParty.targets[0].secretState, {
    webhookUrl: { configured: true, preview: '••••1234' },
    secret: { configured: true, preview: '••••9876' },
  })

  // 4. sound/upload (invalid WAV -> 400, valid WAV -> 200, sound/current -> 200 audio/wav, clearCustomSound -> 404)
  const revSound = updatedTarget.value.revision
  const badWavRes = await fetchAuthenticated(`${SOUND_UPLOAD_PATH}?filename=fake.wav&expectedRevision=${revSound}`, {
    method: 'POST',
    headers: { 'content-type': 'audio/wav' },
    body: Buffer.from('\x89PNG\r\n\x1a\nnot-a-wav-file'),
  })
  assert.equal(badWavRes.status, 400)
  const badWavJson = await badWavRes.json()
  assert.equal(badWavJson.ok, false)
  assert.equal(badWavJson.error.code, 'sound/invalid-wav')

  const validWav = createValidWavBuffer(24)
  const goodWavRes = await fetchAuthenticated(`${SOUND_UPLOAD_PATH}?filename=chime.wav&expectedRevision=${revSound}`, {
    method: 'POST',
    headers: { 'content-type': 'audio/wav' },
    body: validWav,
  })
  assert.equal(goodWavRes.status, 200)
  const goodWavJson = await goodWavRes.json()
  assert.equal(goodWavJson.ok, true)
  assert.equal(goodWavJson.value.customSound.filename, 'chime.wav')

  const currentSound = await fetchAuthenticated(SOUND_CURRENT_PATH, { method: 'GET' })
  assert.equal(currentSound.status, 200)
  assert.equal(currentSound.headers.get('content-type'), 'audio/wav')
  assert.equal(currentSound.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(Buffer.from(await currentSound.arrayBuffer()).equals(validWav), true)

  const clearedSound = await callHooksRpc(rpc, 'clearCustomSound', {
    expectedRevision: goodWavJson.value.revision,
  })
  assert.equal(clearedSound.ok, true)
  assert.equal(clearedSound.value.customSound, null)
  assert.equal((await fetchAuthenticated(SOUND_CURRENT_PATH, { method: 'GET' })).status, 404)

  // 5. scripts/upload + scripts/source + testScript
  const scriptContent = `import { readFileSync } from 'node:fs'
const ev = JSON.parse(readFileSync(0, 'utf8'))
process.stdout.write(JSON.stringify({ notify: true, summary: 'Custom ran: ' + ev.hookPoint }) + '\\n')
`
  const uploadScriptRes = await fetchAuthenticated(
    `${SCRIPT_UPLOAD_PATH}?mountPointId=turn.completed&filename=custom-hello.mjs&name=HelloScript&expectedRevision=${clearedSound.value.revision}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: scriptContent,
    },
  )
  assert.equal(uploadScriptRes.status, 200)
  const uploadScriptJson = await uploadScriptRes.json()
  assert.equal(uploadScriptJson.ok, true)
  const uploadedScript = uploadScriptJson.value.script
  assert.equal(uploadedScript.kind, 'custom')

  const sourceRes = await fetchAuthenticated(
    `${SCRIPT_SOURCE_PATH}?mountPointId=turn.completed&scriptId=${encodeURIComponent(uploadedScript.id)}`,
    { method: 'GET' },
  )
  assert.equal(sourceRes.status, 200)
  const sourceJson = await sourceRes.json()
  assert.equal(sourceJson.ok, true)
  assert.equal(sourceJson.value.content, scriptContent)

  const testScriptRes = await callHooksRpc(rpc, 'testScript', {
    mountPointId: 'turn.completed',
    scriptId: uploadedScript.id,
  })
  assert.equal(testScriptRes.ok, true)
  assert.equal(testScriptRes.value.exitCode, 0)
  assert.equal(testScriptRes.value.directive?.summary, 'Custom ran: turn.completed')

  // 6. SSE notification & dismiss delivery over real HTTP
  const sseAbort = new AbortController()
  t.after(() => sseAbort.abort())
  const sse = await openSseStream(fetchAuthenticated, sseAbort.signal)

  // Trigger approval.request via Cordis waterfall and wait for SSE notification
  await ctx.waterfall(
    'approval/request',
    {
      agent: { session: { id: 'sess-sse-1', header: { cwd: 'C:\\work\\sse-proj' } } },
      callId: 'call-sse-99',
      toolName: 'Bash',
      reason: 'Run check',
    },
    () => 'ok',
  )

  const logsEvent = await sse.nextEventOf('logs', 5000)
  assert.equal(Array.isArray(logsEvent.data?.logs), true)

  const notifEvent = await sse.nextEventOf('notification', 5000)
  assert.equal(notifEvent.event, 'notification')
  assert.equal(notifEvent.data.hookPoint, 'approval.request')
  assert.equal(notifEvent.data.approvalId, 'call-sse-99')
  assert.equal(notifEvent.data.project, 'sse-proj')

  // Trigger approval/decided -> SSE dismiss event
  ctx.emit(
    'session/event',
    { id: 'sess-sse-1', header: { cwd: 'C:\\work\\sse-proj' } },
    { type: 'approval/decided', data: { id: 'call-sse-99' } },
  )
  const dismissEvent = await sse.nextEventOf('dismiss', 4000)
  assert.equal(dismissEvent.event, 'dismiss')
  assert.equal(dismissEvent.data.approvalId, 'call-sse-99')
  await sse.close()
})

test('host-rpc: client-state focus tracking controls suppressWhenFocused in real HTTP runtime', async (t) => {
  const spawnCalls = []
  const spawnImpl = (cmd, args, options) => {
    spawnCalls.push({ cmd, args, env: options?.env })
    return {
      stdout: { on() {} },
      stderr: { on() {} },
      once(ev, cb) {
        if (ev === 'close') queueMicrotask(() => cb(0))
      },
    }
  }
  const fetchCalls = []
  const fetchImpl = async (url, init) => {
    fetchCalls.push({ url, init })
    return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  const { fetchAuthenticated, rpc, runtime } = await mountRealHost(t, {
    useApply: false,
    runtimeOpts: { platform: 'win32', spawnImpl, fetchImpl },
  })

  // Turn off default script on turn.completed so testMountPoint fires immediately
  const st0 = await callHooksRpc(rpc, 'getState')
  await callHooksRpc(rpc, 'toggleScript', {
    mountPointId: 'turn.completed',
    scriptId: 'notify-task-done',
    enabled: false,
    expectedRevision: st0.value.revision,
  })

  // Report focused & visible browser client -> system notification is suppressed
  const focusedRes = await fetchAuthenticated(CLIENT_STATE_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: 'tab-1', focused: true, visible: true }),
  })
  assert.equal(focusedRes.status, 200)
  assert.deepEqual((await focusedRes.json()).value, { focusedClients: 1, connectedClients: 1 })

  const beforeFocusedSpawns = spawnCalls.length
  const rFocused = await callHooksRpc(rpc, 'testMountPoint', { mountPointId: 'turn.completed' })
  assert.equal(rFocused.ok, true)
  assert.equal(rFocused.value.dispatch.systemNotification.channel, 'none')
  assert.equal(rFocused.value.dispatch.taskbar.skipped, true)
  assert.equal(spawnCalls.filter((c) => c.env?.DSH_TOAST_TITLE).length, 0)
  assert.equal(spawnCalls.length >= beforeFocusedSpawns, true)

  // Report unfocused browser client -> system notification & taskbar flash execute
  const blurRes = await fetchAuthenticated(CLIENT_STATE_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: 'tab-1', focused: false, visible: true }),
  })
  assert.equal(blurRes.status, 200)
  assert.deepEqual((await blurRes.json()).value, { focusedClients: 0, connectedClients: 1 })

  const rBlurred = await callHooksRpc(rpc, 'testMountPoint', { mountPointId: 'turn.completed' })
  assert.equal(rBlurred.ok, true)
  assert.equal(rBlurred.value.dispatch.systemNotification.ok, true)
  assert.equal(spawnCalls.some((c) => c.env?.DSH_TOAST_TITLE), true)
  assert.equal(spawnCalls.some((c) => c.env?.DSH_FLASH_MODE === 'finite'), true)

  // testThirdPartyTarget via RPC with mocked fetchImpl
  const tpSave = await callHooksRpc(rpc, 'saveThirdPartyTarget', {
    expectedRevision: runtime.configStore.getSnapshot().revision,
    target: {
      name: 'WeComOps',
      provider: 'wecom',
      enabled: true,
      config: { webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k9999' },
    },
  })
  assert.equal(tpSave.ok, true)
  const targetId = tpSave.value.config.thirdParty.targets[0].id
  const tpTest = await callHooksRpc(rpc, 'testThirdPartyTarget', { targetId })
  assert.equal(tpTest.ok, true)
  assert.equal(tpTest.value.accepted, true)
  assert.equal(fetchCalls.length, 1)
  assert.equal(fetchCalls[0].url, 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k9999')
})

test('host-rpc: lib/client.js loads cleanly in vm.runInNewContext and registers all 4 DSH slots', async (t) => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const appendedStyles = []
  let removedStyles = 0
  const fakeHead = {
    appendChild(node) {
      appendedStyles.push(node)
      node.remove = () => {
        removedStyles++
      }
    },
  }

  let loadedModule
  const requiredModules = []
  const allowedModules = new Set([
    'react',
    'react/jsx-runtime',
    'react-dom',
    'react-dom/client',
    '@deepseek-ai/dsh-client-ui-primitives',
  ])

  const windowObj = {
    crypto: webcrypto,
    addEventListener() {},
    removeEventListener() {},
    __ModuleLoader__: {
      load(mod) {
        loadedModule = mod
      },
    },
  }

  const sandbox = {
    window: windowObj,
    document: {
      head: fakeHead,
      createElement(tag) {
        return { tagName: tag.toUpperCase(), dataset: {}, textContent: '' }
      },
    },
    AbortController,
    TextDecoder,
    URLSearchParams,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  }

  vm.runInNewContext(source, sandbox, { filename: 'lib/client.js' })
  assert.equal(loadedModule?.id, '@tavlo-dsh/dsh-plugin-hooks')

  const definition = loadedModule.factory((name) => {
    assert.equal(allowedModules.has(name), true, `Unexpected client require: ${name}`)
    requiredModules.push(name)
    if (name === 'react') return React
    if (name === 'react/jsx-runtime') return { jsx: React.createElement, jsxs: React.createElement, Fragment: React.Fragment }
    if (name === 'react-dom') return { createPortal: (el) => el }
    return {}
  })

  assert.deepEqual([...definition.inject], ['slots', 'locale', 'connection'])

  const clientCtx = new Context()
  const registeredSlots = []
  const registeredLocales = new Map()
  let disposedLocales = 0

  clientCtx.provide('slots', {
    inject: (_name, fn) => fn(),
    register(descriptor, component) {
      registeredSlots.push({ descriptor, component })
      return () => {}
    },
  })
  clientCtx.provide('locale', {
    register(ns, lang, dict) {
      registeredLocales.set(`${ns}:${lang}`, dict)
      return () => {
        disposedLocales++
      }
    },
    bind(ns) {
      return (key) => registeredLocales.get(`${ns}:zh`)?.[key] ?? key
    },
  })
  clientCtx.provide('connection', {
    rpc: {
      call: async () => ({ ok: true, value: {} }),
    },
  })

  const fiber = clientCtx.plugin(definition)
  t.after(() => fiber.dispose())
  await fiber.await()

  assert.equal(appendedStyles.length, 1)
  assert.equal(appendedStyles[0].dataset.tavloHooksStyle, 'true')
  assert.equal(registeredLocales.has('tavlo-hooks:en'), true)
  assert.equal(registeredLocales.has('tavlo-hooks:zh'), true)

  const settingsSlot = registeredSlots.find((s) => s.descriptor.name === 'settings.section')
  const iconSlot = registeredSlots.find((s) => s.descriptor.name === 'settings.section.icon')
  const bundleSlot = registeredSlots.find((s) => s.descriptor.name === 'plugins.bundle.config')
  const overlaySlot = registeredSlots.find((s) => s.descriptor.name === 'shell.overlay')

  assert.equal(settingsSlot?.descriptor.id, 'tavlo-hooks.settings')
  assert.equal(settingsSlot?.descriptor.label(), 'Hook')
  assert.equal(iconSlot?.descriptor.id, 'tavlo-hooks.settings')
  assert.equal(bundleSlot?.descriptor.key, '@tavlo-dsh/dsh-plugin-hooks')
  assert.equal(overlaySlot?.descriptor.id, 'tavlo-hooks.toast-overlay')

  await fiber.dispose()
  assert.equal(removedStyles, 1)
  assert.equal(disposedLocales, 2)
})
