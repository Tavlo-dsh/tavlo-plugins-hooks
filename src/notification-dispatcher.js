/**
 * Redacts hook events and coordinates in-app SSE, OS system notifications,
 * custom WAV playback, Windows taskbar flashing, and async third-party dispatch.
 */

import { randomUUID } from 'node:crypto'
import { CATEGORY_META, getMountPoint } from './hook-catalog.js'
import { getCustomSoundInfo, getCustomSoundPath, playNativeSound } from './sound-manager.js'
import { clearTaskbarAttention, flashTaskbar, sendSystemNotification } from './system-notifier.js'
import { sendToProvider } from './third-party-providers.js'

export const QUEUE_CAPACITY = 64
export const MAX_CONCURRENCY = 4
export const MAX_THIRD_PARTY_TARGETS_PER_JOB = 20

const MAX_SUMMARY_CHARS = 160
const MAX_TITLE_CHARS = 200
const MAX_PROJECT_CHARS = 80

const WIN_DRIVE_PATH_RE = /[A-Za-z]:\\[^\s]+/g
const WIN_SLASH_PATH_RE = /[A-Za-z]:\/[^\s]+/g
const UNC_PATH_RE = /\\\\[^\s\\]+\\[^\s]+/g
const POSIX_ABS_PATH_RE = /\/(?:Users|home|tmp|var|etc|opt|mnt|root|private)\/[^\s]+/g

function truncateCodepoints(str, max) {
  const chars = Array.from(str)
  return chars.length <= max ? str : chars.slice(0, max).join('')
}

