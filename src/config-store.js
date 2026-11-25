/**
 * Persistent configuration and encrypted/credential-backed secret store.
 * Uses `ctx.storageDomain` for non-secret settings (with atomic JSON file fallback)
 * and `ctx.credentials` (`GrantRecord`) for third-party webhook tokens/secrets.
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import {
  createDefaultCategoryEvents,
  HOOK_MOUNT_POINTS,
  NOTIFICATION_CATEGORIES,
  getMountPoint,
} from './hook-catalog.js'
import { ensureDefaultScripts, getDefaultScriptById } from './default-scripts.js'
import { clampTimeoutSeconds, deleteCustomScriptFile } from './script-runner.js'
import { getCustomSoundInfo } from './sound-manager.js'
import {
  getSecretFieldKeys,
  PROVIDER_DEFINITIONS,
  PROVIDER_IDS,
  validateProviderConfig,
} from './third-party-providers.js'

export const MAX_THIRD_PARTY_TARGETS = 20
export const SECRET_CREDENTIAL_KEY = credentialKey('tavlo-hooks', 'third-party-secrets')

const storedConfigEnvelopeSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  config: z.record(z.string(), z.unknown()),
})

export const hooksConfigDomain = defineDomain({
  name: 'tavlo_hooks_config',
  version: 1,
  layout: 'single',
  global: {
    initial: { version: 1, revision: 0, config: {} },
    schema: storedConfigEnvelopeSchema,
  },
  tables: {},
})

export class ConfigStoreError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

export function maskSecretPreview(value) {
  if (typeof value !== 'string' || !value) return ''
  if (value.length <= 4) return '••••'
  return `••••${value.slice(-4)}`
}

function clampAutoCloseSeconds(raw) {
  const n = Math.round(Number(raw))
  if (!Number.isFinite(n)) return 60
  return Math.min(3600, Math.max(5, n))
}

function clampFlashCount(raw) {
  const n = Math.round(Number(raw))
  if (!Number.isFinite(n)) return 5
  return Math.min(20, Math.max(1, n))
}

function normalizeCategoryEvents(rawEvents) {
  const defaults = createDefaultCategoryEvents()
  const out = {}
  for (const cat of NOTIFICATION_CATEGORIES) {
    out[cat] = typeof rawEvents?.[cat] === 'boolean' ? rawEvents[cat] : defaults[cat]
  }
  return out
}

function buildDefaultScriptsForMountPoint(mp) {
  const scripts = []
  for (const scriptId of mp.defaultScriptIds) {
    const def = getDefaultScriptById(scriptId)
    if (!def) continue
    scripts.push({
      id: def.id,
      kind: 'default',
      name: def.nameZh,
      filename: def.filename,
      enabled: Boolean(mp.defaultEnabled && def.enabledByDefault),
      matcher: '',
      timeoutSeconds: 10,
    })
  }
  return scripts
}

export function buildDefaultConfig() {
  const mountPoints = {}
  for (const mp of HOOK_MOUNT_POINTS) {
    mountPoints[mp.id] = {
      enabled: Boolean(mp.defaultEnabled),
      bellEnabled: Boolean(mp.defaultBell),
      scripts: buildDefaultScriptsForMountPoint(mp),
    }
  }
  return {
    inApp: {
      enabled: true,
      autoCloseEnabled: true,
      autoCloseSeconds: 60,
    },
    systemNotifications: {
      enabled: true,
      suppressWhenFocused: true,
      taskbarAttentionEnabled: true,
      taskbarAttentionMode: 'finite',
      taskbarAttentionFlashCount: 5,
      customSoundFilename: null,
    },
    thirdParty: {
      enabled: true,
      targets: [],
    },
    mountPoints,
  }
}

function normalizeScriptItem(raw, fallbackMountPoint) {
  if (!raw || typeof raw !== 'object') return null
  if (raw.kind === 'default') {
    const def = getDefaultScriptById(raw.id)
    if (!def) return null
    return {
      id: def.id,
      kind: 'default',
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 120) : def.nameZh,
      filename: def.filename,
      enabled:
        typeof raw.enabled === 'boolean'
          ? raw.enabled
          : Boolean(fallbackMountPoint.defaultEnabled && def.enabledByDefault),
      matcher: typeof raw.matcher === 'string' ? raw.matcher.trim().slice(0, 256) : '',
      timeoutSeconds: clampTimeoutSeconds(raw.timeoutSeconds),
    }
  }
  if (raw.kind === 'custom' && typeof raw.id === 'string' && typeof raw.filename === 'string') {
    return {
      id: raw.id,
      kind: 'custom',
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 120) : raw.filename,
      filename: raw.filename,
      ...(typeof raw.originalFilename === 'string' ? { originalFilename: raw.originalFilename } : {}),
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
      matcher: typeof raw.matcher === 'string' ? raw.matcher.trim().slice(0, 256) : '',
      timeoutSeconds: clampTimeoutSeconds(raw.timeoutSeconds),
      ...(typeof raw.createdAt === 'string' ? { createdAt: raw.createdAt } : {}),
    }
  }
  return null
}

function normalizeConfig(raw) {
  const defaults = buildDefaultConfig()
  const src = raw && typeof raw === 'object' ? raw : {}

  const inAppSrc = src.inApp && typeof src.inApp === 'object' ? src.inApp : {}
  const sysSrc = src.systemNotifications && typeof src.systemNotifications === 'object' ? src.systemNotifications : {}
  const tpSrc = src.thirdParty && typeof src.thirdParty === 'object' ? src.thirdParty : {}
  const mpSrc = src.mountPoints && typeof src.mountPoints === 'object' ? src.mountPoints : {}

  const rawTargets = Array.isArray(tpSrc.targets) ? tpSrc.targets.slice(0, MAX_THIRD_PARTY_TARGETS) : []
  const targets = []
  for (const row of rawTargets) {
    if (!row || typeof row !== 'object') continue
    if (!PROVIDER_IDS.includes(row.provider)) continue
    const id = typeof row.id === 'string' && row.id.trim() ? row.id.trim() : `tp_${randomUUID()}`
    const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim().slice(0, 64) : row.provider
    const secretKeys = new Set(getSecretFieldKeys(row.provider) ?? [])
    const cleanConfig = {}
    if (row.config && typeof row.config === 'object') {
      for (const [k, v] of Object.entries(row.config)) {
        if (!secretKeys.has(k) && v !== undefined) {
          cleanConfig[k] = v
        }
      }
    }
    targets.push({
      id,
      name,
      provider: row.provider,
      enabled: typeof row.enabled === 'boolean' ? row.enabled : true,
      events: normalizeCategoryEvents(row.events),
      config: cleanConfig,
    })
  }

  const mountPoints = {}
  for (const mp of HOOK_MOUNT_POINTS) {
    const existing = mpSrc[mp.id] && typeof mpSrc[mp.id] === 'object' ? mpSrc[mp.id] : null
    if (!existing) {
      mountPoints[mp.id] = defaults.mountPoints[mp.id]
      continue
    }
    const existingScripts = Array.isArray(existing.scripts)
      ? existing.scripts.map((s) => normalizeScriptItem(s, mp)).filter(Boolean)
      : []
    const seenIds = new Set(existingScripts.map((s) => s.id))
    for (const defScript of buildDefaultScriptsForMountPoint(mp)) {
      if (!seenIds.has(defScript.id)) {
        existingScripts.unshift(defScript)
      }
    }
    mountPoints[mp.id] = {
      enabled: typeof existing.enabled === 'boolean' ? existing.enabled : Boolean(mp.defaultEnabled),
      bellEnabled: typeof existing.bellEnabled === 'boolean' ? existing.bellEnabled : Boolean(mp.defaultBell),
      scripts: existingScripts,
    }
  }

  return {
    inApp: {
      enabled: typeof inAppSrc.enabled === 'boolean' ? inAppSrc.enabled : defaults.inApp.enabled,
      autoCloseEnabled:
        typeof inAppSrc.autoCloseEnabled === 'boolean'
          ? inAppSrc.autoCloseEnabled
          : defaults.inApp.autoCloseEnabled,
      autoCloseSeconds:
        inAppSrc.autoCloseSeconds !== undefined
          ? clampAutoCloseSeconds(inAppSrc.autoCloseSeconds)
          : defaults.inApp.autoCloseSeconds,
    },
    systemNotifications: {
      enabled: typeof sysSrc.enabled === 'boolean' ? sysSrc.enabled : defaults.systemNotifications.enabled,
      suppressWhenFocused:
        typeof sysSrc.suppressWhenFocused === 'boolean'
          ? sysSrc.suppressWhenFocused
          : defaults.systemNotifications.suppressWhenFocused,
      taskbarAttentionEnabled:
        typeof sysSrc.taskbarAttentionEnabled === 'boolean'
          ? sysSrc.taskbarAttentionEnabled
          : defaults.systemNotifications.taskbarAttentionEnabled,
      taskbarAttentionMode:
        sysSrc.taskbarAttentionMode === 'untilFocused' ? 'untilFocused' : 'finite',
      taskbarAttentionFlashCount:
        sysSrc.taskbarAttentionFlashCount !== undefined
          ? clampFlashCount(sysSrc.taskbarAttentionFlashCount)
          : defaults.systemNotifications.taskbarAttentionFlashCount,
      customSoundFilename:
        typeof sysSrc.customSoundFilename === 'string' && sysSrc.customSoundFilename.trim()
          ? sysSrc.customSoundFilename.trim()
          : null,
    },
    thirdParty: {
      enabled: typeof tpSrc.enabled === 'boolean' ? tpSrc.enabled : defaults.thirdParty.enabled,
      targets,
    },
    mountPoints,
  }
}

async function atomicWriteJson(filePath, data, mode) {
  await mkdir(path.dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  try {
    await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8')
    if (mode !== undefined && process.platform !== 'win32') {
      await chmod(tmpPath, mode).catch(() => {})
    }
    await rename(tmpPath, filePath)
  } catch (error) {
    await unlink(tmpPath).catch(() => {})
    throw error
  }
}

function normalizeSecretsPayload(payload) {
  const out = {}
  if (!payload || typeof payload !== 'object') return out
  const targets = payload.targets && typeof payload.targets === 'object' ? payload.targets : {}
  for (const [targetId, fields] of Object.entries(targets)) {
    if (!fields || typeof fields !== 'object') continue
    const cleanFields = {}
    for (const [k, v] of Object.entries(fields)) {
      if (typeof v === 'string' && v.length > 0) {
        cleanFields[k] = v
      }
    }
    if (Object.keys(cleanFields).length > 0) {
      out[targetId] = cleanFields
    }
  }
  return out
}

function buildProviderDefaultConfig(providerId) {
  const def = PROVIDER_DEFINITIONS.find((item) => item.id === providerId)
  const out = {}
  if (!def) return out
  for (const field of def.fields) {
    if (field.kind !== 'secret' && field.defaultValue !== undefined) {
      out[field.key] = field.defaultValue
    }
  }
  return out
}

/**
 * Create the config and secrets store.
 */
