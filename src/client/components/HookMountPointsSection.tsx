import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { HooksClientApi, LogBus } from '../api.ts'
import { formatMessage, type TranslateFn } from '../i18n.ts'
import {
  FALLBACK_CATEGORY_META,
  FALLBACK_MOUNT_POINTS,
  type CategoryMeta,
  type ExecutionLogEntry,
  type HookGroup,
  type HookMountPointDef,
  type HookScriptItem,
  type HooksConfig,
  type NotificationCategory,
  type ScriptSourceResult,
} from '../types.ts'
import {
  BellIcon,
  BellOffIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  FileCodeIcon,
  PlayIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  TerminalIcon,
  ToggleSwitch,
  TrashIcon,
  UploadIcon,
  WebhookIcon,
  XIcon,
} from './Icons.tsx'

export interface HookMountPointsSectionProps {
  t: TranslateFn
  isZh: boolean
  config: HooksConfig
  mountPoints?: HookMountPointDef[]
  categories?: Record<NotificationCategory, CategoryMeta>
  logs?: ExecutionLogEntry[]
  revision: number
  busy: boolean
  api: HooksClientApi
  logBus: LogBus
  onApplyState: (nextState: { revision: number; config: HooksConfig; logs?: ExecutionLogEntry[] }) => void
  onError: (msg: string | null) => void
  onNotice: (msg: string | null) => void
}

const MAX_SCRIPT_BYTES = 512 * 1024
const ALLOWED_SCRIPT_RE = /\.(mjs|js|cjs|ps1|sh|py|cmd|bat)$/i
const GROUP_ORDER: HookGroup[] = ['core', 'session_tools', 'subsystems']