function stripPathsAndControlChars(raw) {
  if (typeof raw !== 'string') return ''
  return raw
    .replace(WIN_DRIVE_PATH_RE, '[path]')
    .replace(WIN_SLASH_PATH_RE, '[path]')
    .replace(UNC_PATH_RE, '[path]')
    .replace(POSIX_ABS_PATH_RE, '[path]')
    .replace(/[\r\n\t\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractSafeProjectName(hookEvent = {}) {
  const candidates = [hookEvent.projectName, hookEvent.project, hookEvent.cwd]
  for (const raw of candidates) {
    if (typeof raw !== 'string' || !raw.trim()) continue
    let val = raw.trim().replace(/[\\/]+$/, '')
    if (!val) continue
    if (val.includes('/') || val.includes('\\')) {
      const segments = val.split(/[\\/]+/).filter(Boolean)
      val = segments.length > 0 ? segments[segments.length - 1] : ''
    }
    if (!val || /^[A-Za-z]:$/.test(val)) continue
    const clean = stripPathsAndControlChars(val)
    if (clean && clean !== '[path]') {
      return truncateCodepoints(clean, MAX_PROJECT_CHARS)
    }
  }
  return 'DSH Workspace'
}

function formatLocalTimestamp(rawTimestamp) {
  let date = rawTimestamp ? new Date(rawTimestamp) : new Date()
  if (Number.isNaN(date.getTime())) {
    date = new Date()
  }
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

/**
 * Redact absolute filesystem paths, control chars, and raw tool/prompt content into
 * a safe, unified notification message payload.
 * @param {Record<string, unknown>} [hookEvent]
 */
export function formatRedactedMessage(hookEvent = {}) {
  const mountPointId = hookEvent.hookPoint || hookEvent.mountPointId
  const mpMeta = mountPointId ? getMountPoint(mountPointId) : undefined
  const rawCategory = hookEvent.category || hookEvent.event || mpMeta?.category || 'Notification'
  const meta = CATEGORY_META[rawCategory] || CATEGORY_META.Notification
  const event = CATEGORY_META[rawCategory] ? rawCategory : 'Notification'

  const icon = meta.icon
  const eventLabel = meta.labelZh
  const variant = meta.variant
  const project = extractSafeProjectName(hookEvent)
  const id = typeof hookEvent.id === 'string' && hookEvent.id.trim()
    ? hookEvent.id.trim()
    : typeof hookEvent.eventId === 'string' && hookEvent.eventId.trim()
      ? hookEvent.eventId.trim()
      : randomUUID()
  const localTime = formatLocalTimestamp(hookEvent.timestamp ?? hookEvent.time)

  const rawSummary =
    typeof hookEvent.summary === 'string' && hookEvent.summary.trim()
      ? hookEvent.summary
      : typeof hookEvent.reason === 'string' && hookEvent.reason.trim()
        ? hookEvent.reason
        : ''

  let safeSummary = truncateCodepoints(stripPathsAndControlChars(rawSummary), MAX_SUMMARY_CHARS)
  if (!safeSummary || safeSummary === '[path]') {
    safeSummary = truncateCodepoints(`${project} - ${eventLabel}`, MAX_SUMMARY_CHARS)
  }

  const title = `DSH ${icon} ${eventLabel}`
  const body = [
    `🏷️ 类型：${icon} ${eventLabel}`,
    '🧰 来源：DSH',
    `📁 项目：${project}`,
    `🕒 时间：${localTime}`,
    `🆔 通知：${id}`,
    `📌 内容：${safeSummary}`,
  ].join('\n')

  return {
    id,
    event,
    eventLabel,
    icon,
    source: 'DSH',
    project,
    time: localTime,
    title,
    body,
    summary: safeSummary,
    variant,
  }
}

/**
 * Create the multi-channel notification dispatcher.
 */
export function createNotificationDispatcher({
  getConfig,
  getResolvedSecrets,
  getDataDir,
  eventHub,
  logger,
  fetchImpl = globalThis.fetch,
  spawnImpl,
  platform = process.platform,
} = {}) {
  const queue = []
  const inFlight = new Set()
  const disposeController = new AbortController()
  let activeWorkers = 0
  let disposed = false

  async function resolveSecretsForTarget(targetId) {
    if (typeof getResolvedSecrets !== 'function' || !targetId) return {}
    try {
      const res = await getResolvedSecrets(targetId)
      if (!res || typeof res !== 'object') return {}
      if (res[targetId] && typeof res[targetId] === 'object' && !Array.isArray(res[targetId])) {
        return res[targetId]
      }
      return res
    } catch {
      return {}
    }
  }

  function scheduleQueueDrain() {
    if (disposed) return
    while (activeWorkers < MAX_CONCURRENCY && queue.length > 0) {
      const item = queue.shift()
      if (!item) break
      activeWorkers++
      const task = (async () => {
        try {
          const mergedConfig = {
            ...(item.target.config || {}),
            ...(item.secrets || {}),
          }
          const result = await sendToProvider(item.target.provider, mergedConfig, item.message, {
            fetchImpl,
            signal: disposeController.signal,
          })
          if (!result.accepted && !disposed) {
            logger?.warn?.(
              `tavlo-hooks: third-party delivery failed (${item.target.provider}/${item.target.id}): ${result.errorCode || 'rejected'} ${result.message}`,
            )
          }
        } catch (error) {
          if (!disposed) {
            logger?.warn?.(
              `tavlo-hooks: third-party delivery error (${item.target?.provider}/${item.target?.id}): ${error?.message || 'unknown'}`,
            )
          }
        } finally {
          activeWorkers--
          inFlight.delete(task)
          scheduleQueueDrain()
        }
      })()
      inFlight.add(task)
    }
  }

  async function enqueueThirdPartyBatch(message, targets) {
    if (disposed || targets.length === 0) return { queued: 0, dropped: 0 }
    let queued = 0
    let dropped = 0
    const boundedTargets = targets.slice(0, MAX_THIRD_PARTY_TARGETS_PER_JOB)
    for (const target of boundedTargets) {
      if (queue.length >= QUEUE_CAPACITY) {
        dropped++
        logger?.warn?.(
          `tavlo-hooks: third-party queue full (${QUEUE_CAPACITY}); dropping notification for ${target.provider}/${target.id}`,
        )
        continue
      }
      const secrets = await resolveSecretsForTarget(target.id)
      if (disposed) break
      queue.push({ target, secrets, message })
      queued++
    }
    scheduleQueueDrain()
    return { queued, dropped }
  }

  /**
   * Dispatch a hook event across in-app SSE, native sound, OS system notifications,
   * Windows taskbar flashing, and third-party webhook providers.
   */
  async function dispatch(hookEvent = {}, directive) {
    if (disposed) return { dispatched: false, reason: 'disposed' }
    if (directive?.suppress === true || directive?.notify === false) {
      return { dispatched: false, suppressed: true }
    }

    const enrichedEvent =
      typeof directive?.summary === 'string' && directive.summary.trim()
        ? { ...hookEvent, summary: directive.summary }
        : hookEvent

    const msg = formatRedactedMessage(enrichedEvent)
    if (typeof directive?.title === 'string' && directive.title.trim()) {
      const safeTitle = truncateCodepoints(stripPathsAndControlChars(directive.title), MAX_TITLE_CHARS)
      if (safeTitle && safeTitle !== '[path]') {
        msg.title = safeTitle
      }
    }

    const allowedChannels = Array.isArray(directive?.channels) ? new Set(directive.channels) : null
    const allowsChannel = (name) => !allowedChannels || allowedChannels.has(name)

    const config = (await getConfig?.()) || {}
    const dataDir = typeof getDataDir === 'function' ? getDataDir() : undefined
    const mountPointId = hookEvent.hookPoint || hookEvent.mountPointId
    const mpMeta = mountPointId ? getMountPoint(mountPointId) : undefined
    const mpCfg = mountPointId ? config?.mountPoints?.[mountPointId] : undefined

    const bellEnabled =
      mpCfg !== undefined
        ? Boolean(mpCfg.bellEnabled)
        : hookEvent.bellEnabled !== undefined
          ? Boolean(hookEvent.bellEnabled)
          : Boolean(mpMeta?.defaultBell ?? true)

    const connectedClients = eventHub?.getConnectedClientCount?.() ?? 0
    const hasFocusedVisible = Boolean(eventHub?.hasFocusedVisibleClient?.())
    const suppressWhenFocused = config?.systemNotifications?.suppressWhenFocused !== false
    const isFocusedSuppressed = suppressWhenFocused && hasFocusedVisible

    const customSoundInfo = dataDir ? await getCustomSoundInfo(dataDir) : null

    const shouldSendSystem = Boolean(
      config?.systemNotifications?.enabled &&
        bellEnabled &&
        !isFocusedSuppressed &&
        allowsChannel('system'),
    )

    let customSoundPlayed = false
    let systemResult = { ok: false, channel: 'none' }

    if (shouldSendSystem) {
      if (customSoundInfo && dataDir) {
        const soundRes = await playNativeSound(getCustomSoundPath(dataDir), { platform, spawnImpl })
        customSoundPlayed = Boolean(soundRes?.played)
        if (!customSoundPlayed) {
          logger?.warn?.(`tavlo-hooks: native WAV playback failed: ${soundRes?.reason || 'unknown'}`)
        }
      }
      const urgency =
        msg.event === 'PermissionRequest' || msg.event === 'StopFailure' ? 'critical' : 'normal'
      systemResult = await sendSystemNotification({
        title: msg.title,
        body: msg.body,
        urgency,
        silent: customSoundPlayed,
        platform,
        spawnImpl,
      })
      if (!systemResult.ok) {
        logger?.warn?.(
          `tavlo-hooks: system notification failed (${systemResult.channel}): ${systemResult.error || 'unknown'}`,
        )
      }
    }

    const shouldFlashTaskbar = Boolean(
      config?.systemNotifications?.taskbarAttentionEnabled &&
        bellEnabled &&
        !hasFocusedVisible &&
        allowsChannel('taskbar'),
    )

    let taskbarResult = { ok: true, skipped: true }
    if (shouldFlashTaskbar) {
      taskbarResult = await flashTaskbar({
        mode: config?.systemNotifications?.taskbarAttentionMode || 'finite',
        flashCount: config?.systemNotifications?.taskbarAttentionFlashCount ?? 5,
        platform,
        spawnImpl,
      })
    }

    const inAppEnabled = config?.inApp?.enabled !== false && allowsChannel('inApp')
    const playWebAudio = Boolean(shouldSendSystem && customSoundInfo && !customSoundPlayed && connectedClients > 0)
    const shouldWebNotify = Boolean(shouldSendSystem && !systemResult.ok && connectedClients > 0)

    if (inAppEnabled && typeof eventHub?.broadcast === 'function') {
      eventHub.broadcast('notification', {
        ...msg,
        category: msg.event,
        sessionId: hookEvent.sessionId,
        sessionTitle: hookEvent.sessionTitle,
        hookPoint: mountPointId,
        approvalId: hookEvent.approvalId,
        timestamp: hookEvent.timestamp || new Date().toISOString(),
        soundUrl: customSoundInfo ? '/api/tavlo-hooks/sound/current' : null,
        playWebAudio,
        shouldWebNotify,
        hostSystemNotified: Boolean(systemResult.ok),
        systemNotified: Boolean(systemResult.ok),
        autoCloseEnabled: config?.inApp?.autoCloseEnabled !== false,
        autoCloseSeconds: config?.inApp?.autoCloseSeconds ?? 60,
      })
    }

    let thirdPartySummary = { queued: 0, dropped: 0 }
    if (config?.thirdParty?.enabled && allowsChannel('thirdParty')) {
      const targets = Array.isArray(config.thirdParty.targets) ? config.thirdParty.targets : []
      const matching = targets.filter((t) => t && t.enabled && t.events?.[msg.event])
      if (matching.length > 0) {
        thirdPartySummary = await enqueueThirdPartyBatch(msg, matching)
      }
    }

    return {
      dispatched: true,
      id: msg.id,
      inAppBroadcast: inAppEnabled,
      systemNotification: systemResult,
      customSoundPlayed,
      taskbar: taskbarResult,
      thirdParty: thirdPartySummary,
    }
  }

  function dismissApproval(approvalId) {
    if (disposed || !approvalId) return
    eventHub?.broadcast?.('dismiss', { approvalId: String(approvalId) })
  }

  async function testThirdPartyTarget(target, resolvedSecrets, { signal } = {}) {
    const sampleMessage = formatRedactedMessage({
      event: 'Stop',
      projectName: 'demo-project',
      summary: '测试通知：Hook 通知通道连接正常',
    })

    let secretBag = {}
    if (resolvedSecrets && typeof resolvedSecrets === 'object') {
      if (
        target?.id &&
        resolvedSecrets[target.id] &&
        typeof resolvedSecrets[target.id] === 'object' &&
        !Array.isArray(resolvedSecrets[target.id])
      ) {
        secretBag = resolvedSecrets[target.id]
      } else {
        secretBag = resolvedSecrets
      }
    }

    const mergedConfig = {
      ...(target?.config || {}),
      ...secretBag,
    }

    const startedAt = Date.now()
    const result = await sendToProvider(target?.provider, mergedConfig, sampleMessage, {
      fetchImpl,
      signal,
    })
    return {
      ...result,
      provider: target?.provider,
      targetId: target?.id,
      elapsedMs: Math.max(0, Date.now() - startedAt),
    }
  }

  async function testSystemNotification() {
    const sample = formatRedactedMessage({
      event: 'Notification',
      projectName: 'DSH',
      summary: '系统通知与提示音测试',
    })
    const dataDir = typeof getDataDir === 'function' ? getDataDir() : undefined
    const customSoundInfo = dataDir ? await getCustomSoundInfo(dataDir) : null

    let soundPlayed = false
    if (customSoundInfo && dataDir) {
      const soundRes = await playNativeSound(getCustomSoundPath(dataDir), { platform, spawnImpl })
      soundPlayed = Boolean(soundRes?.played)
    }

    const sysRes = await sendSystemNotification({
      title: sample.title,
      body: sample.body,
      urgency: 'normal',
      silent: soundPlayed,
      platform,
      spawnImpl,
    })

    return {
      ok: sysRes.ok,
      channel: sysRes.channel,
      soundPlayed,
      ...(sysRes.error ? { error: sysRes.error } : {}),
    }
  }

  async function testTaskbarFlash(overrides = {}) {
    let config = {}
    try {
      config = (await getConfig?.()) || {}
    } catch {
      config = {}
    }
    const mode = overrides?.mode ?? config?.systemNotifications?.taskbarAttentionMode ?? 'finite'
    const flashCount = overrides?.flashCount ?? config?.systemNotifications?.taskbarAttentionFlashCount ?? 5
    return flashTaskbar({
      mode,
      flashCount,
      targetPid: overrides?.targetPid,
      windowTitleHint: overrides?.windowTitleHint,
      platform,
      spawnImpl,
    })
  }

  async function clearAttention(overrides = {}) {
    return clearTaskbarAttention({
      targetPid: overrides?.targetPid,
      windowTitleHint: overrides?.windowTitleHint,
      platform,
      spawnImpl,
    })
  }

  async function dispose() {
    disposed = true
    queue.length = 0
    disposeController.abort()
    await Promise.allSettled([...inFlight])
  }

  return {
    dispatch,
    dismissApproval,
    testThirdPartyTarget,
    testSystemNotification,
    testTaskbarFlash,
    clearTaskbarAttention: clearAttention,
    dispose,
  }
}