export function createConfigStore({ getDataDir, storageDomain, credentials, logger } = {}) {
  let domain = null
  let revision = 0
  let config = buildDefaultConfig()
  let secretsByTarget = {}
  let writeTail = Promise.resolve()
  let initialized = false

  const configFallbackPath = () => path.join(getDataDir(), 'hooks', 'config.json')
  const secretsFallbackPath = () => path.join(getDataDir(), 'hooks', 'secrets.json')

  async function loadSecrets() {
    if (credentials && typeof credentials.readRecord === 'function') {
      try {
        const record = await credentials.readRecord(SECRET_CREDENTIAL_KEY)
        if (record?.kind === 'grant') {
          return normalizeSecretsPayload(record.payload)
        }
        return {}
      } catch (error) {
        logger?.warn?.(`tavlo-hooks: credentials read failed: ${error?.message || error}`)
      }
    }
    try {
      const raw = await readFile(secretsFallbackPath(), 'utf8')
      return normalizeSecretsPayload(JSON.parse(raw))
    } catch {
      return {}
    }
  }

  async function persistSecrets(nextSecrets) {
    const clean = normalizeSecretsPayload({ targets: nextSecrets })
    if (credentials && typeof credentials.modifyRecord === 'function') {
      if (Object.keys(clean).length === 0 && typeof credentials.deleteRecord === 'function') {
        await credentials.deleteRecord(SECRET_CREDENTIAL_KEY)
      } else {
        await credentials.modifyRecord(SECRET_CREDENTIAL_KEY, async () => ({
          kind: 'grant',
          payload: { version: 1, targets: clean },
        }))
      }
      return clean
    }
    await atomicWriteJson(secretsFallbackPath(), { version: 1, targets: clean }, 0o600)
    return clean
  }

  async function persistDocument(nextRevision, nextConfig) {
    const doc = {
      version: 1,
      revision: nextRevision,
      config: nextConfig,
    }
    if (domain) {
      await domain.global.set(doc)
      return
    }
    await atomicWriteJson(configFallbackPath(), doc)
  }

  async function init() {
    if (initialized) return
    const dataDir = getDataDir()
    await ensureDefaultScripts(dataDir, { overwrite: false })

    let loadedDoc = null
    if (storageDomain && typeof storageDomain.open === 'function') {
      domain = await storageDomain.open(hooksConfigDomain)
      const globalDoc = domain.global.get()
      if (globalDoc && globalDoc.revision > 0) {
        loadedDoc = globalDoc
      }
    } else {
      try {
        const raw = await readFile(configFallbackPath(), 'utf8')
        const parsed = storedConfigEnvelopeSchema.safeParse(JSON.parse(raw))
        if (parsed.success) {
          loadedDoc = parsed.data
        }
      } catch {
        // First boot with no config.json
      }
    }

    if (loadedDoc) {
      revision = loadedDoc.revision
      config = normalizeConfig(loadedDoc.config)
    } else {
      revision = 0
      config = buildDefaultConfig()
    }

    secretsByTarget = await loadSecrets()
    const soundInfo = await getCustomSoundInfo(dataDir)
    config.systemNotifications.customSoundFilename = soundInfo?.filename ?? null
    initialized = true
  }

  async function close() {
    await writeTail.catch(() => {})
    if (domain) {
      const target = domain
      domain = null
      await target.close()
    }
    initialized = false
  }

  function buildTargetView(target) {
    const secretKeys = getSecretFieldKeys(target.provider) ?? []
    const storedSecrets = secretsByTarget[target.id] ?? {}
    const secretState = {}
    for (const key of secretKeys) {
      const val = storedSecrets[key]
      secretState[key] = {
        configured: Boolean(typeof val === 'string' && val.length > 0),
        ...(typeof val === 'string' && val.length > 0 ? { preview: maskSecretPreview(val) } : {}),
      }
    }
    return {
      ...target,
      config: { ...target.config },
      events: { ...target.events },
      secretState,
    }
  }

  function getPublicConfig() {
    return {
      inApp: { ...config.inApp },
      systemNotifications: { ...config.systemNotifications },
      thirdParty: {
        enabled: config.thirdParty.enabled,
        targets: config.thirdParty.targets.map(buildTargetView),
      },
      mountPoints: Object.fromEntries(
        Object.entries(config.mountPoints).map(([id, mp]) => [
          id,
          {
            enabled: mp.enabled,
            bellEnabled: mp.bellEnabled,
            scripts: mp.scripts.map((s) => ({ ...s })),
          },
        ]),
      ),
    }
  }

  function getSnapshot() {
    return {
      revision,
      config: getPublicConfig(),
    }
  }

  function getResolvedSecrets(targetId) {
    if (typeof targetId === 'string') {
      return { ...(secretsByTarget[targetId] ?? {}) }
    }
    const copy = {}
    for (const [id, fields] of Object.entries(secretsByTarget)) {
      copy[id] = { ...fields }
    }
    return copy
  }

  function enqueueWrite(expectedRevision, mutator) {
    const job = writeTail.then(async () => {
      if (expectedRevision !== undefined && expectedRevision !== revision) {
        throw new ConfigStoreError(
          'revision-conflict',
          'Revision conflict: settings changed. Reload the latest settings before saving.',
        )
      }
      const next = await mutator(structuredClone(config), structuredClone(secretsByTarget))
      const nextConfig = normalizeConfig(next.config)
      let nextSecrets = secretsByTarget
      if (next.secrets !== undefined) {
        nextSecrets = await persistSecrets(next.secrets)
      }
      const nextRevision = revision + 1
      await persistDocument(nextRevision, nextConfig)
      config = nextConfig
      secretsByTarget = nextSecrets
      revision = nextRevision
      return {
        revision,
        config: getPublicConfig(),
        ...(next.extra ?? {}),
      }
    })
    writeTail = job.catch(() => {})
    return job
  }

  async function saveSettings(patch = {}) {
    const expectedRevision = patch.expectedRevision
    return enqueueWrite(expectedRevision, (draft) => {
      if (patch.inApp && typeof patch.inApp === 'object') {
        if (typeof patch.inApp.enabled === 'boolean') draft.inApp.enabled = patch.inApp.enabled
        if (typeof patch.inApp.autoCloseEnabled === 'boolean') {
          draft.inApp.autoCloseEnabled = patch.inApp.autoCloseEnabled
        }
        if (patch.inApp.autoCloseSeconds !== undefined) {
          draft.inApp.autoCloseSeconds = clampAutoCloseSeconds(patch.inApp.autoCloseSeconds)
        }
      }
      if (patch.systemNotifications && typeof patch.systemNotifications === 'object') {
        const s = patch.systemNotifications
        if (typeof s.enabled === 'boolean') draft.systemNotifications.enabled = s.enabled
        if (typeof s.suppressWhenFocused === 'boolean') {
          draft.systemNotifications.suppressWhenFocused = s.suppressWhenFocused
        }
        if (typeof s.taskbarAttentionEnabled === 'boolean') {
          draft.systemNotifications.taskbarAttentionEnabled = s.taskbarAttentionEnabled
        }
        if (s.taskbarAttentionMode === 'finite' || s.taskbarAttentionMode === 'untilFocused') {
          draft.systemNotifications.taskbarAttentionMode = s.taskbarAttentionMode
        }
        if (s.taskbarAttentionFlashCount !== undefined) {
          draft.systemNotifications.taskbarAttentionFlashCount = clampFlashCount(s.taskbarAttentionFlashCount)
        }
      }
      if (patch.thirdParty && typeof patch.thirdParty === 'object') {
        if (typeof patch.thirdParty.enabled === 'boolean') {
          draft.thirdParty.enabled = patch.thirdParty.enabled
        }
      }
      return { config: draft }
    })
  }

  async function toggleMountPoint({ mountPointId, enabled, expectedRevision }) {
    if (!getMountPoint(mountPointId)) {
      throw new ConfigStoreError('not-found', `Unknown mount point: ${mountPointId}`)
    }
    return enqueueWrite(expectedRevision, (draft) => {
      draft.mountPoints[mountPointId].enabled = Boolean(enabled)
      return { config: draft }
    })
  }

  async function toggleMountPointBell({ mountPointId, bellEnabled, expectedRevision }) {
    if (!getMountPoint(mountPointId)) {
      throw new ConfigStoreError('not-found', `Unknown mount point: ${mountPointId}`)
    }
    return enqueueWrite(expectedRevision, (draft) => {
      draft.mountPoints[mountPointId].bellEnabled = Boolean(bellEnabled)
      return { config: draft }
    })
  }

  async function toggleScript({ mountPointId, scriptId, enabled, expectedRevision }) {
    if (!getMountPoint(mountPointId)) {
      throw new ConfigStoreError('not-found', `Unknown mount point: ${mountPointId}`)
    }
    return enqueueWrite(expectedRevision, (draft) => {
      const target = draft.mountPoints[mountPointId].scripts.find((s) => s.id === scriptId)
      if (!target) {
        throw new ConfigStoreError('not-found', `Unknown script: ${scriptId}`)
      }
      target.enabled = Boolean(enabled)
      return { config: draft }
    })
  }

  async function updateScriptMeta({ mountPointId, scriptId, name, matcher, timeoutSeconds, enabled, expectedRevision }) {
    const mpDef = getMountPoint(mountPointId)
    if (!mpDef) {
      throw new ConfigStoreError('not-found', `Unknown mount point: ${mountPointId}`)
    }
    return enqueueWrite(expectedRevision, (draft) => {
      const target = draft.mountPoints[mountPointId].scripts.find((s) => s.id === scriptId)
      if (!target) {
        throw new ConfigStoreError('not-found', `Unknown script: ${scriptId}`)
      }
      if (typeof name === 'string') {
        const clean = name.replace(/[\x00-\x1f\x7f]/g, '').trim()
        if (!clean) throw new ConfigStoreError('invalid-config', 'Script name cannot be empty')
        target.name = clean.slice(0, 120)
      }
      if (matcher !== undefined) {
        if (!mpDef.supportsMatcher && String(matcher).trim() !== '') {
          throw new ConfigStoreError('invalid-config', `Mount point ${mountPointId} does not support matcher`)
        }
        target.matcher = String(matcher).trim().slice(0, 256)
      }
      if (timeoutSeconds !== undefined) {
        target.timeoutSeconds = clampTimeoutSeconds(timeoutSeconds)
      }
      if (typeof enabled === 'boolean') {
        target.enabled = enabled
      }
      return { config: draft, extra: { script: { ...target } } }
    })
  }

  async function addCustomScript({ mountPointId, scriptEntry, expectedRevision }) {
    if (!getMountPoint(mountPointId)) {
      throw new ConfigStoreError('not-found', `Unknown mount point: ${mountPointId}`)
    }
    return enqueueWrite(expectedRevision, (draft) => {
      draft.mountPoints[mountPointId].scripts.push(scriptEntry)
      return { config: draft, extra: { script: { ...scriptEntry } } }
    })
  }

  async function deleteScript({ mountPointId, scriptId, expectedRevision }) {
    if (!getMountPoint(mountPointId)) {
      throw new ConfigStoreError('not-found', `Unknown mount point: ${mountPointId}`)
    }
    let deletedFilename = null
    const res = await enqueueWrite(expectedRevision, (draft) => {
      const list = draft.mountPoints[mountPointId].scripts
      const idx = list.findIndex((s) => s.id === scriptId)
      if (idx === -1) {
        throw new ConfigStoreError('not-found', `Unknown script: ${scriptId}`)
      }
      const entry = list[idx]
      if (entry.kind !== 'custom') {
        throw new ConfigStoreError('cannot-delete-default', 'Default scripts cannot be deleted; disable them instead.')
      }
      deletedFilename = entry.filename
      list.splice(idx, 1)
      return { config: draft }
    })
    if (deletedFilename) {
      await deleteCustomScriptFile(getDataDir(), deletedFilename).catch(() => {})
    }
    return res
  }

  async function resetDefaultScripts({ expectedRevision } = {}) {
    await ensureDefaultScripts(getDataDir(), { overwrite: true })
    return enqueueWrite(expectedRevision, (draft) => {
      for (const mp of HOOK_MOUNT_POINTS) {
        const existingCustom = (draft.mountPoints[mp.id]?.scripts ?? []).filter((s) => s.kind === 'custom')
        draft.mountPoints[mp.id] = {
          enabled: draft.mountPoints[mp.id]?.enabled ?? Boolean(mp.defaultEnabled),
          bellEnabled: draft.mountPoints[mp.id]?.bellEnabled ?? Boolean(mp.defaultBell),
          scripts: [...buildDefaultScriptsForMountPoint(mp), ...existingCustom],
        }
      }
      return { config: draft }
    })
  }

  async function saveThirdPartyTarget({ target: rawTarget, expectedRevision }) {
    const inputTarget = rawTarget && typeof rawTarget === 'object' ? rawTarget : null
    if (!inputTarget) {
      throw new ConfigStoreError('bad-request', 'Missing target payload')
    }
    const provider = inputTarget.provider
    if (!PROVIDER_IDS.includes(provider)) {
      throw new ConfigStoreError('invalid-config', `Unsupported provider: ${provider}`)
    }
    const name = typeof inputTarget.name === 'string' ? inputTarget.name.trim().slice(0, 64) : ''
    if (!name) {
      throw new ConfigStoreError('invalid-config', 'Target name is required')
    }

    const secretKeys = getSecretFieldKeys(provider) ?? []
    const secretSet = new Set(secretKeys)

    return enqueueWrite(expectedRevision, (draft, draftSecrets) => {
      const targets = draft.thirdParty.targets
      const existingIdx = inputTarget.id ? targets.findIndex((t) => t.id === inputTarget.id) : -1
      const isNew = existingIdx === -1
      if (isNew && targets.length >= MAX_THIRD_PARTY_TARGETS) {
        throw new ConfigStoreError('target-limit', `Maximum ${MAX_THIRD_PARTY_TARGETS} third-party targets allowed`)
      }

      const targetId = isNew ? `tp_${randomUUID()}` : targets[existingIdx].id
      const prevSecrets =
        !isNew && targets[existingIdx].provider === provider ? (draftSecrets[targetId] ?? {}) : {}

      const cleanNonSecretConfig = {
        ...buildProviderDefaultConfig(provider),
      }
      const rawCfg = inputTarget.config && typeof inputTarget.config === 'object' ? inputTarget.config : {}
      for (const [k, v] of Object.entries(rawCfg)) {
        if (!secretSet.has(k) && v !== undefined) {
          cleanNonSecretConfig[k] = v
        }
      }

      const rawSecretsInput = inputTarget.secrets && typeof inputTarget.secrets === 'object' ? inputTarget.secrets : {}
      const nextTargetSecrets = {}
      for (const key of secretKeys) {
        const candidate = rawSecretsInput[key] !== undefined ? rawSecretsInput[key] : rawCfg[key]
        if (typeof candidate === 'string' && candidate.trim() !== '') {
          nextTargetSecrets[key] = candidate.trim()
        } else if (typeof prevSecrets[key] === 'string' && prevSecrets[key].length > 0) {
          nextTargetSecrets[key] = prevSecrets[key]
        }
      }

      const mergedForValidation = {
        ...cleanNonSecretConfig,
        ...nextTargetSecrets,
      }
      try {
        const check = validateProviderConfig(provider, mergedForValidation)
        if (check && check.valid === false) {
          throw new ConfigStoreError('invalid-config', check.message || check.error || 'Invalid provider configuration')
        }
      } catch (error) {
        if (error instanceof ConfigStoreError) throw error
        throw new ConfigStoreError('invalid-config', error?.message || 'Invalid provider configuration')
      }

      const savedRecord = {
        id: targetId,
        name,
        provider,
        enabled: typeof inputTarget.enabled === 'boolean' ? inputTarget.enabled : true,
        events: normalizeCategoryEvents(inputTarget.events),
        config: cleanNonSecretConfig,
      }

      if (isNew) {
        targets.push(savedRecord)
      } else {
        targets[existingIdx] = savedRecord
      }

      if (Object.keys(nextTargetSecrets).length > 0) {
        draftSecrets[targetId] = nextTargetSecrets
      } else {
        delete draftSecrets[targetId]
      }

      return {
        config: draft,
        secrets: draftSecrets,
        extra: { targetId },
      }
    })
  }

  async function toggleThirdPartyTarget({ targetId, enabled, expectedRevision }) {
    return enqueueWrite(expectedRevision, (draft) => {
      const target = draft.thirdParty.targets.find((t) => t.id === targetId)
      if (!target) {
        throw new ConfigStoreError('not-found', `Unknown third-party target: ${targetId}`)
      }
      target.enabled = Boolean(enabled)
      return { config: draft }
    })
  }

  async function deleteThirdPartyTarget({ targetId, expectedRevision }) {
    return enqueueWrite(expectedRevision, (draft, draftSecrets) => {
      const idx = draft.thirdParty.targets.findIndex((t) => t.id === targetId)
      if (idx === -1) {
        throw new ConfigStoreError('not-found', `Unknown third-party target: ${targetId}`)
      }
      draft.thirdParty.targets.splice(idx, 1)
      delete draftSecrets[targetId]
      return { config: draft, secrets: draftSecrets }
    })
  }

  async function setCustomSoundFilename({ filename, expectedRevision }) {
    return enqueueWrite(expectedRevision, (draft) => {
      draft.systemNotifications.customSoundFilename = filename ?? null
      return { config: draft }
    })
  }

  return {
    init,
    close,
    getSnapshot,
    getPublicConfig,
    getResolvedSecrets,
    saveSettings,
    toggleMountPoint,
    toggleMountPointBell,
    toggleScript,
    updateScriptMeta,
    addCustomScript,
    deleteScript,
    resetDefaultScripts,
    saveThirdPartyTarget,
    toggleThirdPartyTarget,
    deleteThirdPartyTarget,
    setCustomSoundFilename,
  }
}