export function HookMountPointsSection({
  t,
  isZh,
  config,
  mountPoints,
  categories,
  logs: initialLogs,
  revision,
  busy,
  api,
  logBus,
  onApplyState,
  onError,
  onNotice,
}: HookMountPointsSectionProps) {
  const mountDefs = mountPoints && mountPoints.length > 0 ? mountPoints : FALLBACK_MOUNT_POINTS
  const categoryMap = categories ?? FALLBACK_CATEGORY_META

  const [sectionExpanded, setSectionExpanded] = useState(true)
  const [groupOpen, setGroupOpen] = useState<Record<HookGroup, boolean>>({
    core: true,
    session_tools: true,
    subsystems: false,
  })
  const [selectedMountId, setSelectedMountId] = useState<string | null>(null)
  const [showLogs, setShowLogs] = useState(false)
  const [logs, setLogs] = useState<ExecutionLogEntry[]>(initialLogs ?? [])
  const [loadingLogs, setLoadingLogs] = useState(false)
  const [matcherDrafts, setMatcherDrafts] = useState<Record<string, string>>({})
  const [timeoutDrafts, setTimeoutDrafts] = useState<Record<string, string>>({})
  const [testRunResults, setTestRunResults] = useState<
    Record<string, { ok: boolean; text: string; stdout?: string; stderr?: string }>
  >({})
  const [uploadingMountId, setUploadingMountId] = useState<string | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [sourceModal, setSourceModal] = useState<ScriptSourceResult | null>(null)
  const [copiedSource, setCopiedSource] = useState(false)
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const uploadTargetMountRef = useRef<string | null>(null)

  useEffect(() => {
    if (initialLogs) setLogs(initialLogs)
  }, [initialLogs])

  useEffect(() => {
    return logBus.subscribe((nextLogs) => {
      setLogs(nextLogs)
    })
  }, [logBus])

  useEffect(() => {
    if (!sourceModal) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setSourceModal(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [sourceModal])

  const getMountState = (def: HookMountPointDef) => {
    return (
      config.mountPoints?.[def.id] ?? {
        enabled: def.defaultEnabled,
        bellEnabled: def.defaultBell,
        scripts: [],
      }
    )
  }

  const refreshLogs = async () => {
    setLoadingLogs(true)
    try {
      const res = await api.getExecutionLogs()
      if (res.ok) {
        setLogs(res.value.logs ?? [])
      }
    } finally {
      setLoadingLogs(false)
    }
  }

  const handleToggleLogs = () => {
    const next = !showLogs
    setShowLogs(next)
    if (next) void refreshLogs()
  }

  const handleResetDefaults = async () => {
    onError(null)
    const res = await api.resetDefaultScripts(revision)
    if (res.ok) {
      onApplyState(res.value)
      onNotice(t('resetDone'))
    } else {
      onError(res.error?.message || t('actionError'))
    }
  }

  const handleToggleMount = async (mountId: string, next: boolean) => {
    onError(null)
    const res = await api.toggleMountPoint(mountId, next, revision)
    if (res.ok) {
      onApplyState(res.value)
    } else {
      onError(res.error?.message || t('actionError'))
    }
  }

  const handleToggleBell = async (mountId: string, next: boolean) => {
    onError(null)
    const res = await api.toggleMountPointBell(mountId, next, revision)
    if (res.ok) {
      onApplyState(res.value)
    } else {
      onError(res.error?.message || t('actionError'))
    }
  }

  const handleToggleScript = async (mountId: string, scriptId: string, next: boolean) => {
    onError(null)
    const res = await api.toggleScript(mountId, scriptId, next, revision)
    if (res.ok) {
      onApplyState(res.value)
    } else {
      onError(res.error?.message || t('actionError'))
    }
  }

  const handleCommitScriptMeta = async (
    mountId: string,
    script: HookScriptItem,
    patch: { matcher?: string; timeoutSeconds?: number },
  ) => {
    onError(null)
    const draftKey = `${mountId}:${script.id}`
    const res = await api.updateScriptMeta(mountId, script.id, patch, revision)
    if (res.ok) {
      setMatcherDrafts((prev) => {
        const next = { ...prev }
        delete next[draftKey]
        return next
      })
      setTimeoutDrafts((prev) => {
        const next = { ...prev }
        delete next[draftKey]
        return next
      })
      onApplyState(res.value)
    } else {
      onError(res.error?.message || t('actionError'))
    }
  }

  const handleDeleteScript = async (mountId: string, scriptId: string) => {
    onError(null)
    const res = await api.deleteScript(mountId, scriptId, revision)
    if (res.ok) {
      onApplyState(res.value)
    } else {
      onError(res.error?.message || t('actionError'))
    }
  }

  const handleViewSource = async (mountId: string, scriptId: string) => {
    onError(null)
    const res = await api.getScriptSource(mountId, scriptId)
    if (res.ok) {
      setCopiedSource(false)
      setSourceModal(res.value)
    } else {
      onError(res.error?.message || t('actionError'))
    }
  }

  const handleTestScript = async (mountId: string, scriptId: string) => {
    const key = `script:${mountId}:${scriptId}`
    setTestingId(key)
    try {
      const res = await api.testScript(mountId, scriptId)
      if (res.ok) {
        if (res.value.logs) setLogs(res.value.logs)
        const ok = res.value.exitCode === 0 && !res.value.error
        const text = res.value.suppressed
          ? formatMessage(t('testResultSuppressed'), { ms: res.value.elapsedMs ?? 0 })
          : ok
            ? formatMessage(t('testResultOk'), { ms: res.value.elapsedMs ?? 0 })
            : formatMessage(t('testResultFail'), { msg: res.value.error || `exit ${res.value.exitCode}` })
        setTestRunResults((prev) => ({
          ...prev,
          [mountId]: { ok, text, stdout: res.value.stdout, stderr: res.value.stderr },
        }))
      } else {
        setTestRunResults((prev) => ({
          ...prev,
          [mountId]: { ok: false, text: formatMessage(t('testResultFail'), { msg: res.error?.message || 'Error' }) },
        }))
      }
    } finally {
      setTestingId(null)
    }
  }

  const handleTestMountPoint = async (mountId: string) => {
    const key = `mount:${mountId}`
    setTestingId(key)
    try {
      const res = await api.testMountPoint(mountId)
      if (res.ok) {
        if (res.value.logs) setLogs(res.value.logs)
        if (res.value.state) onApplyState(res.value.state)
        const text = res.value.suppressed
          ? formatMessage(t('testResultSuppressed'), { ms: res.value.elapsedMs ?? 0 })
          : formatMessage(t('testResultOk'), { ms: res.value.elapsedMs ?? 0 })
        setTestRunResults((prev) => ({ ...prev, [mountId]: { ok: true, text } }))
      } else {
        setTestRunResults((prev) => ({
          ...prev,
          [mountId]: { ok: false, text: formatMessage(t('testResultFail'), { msg: res.error?.message || 'Error' }) },
        }))
      }
    } finally {
      setTestingId(null)
    }
  }

  const handleUploadFile = async (file: File | undefined) => {
    const mountId = uploadTargetMountRef.current
    if (!file || !mountId) return
    if (!ALLOWED_SCRIPT_RE.test(file.name) || file.size <= 0 || file.size > MAX_SCRIPT_BYTES) {
      onError(t('scriptInvalidFile'))
      return
    }
    setUploadingMountId(mountId)
    onError(null)
    try {
      const res = await api.uploadScript({
        mountPointId: mountId,
        file,
        name: file.name,
        timeoutSeconds: 10,
        expectedRevision: revision,
      })
      if (res.ok) {
        onApplyState(res.value)
        onNotice(t('saved'))
      } else {
        onError(res.error?.message || t('actionError'))
      }
    } finally {
      setUploadingMountId(null)
      if (uploadInputRef.current) uploadInputRef.current.value = ''
    }
  }

  const groupTitle = (group: HookGroup): string => {
    if (group === 'core') return t('groupCore')
    if (group === 'session_tools') return t('groupSessionTools')
    return t('groupSubsystems')
  }

  const renderDrawer = (def: HookMountPointDef) => {
    const mpState = getMountState(def)
    const testResult = testRunResults[def.id]
    return (
      <div className="tavlo-hooks-drawer">
        <div className="tavlo-hooks-drawer-head">
          <div>
            <div className="tavlo-hooks-drawer-title">
              <span>{isZh ? def.nameZh : def.nameEn}</span>
              <span className="tavlo-hooks-badge tavlo-hooks-badge-mono">{def.id}</span>
            </div>
            <div className="tavlo-hooks-dsh-events">
              {def.dshEvents.map((ev) => (
                <code key={ev} className="tavlo-hooks-code-pill">
                  {ev}
                </code>
              ))}
            </div>
          </div>
          <div className="tavlo-hooks-drawer-head-actions">
            <button
              type="button"
              className="tavlo-hooks-btn tavlo-hooks-btn-sm"
              disabled={busy || uploadingMountId === def.id}
              onClick={() => {
                uploadTargetMountRef.current = def.id
                uploadInputRef.current?.click()
              }}
            >
              <UploadIcon size={13} />
              <span>{uploadingMountId === def.id ? t('uploadingScript') : t('uploadScript')}</span>
            </button>
            <button
              type="button"
              className="tavlo-hooks-btn tavlo-hooks-btn-primary tavlo-hooks-btn-sm"
              disabled={busy || testingId === `mount:${def.id}`}
              onClick={() => void handleTestMountPoint(def.id)}
            >
              <PlayIcon size={12} />
              <span>{testingId === `mount:${def.id}` ? t('testingBtn') : t('testMountPoint')}</span>
            </button>
          </div>
        </div>

        <div className="tavlo-hooks-script-list">
          {mpState.scripts.length === 0 ? (
            <div className="tavlo-hooks-empty-box">{t('noScriptsInPoint')}</div>
          ) : (
            mpState.scripts.map((script) => {
              const draftKey = `${def.id}:${script.id}`
              const matcherVal = matcherDrafts[draftKey] ?? script.matcher ?? ''
              const timeoutVal = timeoutDrafts[draftKey] ?? String(script.timeoutSeconds ?? 10)
              return (
                <div key={script.id} className="tavlo-hooks-script-row">
                  <div className="tavlo-hooks-script-main">
                    <ToggleSwitch
                      checked={script.enabled}
                      disabled={busy}
                      label={script.name}
                      compact
                      onChange={(next) => void handleToggleScript(def.id, script.id, next)}
                    />
                    <div className="tavlo-hooks-script-info">
                      <div className="tavlo-hooks-script-name-line">
                        <span className="tavlo-hooks-script-name">{script.name}</span>
                        <span
                          className={`tavlo-hooks-badge ${script.kind === 'default' ? 'tavlo-hooks-badge-blue' : 'tavlo-hooks-badge-muted'}`}
                        >
                          {script.kind === 'default' ? t('scriptDefaultBadge') : t('scriptCustomBadge')}
                        </span>
                        <code className="tavlo-hooks-code-pill">{script.filename}</code>
                      </div>

                      {(def.supportsMatcher || script.kind === 'custom') && (
                        <div className="tavlo-hooks-script-meta-inputs">
                          {def.supportsMatcher && (
                            <label className="tavlo-hooks-inline-meta">
                              <span>{t('matcherLabel')}</span>
                              <input
                                type="text"
                                className="tavlo-hooks-input tavlo-hooks-input-meta"
                                placeholder={t('matcherPlaceholder')}
                                value={matcherVal}
                                onChange={(e) => {
                                  const v = e.currentTarget.value
                                  setMatcherDrafts((prev) => ({ ...prev, [draftKey]: v }))
                                }}
                                onBlur={() => {
                                  if ((matcherDrafts[draftKey] ?? script.matcher ?? '') !== (script.matcher ?? '')) {
                                    void handleCommitScriptMeta(def.id, script, { matcher: matcherVal.trim() })
                                  }
                                }}
                              />
                            </label>
                          )}
                          {script.kind === 'custom' && (
                            <label className="tavlo-hooks-inline-meta">
                              <span>{t('timeoutLabel')}</span>
                              <input
                                type="number"
                                min={1}
                                max={60}
                                step={1}
                                className="tavlo-hooks-input tavlo-hooks-input-xs"
                                value={timeoutVal}
                                onChange={(e) => {
                                  const v = e.currentTarget.value
                                  setTimeoutDrafts((prev) => ({ ...prev, [draftKey]: v }))
                                }}
                                onBlur={() => {
                                  const num = Math.min(60, Math.max(1, Math.round(Number(timeoutVal) || 10)))
                                  setTimeoutDrafts((prev) => ({ ...prev, [draftKey]: String(num) }))
                                  if (num !== (script.timeoutSeconds ?? 10)) {
                                    void handleCommitScriptMeta(def.id, script, { timeoutSeconds: num })
                                  }
                                }}
                              />
                            </label>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="tavlo-hooks-script-actions">
                    <button
                      type="button"
                      className="tavlo-hooks-btn tavlo-hooks-btn-xs"
                      onClick={() => void handleViewSource(def.id, script.id)}
                    >
                      <FileCodeIcon size={13} />
                      <span>{t('viewSource')}</span>
                    </button>
                    <button
                      type="button"
                      className="tavlo-hooks-btn tavlo-hooks-btn-xs"
                      disabled={busy || testingId === `script:${def.id}:${script.id}`}
                      onClick={() => void handleTestScript(def.id, script.id)}
                    >
                      <PlayIcon size={12} />
                      <span>{testingId === `script:${def.id}:${script.id}` ? t('testingBtn') : t('testRunScript')}</span>
                    </button>
                    {script.kind === 'custom' && (
                      <button
                        type="button"
                        className="tavlo-hooks-icon-btn tavlo-hooks-icon-btn-danger"
                        aria-label={t('deleteScript')}
                        title={t('deleteScript')}
                        disabled={busy}
                        onClick={() => void handleDeleteScript(def.id, script.id)}
                      >
                        <TrashIcon size={13} />
                      </button>
                    )}
                  </div>
                </div>
              )
            })
          )}
        </div>

        {testResult && (
          <div className={`tavlo-hooks-inline-result ${testResult.ok ? 'is-success' : 'is-error'}`} role="status">
            <div>{testResult.text}</div>
            {testResult.stdout && <pre className="tavlo-hooks-output-pre">{testResult.stdout}</pre>}
            {testResult.stderr && <pre className="tavlo-hooks-output-pre is-stderr">{testResult.stderr}</pre>}
          </div>
        )}
      </div>
    )
  }

  return (
    <section className="tavlo-hooks-card">
      <div className="tavlo-hooks-card-header-bar">
        <button
          type="button"
          className="tavlo-hooks-card-header-btn"
          aria-expanded={sectionExpanded}
          onClick={() => setSectionExpanded((prev) => !prev)}
        >
          <span className="tavlo-hooks-icon-chip is-blue">
            <WebhookIcon size={17} />
          </span>
          <div className="tavlo-hooks-card-titles">
            <h3>{t('mountPointsTitle')}</h3>
            <p>{t('mountPointsSubtitle')}</p>
          </div>
        </button>
        <div className="tavlo-hooks-header-tools">
          <button
            type="button"
            className="tavlo-hooks-btn tavlo-hooks-btn-sm"
            disabled={busy}
            onClick={() => void handleResetDefaults()}
          >
            <RotateCcwIcon size={13} />
            <span>{t('resetDefaultScripts')}</span>
          </button>
          <button
            type="button"
            className={`tavlo-hooks-btn tavlo-hooks-btn-sm${showLogs ? ' is-active' : ''}`}
            aria-pressed={showLogs}
            onClick={handleToggleLogs}
          >
            <TerminalIcon size={13} />
            <span>{t('executionLogs')}</span>
            {logs.length > 0 && <span className="tavlo-hooks-count-pill">{logs.length}</span>}
          </button>
          <button
            type="button"
            className="tavlo-hooks-icon-btn"
            aria-label={sectionExpanded ? t('targetCollapse') : t('targetExpand')}
            onClick={() => setSectionExpanded((prev) => !prev)}
          >
            {sectionExpanded ? <ChevronDownIcon size={17} /> : <ChevronRightIcon size={17} />}
          </button>
        </div>
      </div>

      <input
        ref={uploadInputRef}
        type="file"
        accept=".mjs,.js,.cjs,.ps1,.sh,.py,.cmd,.bat"
        hidden
        onChange={(e) => void handleUploadFile(e.currentTarget.files?.[0])}
      />

      {showLogs && (
        <div className="tavlo-hooks-logs-panel">
          <div className="tavlo-hooks-logs-head">
            <span>{t('logsTitle')}</span>
            <button
              type="button"
              className="tavlo-hooks-btn tavlo-hooks-btn-xs"
              disabled={loadingLogs}
              onClick={() => void refreshLogs()}
            >
              <RefreshCwIcon size={12} />
              <span>{t('refresh')}</span>
            </button>
          </div>
          {logs.length === 0 ? (
            <div className="tavlo-hooks-empty-box">{t('logsEmpty')}</div>
          ) : (
            <div className="tavlo-hooks-logs-list">
              {logs.map((entry) => (
                <div key={entry.id} className="tavlo-hooks-log-item">
                  <div className="tavlo-hooks-log-top">
                    <span className="tavlo-hooks-log-time">
                      {new Date(entry.timestamp).toLocaleTimeString()}
                    </span>
                    <code className="tavlo-hooks-code-pill">{entry.mountPointId}</code>
                    <span className="tavlo-hooks-log-script">{entry.scriptName}</span>
                    {typeof entry.turn === 'number' && (
                      <span className="tavlo-hooks-badge tavlo-hooks-badge-muted">T{entry.turn}</span>
                    )}
                    {entry.reason && (
                      <span className="tavlo-hooks-badge tavlo-hooks-badge-muted">{entry.reason}</span>
                    )}
                    {entry.sessionId && (
                      <code className="tavlo-hooks-code-pill" title={entry.sessionId}>
                        {entry.sessionId.slice(-8)}
                      </code>
                    )}
                    {entry.dryRun && (
                      <span className="tavlo-hooks-badge tavlo-hooks-badge-blue">{t('logsDryRun')}</span>
                    )}
                    {entry.suppressed && (
                      <span className="tavlo-hooks-badge tavlo-hooks-badge-warn">{t('logsSuppressed')}</span>
                    )}
                    <span
                      className={`tavlo-hooks-badge ${entry.exitCode === 0 && !entry.error ? 'tavlo-hooks-badge-success' : 'tavlo-hooks-badge-error'}`}
                    >
                      {formatMessage(t('logsExitCode'), { code: entry.exitCode ?? 'err' })}
                    </span>
                    <span className="tavlo-hooks-helper">{entry.elapsedMs} ms</span>
                  </div>
                  {(entry.error || entry.stdout || entry.stderr) && (
                    <div className="tavlo-hooks-log-output">
                      {entry.error && <pre className="tavlo-hooks-output-pre is-stderr">{entry.error}</pre>}
                      {entry.stdout && <pre className="tavlo-hooks-output-pre">{entry.stdout}</pre>}
                      {entry.stderr && <pre className="tavlo-hooks-output-pre is-stderr">{entry.stderr}</pre>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {sectionExpanded && (
        <div className="tavlo-hooks-card-body">
          {GROUP_ORDER.map((group) => {
            const defs = mountDefs.filter((item) => item.group === group)
            if (defs.length === 0) return null
            const isOpen = groupOpen[group]
            const activeCount = defs.filter((item) => getMountState(item).enabled).length
            const selectedInGroup = defs.find((item) => item.id === selectedMountId)

            return (
              <div key={group} className="tavlo-hooks-group">
                <button
                  type="button"
                  className="tavlo-hooks-group-header"
                  aria-expanded={isOpen}
                  onClick={() => setGroupOpen((prev) => ({ ...prev, [group]: !isOpen }))}
                >
                  <span className="tavlo-hooks-group-title">
                    {isOpen ? <ChevronDownIcon size={15} /> : <ChevronRightIcon size={15} />}
                    <span>{groupTitle(group)}</span>
                  </span>
                  <span className="tavlo-hooks-badge tavlo-hooks-badge-muted">
                    {formatMessage(t('mountCountSummary'), { enabled: activeCount, total: defs.length })}
                  </span>
                </button>

                {isOpen && (
                  <>
                    <div className="tavlo-hooks-mount-grid">
                      {defs.map((def) => {
                        const mpState = getMountState(def)
                        const catMeta = categoryMap[def.category] ?? FALLBACK_CATEGORY_META.Notification
                        const defaultCount = mpState.scripts.filter((s) => s.kind === 'default').length
                        const customCount = mpState.scripts.filter((s) => s.kind === 'custom').length
                        const isSelected = selectedMountId === def.id

                        return (
                          <div
                            key={def.id}
                            className="tavlo-hooks-mount-card"
                            data-selected={isSelected ? 'true' : 'false'}
                            data-enabled={mpState.enabled ? 'true' : 'false'}
                            onClick={() => setSelectedMountId(isSelected ? null : def.id)}
                          >
                            <div className="tavlo-hooks-mount-top">
                              <div className="tavlo-hooks-mount-title-wrap">
                                <span aria-hidden="true">{catMeta.icon}</span>
                                <span className="tavlo-hooks-mount-name">{isZh ? def.nameZh : def.nameEn}</span>
                              </div>
                              <ToggleSwitch
                                checked={mpState.enabled}
                                disabled={busy}
                                label={isZh ? def.nameZh : def.nameEn}
                                compact
                                onChange={(next) => void handleToggleMount(def.id, next)}
                              />
                            </div>

                            <div className="tavlo-hooks-mount-event-line">
                              <code className="tavlo-hooks-code-pill">{def.dshEvents[0]}</code>
                            </div>

                            <p className="tavlo-hooks-mount-desc">{isZh ? def.descZh : def.descEn}</p>

                            <div className="tavlo-hooks-mount-footer">
                              <span className="tavlo-hooks-mount-counts">
                                {formatMessage(t('scriptsSummary'), {
                                  defaults: defaultCount,
                                  customs: customCount,
                                })}
                              </span>

                              <div className="tavlo-hooks-mount-tools">
                                <button
                                  type="button"
                                  className={`tavlo-hooks-bell-btn ${mpState.bellEnabled ? 'is-on' : 'is-off'}`}
                                  aria-pressed={mpState.bellEnabled}
                                  aria-label={mpState.bellEnabled ? t('bellOnTip') : t('bellOffTip')}
                                  title={mpState.bellEnabled ? t('bellOnTip') : t('bellOffTip')}
                                  disabled={busy}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    void handleToggleBell(def.id, !mpState.bellEnabled)
                                  }}
                                >
                                  {mpState.bellEnabled ? <BellIcon size={14} /> : <BellOffIcon size={14} />}
                                </button>
                                <button
                                  type="button"
                                  className="tavlo-hooks-btn tavlo-hooks-btn-xs"
                                  aria-expanded={isSelected}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setSelectedMountId(isSelected ? null : def.id)
                                  }}
                                >
                                  <span>{isSelected ? t('collapseScripts') : t('expandScripts')}</span>
                                  {isSelected ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
                                </button>
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>

                    {selectedInGroup && renderDrawer(selectedInGroup)}
                  </>
                )}
              </div>
            )
          })}
        </div>
      )}

      {sourceModal &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="tavlo-hooks-modal-backdrop"
            role="presentation"
            onClick={() => setSourceModal(null)}
          >
            <div
              className="tavlo-hooks-modal"
              role="dialog"
              aria-modal="true"
              aria-label={t('sourceModalTitle')}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="tavlo-hooks-modal-head">
                <div className="tavlo-hooks-title-with-pills">
                  <h4>{sourceModal.filename}</h4>
                  <span className="tavlo-hooks-badge tavlo-hooks-badge-muted">
                    {sourceModal.kind === 'default' ? t('scriptDefaultBadge') : t('scriptCustomBadge')}
                  </span>
                </div>
                <div className="tavlo-hooks-row-controls">
                  <button
                    type="button"
                    className="tavlo-hooks-btn tavlo-hooks-btn-xs"
                    onClick={() => {
                      void navigator.clipboard?.writeText(sourceModal.content).then(() => {
                        setCopiedSource(true)
                        setTimeout(() => setCopiedSource(false), 1800)
                      })
                    }}
                  >
                    {copiedSource ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
                    <span>{copiedSource ? t('copiedSource') : t('copySource')}</span>
                  </button>
                  <button
                    type="button"
                    className="tavlo-hooks-icon-btn"
                    aria-label={t('closeBtn')}
                    onClick={() => setSourceModal(null)}
                  >
                    <XIcon size={15} />
                  </button>
                </div>
              </div>
              <pre className="tavlo-hooks-source-pre">
                <code>{sourceModal.content}</code>
              </pre>
            </div>
          </div>,
          document.body,
        )}
    </section>
  )
}
