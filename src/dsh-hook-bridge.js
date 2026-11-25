/**
 * Bridge connecting DSH 0.2.2-rc.1 Cordis events & session events to all 19 hook mount points.
 * Waterfall listeners (`approval/request`, `user-questions/request`, `tools/pre-execute`) use
 * `{ prepend: true }`, run side effects asynchronously, and immediately call `next()`.
 */

import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { getMountPoint } from './hook-catalog.js'
import { matchesScriptMatcher } from './script-runner.js'

const DEDUP_TTL_MS = 5000
const MAX_SESSION_META = 500
const DEFAULT_TURN_COMPLETE_DEBOUNCE_MS = 1200

function safeBasename(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return ''
  const cleaned = rawPath.trim().replace(/[\\/]+$/, '')
  if (!cleaned) return ''
  return path.win32.basename(cleaned) || path.posix.basename(cleaned) || ''
}

function sanitizeSummaryText(raw, maxLen = 160) {
  if (typeof raw !== 'string') return ''
  return raw.replace(/[\r\n\t\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLen)
}

function isSubagentSession(session) {
  if (!session || typeof session !== 'object') return false
  const header = session.header
  if (!header || typeof header !== 'object') return false
  if (header.origin === 'subagent') return true
  if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) return true
  return false
}

/**
 * Create the DSH event bridge.
 */
export function createDshHookBridge({
  ctx,
  configStore,
  scriptRunner,
  dispatcher,
  logger,
  now = Date.now,
  turnCompleteDebounceMs = DEFAULT_TURN_COMPLETE_DEBOUNCE_MS,
} = {}) {
  const sessionMeta = new Map()
  const recentKeys = new Map()
  const approvalCallIds = new Map()
  const subagentSessionIds = new Set()
  const activeSubagentsByParent = new Map()
  const pendingTurnCompleted = new Map()
  const disposers = []
  let jobsServiceSubscribed = false
  let disposed = false

  function resolveLiveAgent(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return undefined
    try {
      return ctx?.get?.('agents')?.get?.(sessionId)
    } catch {
      return undefined
    }
  }

  function resolveLiveSession(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return undefined
    const agent = resolveLiveAgent(sessionId)
    if (agent?.session) return agent.session
    try {
      return ctx?.get?.('sessions')?.get?.(sessionId)
    } catch {
      return undefined
    }
  }

  function isSubagentById(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return false
    if (subagentSessionIds.has(sessionId)) return true
    const session = resolveLiveSession(sessionId)
    if (isSubagentSession(session)) {
      subagentSessionIds.add(sessionId)
      return true
    }
    return false
  }

  function getLiveGoal(agent) {
    if (!agent) return undefined
    try {
      return ctx?.get?.('goals')?.get?.(agent)
    } catch {
      return undefined
    }
  }

  function willAutoContinueGoal(agent) {
    const goal = getLiveGoal(agent)
    if (!goal || goal.phase !== 'active' || goal.activation !== 'armed') return false
    if (typeof goal.maxGoalRounds === 'number' && typeof goal.roundsStarted === 'number') {
      return goal.roundsStarted < goal.maxGoalRounds
    }
    return true
  }

  function getTurnContinueReason(sessionId, session) {
    if (isSubagentSession(session) || isSubagentById(sessionId)) return 'subagent'
    const agent = resolveLiveAgent(sessionId)
    if (agent?.inbox?.hasPending) return 'inbox-pending'
    if (willAutoContinueGoal(agent)) return 'goal-armed'
    if (sessionId && (activeSubagentsByParent.get(sessionId)?.size ?? 0) > 0) return 'subagent-active'
    return null
  }

  function recordDiagnostic(kind, payload) {
    try {
      scriptRunner?.recordTriggerLog?.({
        kind,
        ...payload,
      })
    } catch {
      // Never let diagnostics break event flow
    }
  }

  function cancelPendingTurnCompleted(sessionId, cancelReason) {
    if (typeof sessionId !== 'string' || !sessionId) return
    const pending = pendingTurnCompleted.get(sessionId)
    if (!pending) return
    clearTimeout(pending.timer)
    pendingTurnCompleted.delete(sessionId)
    if (cancelReason && cancelReason !== 'dispose') {
      recordDiagnostic('skip', {
        mountPointId: 'turn.completed',
        sessionId,
        turn: pending.turn ?? null,
        reason: cancelReason,
        summary: `Cancelled debounced turn.completed (${cancelReason})`,
      })
    }
  }

  function rememberSessionMeta(sessionId, { cwd, title } = {}) {
    if (typeof sessionId !== 'string' || !sessionId) return
    const prev = sessionMeta.get(sessionId) ?? {}
    sessionMeta.set(sessionId, {
      cwd: cwd ?? prev.cwd,
      title: title ?? prev.title,
      updatedAt: now(),
    })
    if (sessionMeta.size > MAX_SESSION_META) {
      const oldestKey = sessionMeta.keys().next().value
      if (oldestKey) sessionMeta.delete(oldestKey)
    }
  }

  function resolveSessionLabels(sessionId, fallbackCwd) {
    const cached = sessionId ? sessionMeta.get(sessionId) : undefined
    const cwd = fallbackCwd || cached?.cwd
    let projectName = safeBasename(cwd)
    if (!projectName && sessionId) {
      try {
        const workspaces = ctx?.get?.('workspaceRegistry')?.list?.() ?? []
        const matched = workspaces.find(
          (ws) => Array.isArray(ws?.sessionIds) && ws.sessionIds.includes(sessionId),
        )
        projectName = sanitizeSummaryText(matched?.title, 64) || safeBasename(matched?.path)
      } catch {
        // Ignore unavailable workspace registry
      }
    }
    return {
      sessionTitle: cached?.title ? sanitizeSummaryText(cached.title, 80) : undefined,
      projectName: projectName || 'DSH Workspace',
    }
  }

  function claimDedup(key) {
    if (!key) return true
    const current = now()
    for (const [k, expiresAt] of recentKeys) {
      if (expiresAt <= current) recentKeys.delete(k)
    }
    const existing = recentKeys.get(key)
    if (existing && existing > current) {
      return false
    }
    recentKeys.set(key, current + DEDUP_TTL_MS)
    return true
  }

  async function runMountScripts(mountPointId, mpConfig, hookEvent, { dryRun = false } = {}) {
    const mpDef = getMountPoint(mountPointId)
    const scripts = Array.isArray(mpConfig?.scripts) ? mpConfig.scripts : []
    const eligible = scripts.filter(
      (script) =>
        script.enabled &&
        (!mpDef?.supportsMatcher || matchesScriptMatcher(script.matcher, hookEvent)),
    )
    if (eligible.length === 0) {
      return { suppressed: false, directive: null, scriptsRun: 0, logs: [] }
    }

    const results = await Promise.allSettled(
      eligible.map((script) => scriptRunner.executeScript(script, hookEvent, { dryRun })),
    )

    let suppressed = false
    let mergedDirective = null
    const logs = []

    for (const res of results) {
      if (res.status !== 'fulfilled' || !res.value) continue
      const entry = res.value
      logs.push(entry)
      if (entry.suppressed) suppressed = true
      if (entry.directive && typeof entry.directive === 'object') {
        mergedDirective = { ...(mergedDirective ?? {}), ...entry.directive }
      }
    }

    return { suppressed, directive: mergedDirective, scriptsRun: eligible.length, logs }
  }

  async function triggerMountPoint(mountPointId, context = {}, { force = false } = {}) {
    if (disposed) return { skipped: true, reason: 'disposed' }
    const mpDef = getMountPoint(mountPointId)
    if (!mpDef) return { skipped: true, reason: 'unknown-mount-point' }

    const { config } = configStore.getSnapshot()
    const mpConfig = config.mountPoints?.[mountPointId]
    if (!force && !mpConfig?.enabled) {
      return { skipped: true, reason: 'disabled' }
    }

    const sessionId = typeof context.sessionId === 'string' ? context.sessionId : undefined
    const labels = resolveSessionLabels(sessionId, context.cwd)
    const eventId = context.eventId || randomUUID()
    const timestamp = new Date(now()).toISOString()
    const turn = typeof context.turn === 'number' && Number.isFinite(context.turn) ? context.turn : undefined

    const hookEvent = {
      eventId,
      hookPoint: mountPointId,
      category: mpDef.category,
      timestamp,
      sessionId,
      sessionTitle: context.sessionTitle || labels.sessionTitle,
      projectName: context.projectName || labels.projectName,
      summary: sanitizeSummaryText(context.summary) || (mpDef.nameZh ?? mpDef.nameEn),
      toolName: context.toolName ? sanitizeSummaryText(context.toolName, 80) : undefined,
      reason: context.reason ? sanitizeSummaryText(context.reason, 160) : undefined,
      approvalId: context.approvalId ? String(context.approvalId) : undefined,
      bellEnabled: Boolean(mpConfig?.bellEnabled ?? mpDef.defaultBell),
      ...(turn !== undefined ? { turn } : {}),
    }

    const startedAt = now()
    const scriptOutcome = await runMountScripts(mountPointId, mpConfig, hookEvent, { dryRun: force })
    if (scriptOutcome.suppressed && !force) {
      recordDiagnostic('trigger', {
        mountPointId,
        sessionId: sessionId ?? null,
        turn: turn ?? null,
        reason: hookEvent.reason ?? null,
        summary: hookEvent.summary,
        suppressed: true,
        scriptsRun: scriptOutcome.scriptsRun,
        dispatched: false,
      })
      return {
        skipped: true,
        reason: 'suppressed',
        suppressed: true,
        eventId,
        elapsedMs: Math.max(0, now() - startedAt),
      }
    }

    let dispatchResult = null
    if (!scriptOutcome.suppressed) {
      dispatchResult = await dispatcher.dispatch(hookEvent, scriptOutcome.directive ?? undefined)
    }

    recordDiagnostic('trigger', {
      mountPointId,
      sessionId: sessionId ?? null,
      turn: turn ?? null,
      reason: hookEvent.reason ?? null,
      summary: hookEvent.summary,
      suppressed: scriptOutcome.suppressed,
      scriptsRun: scriptOutcome.scriptsRun,
      dispatched: Boolean(dispatchResult?.dispatched),
      ...(context.goalPhase ? { goalPhase: context.goalPhase } : {}),
    })

    return {
      ok: true,
      eventId,
      mountPointId,
      suppressed: scriptOutcome.suppressed,
      scriptsRun: scriptOutcome.scriptsRun,
      elapsedMs: Math.max(0, now() - startedAt),
      dispatch: dispatchResult,
      logs: scriptRunner.getLogs(),
    }
  }

  function safeAsync(label, fn) {
    if (disposed) return
    void Promise.resolve()
      .then(fn)
      .catch((error) => {
        logger?.warn?.(`tavlo-hooks: ${label} error: ${error?.message || error}`)
      })
  }

  function listen(eventName, handler, options = { global: true }) {
    if (!ctx?.on) return
    const dispose = ctx.on(eventName, handler, options)
    if (typeof dispose === 'function') disposers.push(dispose)
  }

  function attachJobsService(jobsService) {
    if (typeof jobsService?.events?.subscribe !== 'function') return null
    if (jobsServiceSubscribed) return null
    jobsServiceSubscribed = true
    const unsub = jobsService.events.subscribe({ owners: 'all' }, (jobEvent) => {
      if (disposed || !jobEvent || jobEvent.type !== 'settled') return
      if (jobEvent.awaited === true || jobEvent.cause === 'teardown') return
      const job = jobEvent.job
      const ownerId = typeof job?.owner === 'string' && job.owner ? job.owner : undefined
      if (ownerId && isSubagentById(ownerId)) return
      const jobId = job?.id ? String(job.id) : undefined
      if (jobId && !claimDedup(`job-settled:${jobId}`)) return
      const status = job?.status || 'completed'
      const label = job?.label ? sanitizeSummaryText(job.label, 64) : '后台任务'
      const ownerSession = ownerId ? resolveLiveSession(ownerId) : undefined
      safeAsync('jobs:settled', async () => {
        await triggerMountPoint('job.settled', {
          sessionId: ownerId,
          cwd: ownerSession?.header?.cwd,
          reason: status,
          summary: `后台任务「${label}」已结束 (${status})`,
        })
      })
    })
    return () => {
      jobsServiceSubscribed = false
      try {
        unsub?.()
      } catch {
        // ignore unsubscribe errors
      }
    }
  }

  function mount() {
    if (!ctx?.on) return dispose

    if (typeof ctx?.inject === 'function') {
      const jobsFork = ctx.inject(['jobs'], (childCtx) => {
        const cleanup = attachJobsService(childCtx?.jobs)
        if (cleanup) childCtx.effect(() => cleanup, 'tavlo-hooks: jobs events')
      })
      if (typeof jobsFork?.dispose === 'function') {
        disposers.push(() => {
          jobsServiceSubscribed = false
          return jobsFork.dispose()
        })
      }
    } else {
      const jobsCleanup = attachJobsService(ctx?.get?.('jobs'))
      if (jobsCleanup) disposers.push(jobsCleanup)
    }

    listen('agent/status', ({ agent, status } = {}) => {
      if (status === 'running') {
        const sid = agent?.id ?? agent?.session?.id
        if (sid) cancelPendingTurnCompleted(sid, 'agent-running')
      }
    })

    // 1. Waterfall listeners: MUST prepend, run side effects async, and IMMEDIATELY return next()
    listen(
      'approval/request',
      (req, next) => {
        try {
          safeAsync('approval/request', async () => {
            const session = req?.agent?.session
            const sessionId = session?.id
            const callId = req?.callId ? String(req.callId) : undefined
            const toolName = req?.toolName ? String(req.toolName) : 'tool'
            const dedupKey = callId ? `approval:${callId}` : undefined
            if (!claimDedup(dedupKey)) return
            rememberSessionMeta(sessionId, { cwd: session?.header?.cwd })
            const reasonText =
              req?.displayReason?.zh || req?.displayReason?.en || req?.reason || ''
            const summary = reasonText
              ? `${toolName}: ${reasonText}`
              : `工具 ${toolName} 需要您的审批`
            if (req?.signal && callId) {
              req.signal.addEventListener(
                'abort',
                () => {
                  dispatcher.dismissApproval?.(callId)
                },
                { once: true },
              )
            }
            await triggerMountPoint('approval.request', {
              sessionId,
              cwd: session?.header?.cwd,
              toolName,
              reason: reasonText,
              approvalId: callId,
              summary,
            })
          })
        } catch {
          // Never block approval waterfall
        }
        return next()
      },
      { prepend: true, global: true },
    )

    listen(
      'user-questions/request',
      (request, next) => {
        try {
          safeAsync('user-questions/request', async () => {
            const session = request?.agent?.session
            const sessionId = session?.id
            const callId = request?.wait?.callId ? String(request.wait.callId) : undefined
            rememberSessionMeta(sessionId, { cwd: session?.header?.cwd })
            const firstQuestion = Array.isArray(request?.questions) ? request.questions[0] : null
            const qText = firstQuestion?.header || firstQuestion?.question || 'Agent 需要您的确认或输入'
            if (request?.signal && callId) {
              request.signal.addEventListener(
                'abort',
                () => {
                  dispatcher.dismissApproval?.(callId)
                },
                { once: true },
              )
            }
            await triggerMountPoint('user.question', {
              sessionId,
              cwd: session?.header?.cwd,
              approvalId: callId,
              summary: qText,
            })
          })
        } catch {
          // Never block user-questions waterfall
        }
        return next()
      },
      { prepend: true, global: true },
    )

    listen(
      'tools/pre-execute',
      (exec, next) => {
        try {
          safeAsync('tools/pre-execute', async () => {
            const session = exec?.agent?.session
            const sessionId = session?.id
            const toolName = exec?.name ? String(exec.name) : 'tool'
            rememberSessionMeta(sessionId, { cwd: session?.header?.cwd })
            await triggerMountPoint('tool.pre', {
              sessionId,
              cwd: session?.header?.cwd,
              toolName,
              summary: `准备执行工具 ${toolName}`,
            })
          })
        } catch {
          // Never block tools/pre-execute waterfall
        }
        return next()
      },
      { prepend: true, global: true },
    )

    // 2. Tool results
    listen('tools/result', (exec, result) => {
      safeAsync('tools/result', async () => {
        const session = exec?.agent?.session
        const sessionId = session?.id
        const toolName = exec?.name ? String(exec.name) : 'tool'
        rememberSessionMeta(sessionId, { cwd: session?.header?.cwd })
        if (result?.isError) {
          const errCode = result?.error?.info?.code || 'tool-error'
          await triggerMountPoint('tool.failure', {
            sessionId,
            cwd: session?.header?.cwd,
            toolName,
            reason: errCode,
            summary: `工具 ${toolName} 执行失败 (${errCode})`,
          })
        } else {
          await triggerMountPoint('tool.post', {
            sessionId,
            cwd: session?.header?.cwd,
            toolName,
            summary: `工具 ${toolName} 执行完成`,
          })
        }
      })
    })

    // 3. Session & Agent lifecycle
    listen('session/created', (session) => {
      try {
        const sessionId = session?.id
        if (isSubagentSession(session)) {
          if (sessionId) subagentSessionIds.add(sessionId)
          return
        }
        safeAsync('session/created', async () => {
          rememberSessionMeta(sessionId, { cwd: session?.header?.cwd })
          if (!claimDedup(sessionId ? `session-start:${sessionId}` : undefined)) return
          await triggerMountPoint('session.start', {
            sessionId,
            cwd: session?.header?.cwd,
            summary: '新会话已创建',
          })
        })
      } catch {
        // Sync throw vetoes session creation; never throw here
      }
    })

    listen('agent/created', ({ agent, source } = {}) => {
      const session = agent?.session
      const sessionId = session?.id
      if (isSubagentSession(session)) {
        if (sessionId) subagentSessionIds.add(sessionId)
        return
      }
      safeAsync('agent/created', async () => {
        rememberSessionMeta(sessionId, { cwd: session?.header?.cwd })
        if (!claimDedup(sessionId ? `session-start:${sessionId}` : undefined)) return
        await triggerMountPoint('session.start', {
          sessionId,
          cwd: session?.header?.cwd,
          reason: source,
          summary: source ? `会话已启动 (${source})` : '会话已启动',
        })
      })
    })

    listen('session/disposed', (session) => {
      const sessionId = session?.id
      const wasSubagent = isSubagentSession(session) || isSubagentById(sessionId)
      if (sessionId) {
        cancelPendingTurnCompleted(sessionId, 'session-disposed')
        activeSubagentsByParent.delete(sessionId)
        subagentSessionIds.delete(sessionId)
      }
      if (wasSubagent) {
        if (sessionId) sessionMeta.delete(sessionId)
        return
      }
      safeAsync('session/disposed', async () => {
        if (!claimDedup(sessionId ? `session-end:${sessionId}` : undefined)) return
        await triggerMountPoint('session.end', {
          sessionId,
          cwd: session?.header?.cwd,
          summary: '会话已结束',
        })
        if (sessionId) sessionMeta.delete(sessionId)
      })
    })

    listen('agent/disposed', ({ agent } = {}) => {
      const session = agent?.session
      const sessionId = session?.id
      const wasSubagent = isSubagentSession(session) || isSubagentById(sessionId)
      if (sessionId) {
        cancelPendingTurnCompleted(sessionId, 'session-disposed')
        activeSubagentsByParent.delete(sessionId)
        subagentSessionIds.delete(sessionId)
      }
      if (wasSubagent) {
        if (sessionId) sessionMeta.delete(sessionId)
        return
      }
      safeAsync('agent/disposed', async () => {
        if (!claimDedup(sessionId ? `session-end:${sessionId}` : undefined)) return
        await triggerMountPoint('session.end', {
          sessionId,
          cwd: session?.header?.cwd,
          summary: 'Agent 已释放',
        })
        if (sessionId) sessionMeta.delete(sessionId)
      })
    })

    listen('agent/error', ({ agent, turn, error } = {}) => {
      const session = agent?.session
      const sessionId = session?.id
      if (isSubagentSession(session) || isSubagentById(sessionId)) return
      safeAsync('agent/error', async () => {
        rememberSessionMeta(sessionId, { cwd: session?.header?.cwd })
        if (!claimDedup(sessionId ? `turn-failed:${sessionId}:${turn ?? ''}` : undefined)) return
        const code = error?.code || error?.name || 'agent-error'
        await triggerMountPoint('turn.failed', {
          sessionId,
          cwd: session?.header?.cwd,
          turn: typeof turn === 'number' ? turn : undefined,
          reason: String(code),
          summary: `执行出错 (${code})`,
        })
      })
    })

    listen('agent-loop/config-start-failed', ({ sessionId, error } = {}) => {
      safeAsync('agent-loop/config-start-failed', async () => {
        const code = error?.code || error?.name || 'config-start-failed'
        await triggerMountPoint('turn.failed', {
          sessionId,
          reason: String(code),
          summary: `会话启动配置失败 (${code})`,
        })
      })
    })

    // 4. Session event stream (turn/start, turn/end, approval/*, job/settled, compaction/end, session/title)
    listen('session/event', (session, event) => {
      const sessionId = session?.id
      if (!event || typeof event !== 'object') return

      const subagent = isSubagentSession(session) || isSubagentById(sessionId)
      if (subagent && sessionId) subagentSessionIds.add(sessionId)

      if (event.type === 'turn/start' && !subagent && sessionId) {
        cancelPendingTurnCompleted(sessionId, 'next-turn-started')
      }

      safeAsync('session/event', async () => {
        rememberSessionMeta(sessionId, { cwd: session?.header?.cwd })

        if (event.type === 'session/title' && typeof event.data?.title === 'string') {
          rememberSessionMeta(sessionId, { title: event.data.title })
          return
        }

        if (event.type === 'approval/asked') {
          const approvalId = event.data?.id ? String(event.data.id) : undefined
          const callId = event.data?.callId ? String(event.data.callId) : undefined
          if (approvalId && callId) approvalCallIds.set(approvalId, callId)
          if (callId && !claimDedup(`approval:${callId}`)) return
          const toolName = event.data?.toolName ? String(event.data.toolName) : 'tool'
          await triggerMountPoint('approval.request', {
            sessionId,
            cwd: session?.header?.cwd,
            toolName,
            reason: event.data?.reason,
            approvalId: approvalId ?? callId,
            summary: event.data?.reason ? `${toolName}: ${event.data.reason}` : `工具 ${toolName} 等待审批`,
          })
          return
        }

        if (event.type === 'approval/decided') {
          const approvalId = event.data?.id ? String(event.data.id) : undefined
          if (approvalId) {
            dispatcher.dismissApproval?.(approvalId)
            const mappedCallId = approvalCallIds.get(approvalId)
            if (mappedCallId) {
              approvalCallIds.delete(approvalId)
              dispatcher.dismissApproval?.(mappedCallId)
            }
          }
          return
        }

        if (subagent) return

        if (event.type === 'turn/start') {
          await triggerMountPoint('turn.start', {
            sessionId,
            cwd: session?.header?.cwd,
            turn: typeof event.data?.turn === 'number' ? event.data.turn : undefined,
            summary: `第 ${event.data?.turn ?? ''} 轮开始执行`.trim(),
          })
          return
        }

        if (event.type === 'turn/end') {
          const turn = typeof event.data?.turn === 'number' ? event.data.turn : undefined
          const kind = event.data?.reason?.kind
          if (kind === 'completed') {
            const skipReason = getTurnContinueReason(sessionId, session)
            if (skipReason) {
              recordDiagnostic('skip', {
                mountPointId: 'turn.completed',
                sessionId: sessionId ?? null,
                turn: turn ?? null,
                reason: skipReason,
                summary: `Skipped turn.completed (${skipReason})`,
              })
              return
            }

            const cwd = session?.header?.cwd
            const fireCompleted = async () => {
              if (disposed) return
              const liveAgent = resolveLiveAgent(sessionId)
              if (liveAgent?.status === 'running') {
                recordDiagnostic('skip', {
                  mountPointId: 'turn.completed',
                  sessionId: sessionId ?? null,
                  turn: turn ?? null,
                  reason: 'agent-running',
                  summary: 'Skipped turn.completed (agent-running)',
                })
                return
              }
              const lateSkip = getTurnContinueReason(sessionId, session)
              if (lateSkip) {
                recordDiagnostic('skip', {
                  mountPointId: 'turn.completed',
                  sessionId: sessionId ?? null,
                  turn: turn ?? null,
                  reason: lateSkip,
                  summary: `Skipped turn.completed (${lateSkip})`,
                })
                return
              }
              const goal = getLiveGoal(liveAgent)
              await triggerMountPoint('turn.completed', {
                sessionId,
                cwd,
                turn,
                goalPhase: goal?.phase,
                reason: goal?.phase === 'complete' ? 'goal-completed' : 'completed',
                summary: goal?.phase === 'complete' ? '目标任务已完成' : '当前回合已完成',
              })
            }

            if (sessionId && turnCompleteDebounceMs > 0) {
              cancelPendingTurnCompleted(sessionId, 'superseded')
              const timer = setTimeout(() => {
                pendingTurnCompleted.delete(sessionId)
                safeAsync('turn/end:debounced', fireCompleted)
              }, turnCompleteDebounceMs)
              timer.unref?.()
              pendingTurnCompleted.set(sessionId, { timer, turn })
            } else {
              await fireCompleted()
            }
          } else if (kind === 'error') {
            if (sessionId) cancelPendingTurnCompleted(sessionId, 'turn-error')
            if (!claimDedup(sessionId ? `turn-failed:${sessionId}:${event.data?.turn ?? ''}` : undefined)) return
            const errCode = event.data?.reason?.error?.code || 'error'
            await triggerMountPoint('turn.failed', {
              sessionId,
              cwd: session?.header?.cwd,
              turn,
              reason: String(errCode),
              summary: `回合执行失败 (${errCode})`,
            })
          } else if (kind === 'blocked' || kind === 'max-tokens' || kind === 'aborted' || kind === 'interrupted') {
            if (sessionId) cancelPendingTurnCompleted(sessionId, `turn-${kind}`)
            await triggerMountPoint('turn.attention', {
              sessionId,
              cwd: session?.header?.cwd,
              turn,
              reason: kind,
              summary: `回合因 ${kind} 暂停，请查看`,
            })
          }
          return
        }

        if (event.type === 'job/settled') {
          if (jobsServiceSubscribed) return
          if (event.data?.awaited === true || event.data?.cause === 'teardown') return
          const jobId = event.data?.jobId ? String(event.data.jobId) : undefined
          if (jobId && !claimDedup(`job-settled:${jobId}`)) return
          const status = event.data?.status || 'completed'
          const label = event.data?.label ? sanitizeSummaryText(event.data.label, 64) : '后台任务'
          await triggerMountPoint('job.settled', {
            sessionId,
            cwd: session?.header?.cwd,
            reason: status,
            summary: `后台任务「${label}」已结束 (${status})`,
          })
          return
        }

        if (event.type === 'compaction/end') {
          const hasError = Boolean(event.data?.error)
          await triggerMountPoint('compaction.end', {
            sessionId,
            cwd: session?.header?.cwd,
            reason: hasError ? 'error' : 'completed',
            summary: hasError ? '上下文压缩出现异常' : '上下文压缩已完成',
          })
        }
      })
    })

    // 5. Subsystems: subagent, workflow, goal, account
    listen('subagent/start', (info) => {
      if (typeof info?.id === 'string' && info.id) {
        subagentSessionIds.add(info.id)
      }
      const parentId = typeof info?.parentSessionId === 'string' && info.parentSessionId ? info.parentSessionId : undefined
      const childKey = typeof info?.runId === 'string' && info.runId
        ? info.runId
        : typeof info?.id === 'string' && info.id
          ? info.id
          : undefined
      if (parentId && childKey) {
        let activeSet = activeSubagentsByParent.get(parentId)
        if (!activeSet) {
          activeSet = new Set()
          activeSubagentsByParent.set(parentId, activeSet)
        }
        activeSet.add(childKey)
      }
      safeAsync('subagent/start', async () => {
        await triggerMountPoint('subagent.start', {
          sessionId: parentId,
          summary: '子 Agent 已启动',
        })
      })
    })

    listen('subagent/end', (info) => {
      const parentId = typeof info?.parentSessionId === 'string' && info.parentSessionId ? info.parentSessionId : undefined
      const childKey = typeof info?.runId === 'string' && info.runId
        ? info.runId
        : typeof info?.id === 'string' && info.id
          ? info.id
          : undefined
      if (parentId && childKey) {
        const activeSet = activeSubagentsByParent.get(parentId)
        if (activeSet) {
          activeSet.delete(childKey)
          if (activeSet.size === 0) activeSubagentsByParent.delete(parentId)
        }
      }
      safeAsync('subagent/end', async () => {
        await triggerMountPoint('subagent.end', {
          sessionId: parentId,
          reason: info?.stopReason,
          summary: info?.stopReason ? `子 Agent 已结束 (${info.stopReason})` : '子 Agent 已完成',
        })
      })
    })

    listen('workflow/start', (info) => {
      safeAsync('workflow/start', async () => {
        const wfName = info?.meta?.name ? sanitizeSummaryText(info.meta.name, 64) : ''
        await triggerMountPoint('workflow.start', {
          summary: wfName ? `工作流 ${wfName} 已启动` : '工作流已启动',
        })
      })
    })

    listen('workflow/end', (info, result) => {
      safeAsync('workflow/end', async () => {
        const wfName = info?.meta?.name ? sanitizeSummaryText(info.meta.name, 64) : ''
        const reason = result?.stopReason || 'completed'
        await triggerMountPoint('workflow.end', {
          reason,
          summary: wfName ? `工作流 ${wfName} 已结束 (${reason})` : `工作流已结束 (${reason})`,
        })
      })
    })

    listen('goal/changed', ({ agent } = {}) => {
      safeAsync('goal/changed', async () => {
        const session = agent?.session
        await triggerMountPoint('goal.changed', {
          sessionId: session?.id,
          cwd: session?.header?.cwd,
          summary: '目标状态已变更',
        })
      })
    })

    listen('goal/activation-changed', (payload) => {
      safeAsync('goal/activation-changed', async () => {
        await triggerMountPoint('goal.changed', {
          sessionId: payload?.sessionId,
          summary: '目标激活状态已变更',
        })
      })
    })

    listen('deepseek-account/session-expired', () => {
      safeAsync('deepseek-account/session-expired', async () => {
        await triggerMountPoint('account.attention', {
          reason: 'session-expired',
          summary: 'DeepSeek 账号会话已过期，请重新登录',
        })
      })
    })

    const onModelSignIn = () => {
      safeAsync('deepseek-account/model-sign-in-required', async () => {
        await triggerMountPoint('account.attention', {
          reason: 'model-sign-in-required',
          summary: '当前模型需要账号登录后继续使用',
        })
      })
    }
    listen('deepseek-account/model-sign-in-required', onModelSignIn)
    listen('model-sign-in-required', onModelSignIn)

    return dispose
  }

  function dispose() {
    disposed = true
    jobsServiceSubscribed = false
    for (const pending of pendingTurnCompleted.values()) {
      clearTimeout(pending.timer)
    }
    pendingTurnCompleted.clear()
    while (disposers.length > 0) {
      const fn = disposers.pop()
      try {
        fn?.()
      } catch {
        // ignore disposer errors
      }
    }
    sessionMeta.clear()
    recentKeys.clear()
    approvalCallIds.clear()
    subagentSessionIds.clear()
    activeSubagentsByParent.clear()
  }

  async function testMountPoint(mountPointId) {
    const mpDef = getMountPoint(mountPointId)
    if (!mpDef) {
      throw new Error(`Unknown mount point: ${mountPointId}`)
    }
    return triggerMountPoint(
      mountPointId,
      {
        projectName: 'demo-project',
        toolName: mpDef.supportsMatcher ? 'bash' : undefined,
        reason: 'test-trigger',
        summary: `测试触发挂载点：${mpDef.nameZh}`,
      },
      { force: true },
    )
  }

  async function testScript(mountPointId, scriptId) {
    const mpDef = getMountPoint(mountPointId)
    if (!mpDef) {
      throw new Error(`Unknown mount point: ${mountPointId}`)
    }
    const { config } = configStore.getSnapshot()
    const script = config.mountPoints?.[mountPointId]?.scripts?.find((s) => s.id === scriptId)
    if (!script) {
      throw new Error(`Unknown script: ${scriptId}`)
    }
    const entry = await scriptRunner.executeScript(
      script,
      {
        eventId: randomUUID(),
        hookPoint: mountPointId,
        category: mpDef.category,
        timestamp: new Date(now()).toISOString(),
        projectName: 'demo-project',
        toolName: mpDef.supportsMatcher ? 'bash' : undefined,
        reason: 'script-test',
        summary: `测试运行脚本：${script.name}`,
      },
      { dryRun: true },
    )
    return {
      ...entry,
      logs: scriptRunner.getLogs(),
    }
  }

  return {
    mount,
    dispose,
    triggerMountPoint,
    testMountPoint,
    testScript,
  }
}
