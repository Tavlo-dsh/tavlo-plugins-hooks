import { useEffect, useState } from 'react'
import type { HooksClientApi } from '../api.ts'
import { formatMessage, type TranslateFn } from '../i18n.ts'
import {
  FALLBACK_CATEGORY_META,
  FALLBACK_PROVIDERS,
  NOTIFICATION_CATEGORIES,
  type CategoryMeta,
  type HooksConfig,
  type NotificationCategory,
  type ProviderDefinition,
  type ProviderFieldDef,
  type TestSendResult,
  type ThirdPartyProviderId,
  type ThirdPartyTarget,
} from '../types.ts'
import {
  AlertTriangleIcon,
  BellIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  EyeIcon,
  EyeOffIcon,
  PlatformIcon,
  PlusIcon,
  SendIcon,
  ToggleSwitch,
  TrashIcon,
} from './Icons.tsx'

export interface ThirdPartySectionProps {
  t: TranslateFn
  isZh: boolean
  config: HooksConfig
  providers?: ProviderDefinition[]
  categories?: Record<NotificationCategory, CategoryMeta>
  revision: number
  busy: boolean
  api: HooksClientApi
  onApplyState: (nextState: { revision: number; config: HooksConfig }) => void
  onError: (msg: string | null) => void
  onNotice: (msg: string | null) => void
}

const MAX_TARGETS = 20

interface TargetDraft {
  id: string
  isNew: boolean
  name: string
  provider: ThirdPartyProviderId
  enabled: boolean
  events: Record<NotificationCategory, boolean>
  config: Record<string, string>
  secretState?: ThirdPartyTarget['secretState']
}

function defaultEvents(): Record<NotificationCategory, boolean> {
  return {
    PermissionRequest: true,
    Notification: true,
    Stop: true,
    StopFailure: true,
    SessionStart: false,
    UserPromptSubmit: false,
  }
}

function fieldValueToString(val: unknown): string {
  if (val === undefined || val === null) return ''
  if (Array.isArray(val)) {
    if (val.length > 0 && typeof val[0] === 'object' && val[0] !== null && 'key' in val[0]) {
      return (val as Array<{ key: string; value?: string }>)
        .map((pair) => `${pair.key}=${pair.value ?? ''}`)
        .join('\n')
    }
    return val.join(', ')
  }
  return String(val)
}

function buildInitialConfig(providerDef: ProviderDefinition | undefined, existing?: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  if (!providerDef) return out
  for (const field of providerDef.fields) {
    if (field.kind === 'secret') {
      out[field.key] = ''
      continue
    }
    const raw = existing?.[field.key]
    if (raw !== undefined && raw !== null && raw !== '') {
      out[field.key] = fieldValueToString(raw)
    } else if (field.defaultValue !== undefined) {
      out[field.key] = String(field.defaultValue)
    } else {
      out[field.key] = ''
    }
  }
  return out
}

function targetToDraft(target: ThirdPartyTarget, providerList: ProviderDefinition[]): TargetDraft {
  const def = providerList.find((p) => p.id === target.provider)
  return {
    id: target.id,
    isNew: false,
    name: target.name,
    provider: target.provider,
    enabled: target.enabled,
    events: { ...defaultEvents(), ...target.events },
    config: buildInitialConfig(def, target.config),
    secretState: target.secretState,
  }
}

function parseKvLines(text: string): Array<{ key: string; value: string }> {
  const rows: Array<{ key: string; value: string }> = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const idx = line.indexOf('=')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    if (key) rows.push({ key, value })
  }
  return rows
}

function serializeDraftConfig(
  draft: TargetDraft,
  providerDef: ProviderDefinition | undefined,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  if (!providerDef) return result
  for (const field of providerDef.fields) {
    const raw = draft.config[field.key] ?? ''
    if (field.kind === 'secret') {
      const trimmed = raw.trim()
      if (trimmed !== '') {
        result[field.key] = trimmed
      }
      continue
    }
    if (field.kind === 'number') {
      const trimmed = raw.trim()
      if (trimmed !== '') {
        const parsed = Number(trimmed)
        if (Number.isFinite(parsed)) result[field.key] = Math.trunc(parsed)
      }
      continue
    }
    if (field.kind === 'csv') {
      const items = raw
        .split(/[,，\s]+/)
        .map((s) => s.trim())
        .filter(Boolean)
      if (items.length > 0) result[field.key] = items
      continue
    }
    if (field.kind === 'numberCsv') {
      const nums = raw
        .split(/[,，\s]+/)
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n))
      if (nums.length > 0) result[field.key] = nums
      continue
    }
    if (field.kind === 'kvLines') {
      result[field.key] = parseKvLines(raw)
      continue
    }
    result[field.key] = raw.trim()
  }
  return result
}

function validateDraft(
  draft: TargetDraft,
  providerDef: ProviderDefinition | undefined,
  isZh: boolean,
): string | null {
  if (!draft.name.trim()) {
    return isZh ? '请填写目标名称。' : 'Please enter a target name.'
  }
  if (!providerDef) return null
  for (const field of providerDef.fields) {
    const val = (draft.config[field.key] ?? '').trim()
    const hasSavedSecret = field.kind === 'secret' && Boolean(draft.secretState?.[field.key]?.configured)
    if (field.required && !val && !hasSavedSecret) {
      const label = isZh ? field.labelZh : field.labelEn
      return isZh ? `请填写必填项：${label}` : `Required field missing: ${label}`
    }
  }
  if (draft.provider === 'wxpusher') {
    const hasSpt = Boolean((draft.config.spt ?? '').trim() || draft.secretState?.spt?.configured)
    const hasAppToken = Boolean((draft.config.appToken ?? '').trim() || draft.secretState?.appToken?.configured)
    if (!hasSpt && !hasAppToken) {
      return isZh ? 'WxPusher 需要填写 SPT 或 App Token。' : 'WxPusher requires either SPT or App Token.'
    }
  }
  if (draft.provider === 'bark') {
    const user = (draft.config.basicUsername ?? '').trim()
    const hasPass = Boolean((draft.config.basicPassword ?? '').trim() || draft.secretState?.basicPassword?.configured)
    if ((user && !hasPass) || (!user && (draft.config.basicPassword ?? '').trim())) {
      return isZh ? 'Bark Basic 认证需要同时填写用户名和密码。' : 'Bark Basic auth requires both username and password.'
    }
  }
  if (draft.provider === 'ntfy') {
    const authType = draft.config.authType || 'none'
    if (authType === 'bearer') {
      const hasToken = Boolean((draft.config.authToken ?? '').trim() || draft.secretState?.authToken?.configured)
      if (!hasToken) return isZh ? 'Bearer 认证需要填写 Token。' : 'Bearer Token is required.'
    } else if (authType === 'basic') {
      const user = (draft.config.basicUsername ?? '').trim()
      const hasPass = Boolean((draft.config.basicPassword ?? '').trim() || draft.secretState?.basicPassword?.configured)
      if (!user || !hasPass) {
        return isZh ? 'Basic 认证需要填写用户名和密码。' : 'Basic auth requires username and password.'
      }
    }
  }
  return null
}

function isFieldVisible(field: ProviderFieldDef, draft: TargetDraft): boolean {
  if (draft.provider === 'ntfy') {
    const authType = draft.config.authType || 'none'
    if (field.key === 'authToken') return authType === 'bearer'
    if (field.key === 'basicUsername' || field.key === 'basicPassword') return authType === 'basic'
  }
  if (draft.provider === 'custom') {
    const method = draft.config.method || 'POST'
    const bodyType = draft.config.bodyType || 'json'
    if (field.key === 'bodyType') return method !== 'GET'
    if (field.key === 'jsonBody') return method !== 'GET' && bodyType === 'json'
    if (field.key === 'formBody') return method !== 'GET' && bodyType === 'form'
    if (field.key === 'textBody') return method !== 'GET' && bodyType === 'text'
  }
  return true
}

export function ThirdPartySection({
  t,
  isZh,
  config,
  providers,
  categories,
  revision,
  busy,
  api,
  onApplyState,
  onError,
  onNotice,
}: ThirdPartySectionProps) {
  const providerList = providers && providers.length > 0 ? providers : FALLBACK_PROVIDERS
  const categoryMap = categories ?? FALLBACK_CATEGORY_META

  const [selectedNewProvider, setSelectedNewProvider] = useState<ThirdPartyProviderId>(providerList[0]?.id ?? 'bark')
  const [newDraft, setNewDraft] = useState<TargetDraft | null>(null)
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({})
  const [dirtyIds, setDirtyIds] = useState<Record<string, boolean>>({})
  const [draftsById, setDraftsById] = useState<Record<string, TargetDraft>>({})
  const [revealedSecrets, setRevealedSecrets] = useState<Record<string, boolean>>({})
  const [pendingTargetId, setPendingTargetId] = useState<string | null>(null)
  const [testingTargetId, setTestingTargetId] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, TestSendResult & { errorMsg?: string }>>({})
  const [localError, setLocalError] = useState<Record<string, string>>({})

  const savedTargets = config.thirdParty.targets ?? []
  const totalCount = savedTargets.length

  useEffect(() => {
    setDraftsById((prev) => {
      const next: Record<string, TargetDraft> = {}
      for (const target of savedTargets) {
        const existing = prev[target.id]
        next[target.id] = existing && dirtyIds[target.id]
          ? {
              ...existing,
              enabled: target.enabled,
              secretState: target.secretState,
            }
          : targetToDraft(target, providerList)
      }
      return next
    })
  }, [savedTargets, providerList, dirtyIds])

  const getDraft = (target: ThirdPartyTarget): TargetDraft => {
    return draftsById[target.id] ?? targetToDraft(target, providerList)
  }

  const updateDraft = (targetId: string, updater: (prev: TargetDraft) => TargetDraft) => {
    if (newDraft && newDraft.id === targetId) {
      setNewDraft((prev) => (prev ? updater(prev) : prev))
      return
    }
    setDirtyIds((prev) => (prev[targetId] ? prev : { ...prev, [targetId]: true }))
    setDraftsById((prev) => {
      const base = prev[targetId]
      if (!base) return prev
      return { ...prev, [targetId]: updater(base) }
    })
  }

  const handleMasterToggle = async (nextEnabled: boolean) => {
    onError(null)
    const res = await api.saveSettings({ thirdParty: { enabled: nextEnabled } }, revision)
    if (res.ok) {
      onApplyState(res.value)
    } else {
      onError(res.error?.message || t('actionError'))
    }
  }

  const handleAddTarget = () => {
    if (totalCount >= MAX_TARGETS || newDraft) return
    const def = providerList.find((p) => p.id === selectedNewProvider) ?? providerList[0]
    const id = `draft_${Date.now()}`
    const draft: TargetDraft = {
      id,
      isNew: true,
      name: isZh ? def.labelZh : def.labelEn,
      provider: def.id,
      enabled: true,
      events: defaultEvents(),
      config: buildInitialConfig(def),
    }
    setNewDraft(draft)
    setExpandedIds((prev) => ({ ...prev, [id]: true }))
  }

  const handleProviderChange = (draftId: string, nextProvider: ThirdPartyProviderId) => {
    const def = providerList.find((p) => p.id === nextProvider)
    updateDraft(draftId, (prev) => ({
      ...prev,
      provider: nextProvider,
      config: buildInitialConfig(def),
      secretState: prev.provider === nextProvider ? prev.secretState : undefined,
    }))
    setLocalError((prev) => {
      const next = { ...prev }
      delete next[draftId]
      return next
    })
  }

  const handleSaveTarget = async (draft: TargetDraft) => {
    const def = providerList.find((p) => p.id === draft.provider)
    const validationError = validateDraft(draft, def, isZh)
    if (validationError) {
      setLocalError((prev) => ({ ...prev, [draft.id]: validationError }))
      return
    }
    setLocalError((prev) => {
      const next = { ...prev }
      delete next[draft.id]
      return next
    })
    setPendingTargetId(draft.id)
    onError(null)
    try {
      const payloadTarget: Partial<ThirdPartyTarget> = {
        ...(draft.isNew ? {} : { id: draft.id }),
        name: draft.name.trim(),
        provider: draft.provider,
        enabled: draft.enabled,
        events: draft.events,
        config: serializeDraftConfig(draft, def),
      }
      const res = await api.saveThirdPartyTarget(payloadTarget, revision)
      if (res.ok) {
        onApplyState(res.value)
        if (draft.isNew) {
          setNewDraft(null)
          const savedList = res.value.config.thirdParty.targets
          const newest = savedList[savedList.length - 1]
          if (newest) {
            setExpandedIds((prev) => ({ ...prev, [newest.id]: false }))
          }
        } else {
          setDirtyIds((prev) => {
            const next = { ...prev }
            delete next[draft.id]
            return next
          })
          const fresh = res.value.config.thirdParty.targets.find((item) => item.id === draft.id)
          if (fresh) {
            setDraftsById((prev) => ({ ...prev, [fresh.id]: targetToDraft(fresh, providerList) }))
          }
        }
        onNotice(t('targetSaved'))
      } else {
        setLocalError((prev) => ({ ...prev, [draft.id]: res.error?.message || t('targetSaveFailed') }))
      }
    } finally {
      setPendingTargetId(null)
    }
  }

  const handleToggleTarget = async (draft: TargetDraft, nextEnabled: boolean) => {
    if (draft.isNew) {
      updateDraft(draft.id, (prev) => ({ ...prev, enabled: nextEnabled }))
      return
    }
    setPendingTargetId(draft.id)
    onError(null)
    try {
      const res = await api.toggleThirdPartyTarget(draft.id, nextEnabled, revision)
      if (res.ok) {
        onApplyState(res.value)
      } else {
        onError(res.error?.message || t('actionError'))
      }
    } finally {
      setPendingTargetId(null)
    }
  }

  const handleDeleteTarget = async (draft: TargetDraft) => {
    if (draft.isNew) {
      setNewDraft(null)
      return
    }
    setPendingTargetId(draft.id)
    onError(null)
    try {
      const res = await api.deleteThirdPartyTarget(draft.id, revision)
      if (res.ok) {
        onApplyState(res.value)
        onNotice(t('targetDeleted'))
      } else {
        onError(res.error?.message || t('actionError'))
      }
    } finally {
      setPendingTargetId(null)
    }
  }

  const handleTestTarget = async (draft: TargetDraft) => {
    const def = providerList.find((p) => p.id === draft.provider)
    const validationError = validateDraft(draft, def, isZh)
    if (validationError) {
      setLocalError((prev) => ({ ...prev, [draft.id]: validationError }))
      return
    }
    setTestingTargetId(draft.id)
    setTestResults((prev) => {
      const next = { ...prev }
      delete next[draft.id]
      return next
    })
    try {
      const payloadTarget: Partial<ThirdPartyTarget> = {
        ...(draft.isNew ? {} : { id: draft.id }),
        name: draft.name.trim(),
        provider: draft.provider,
        enabled: draft.enabled,
        events: draft.events,
        config: serializeDraftConfig(draft, def),
      }
      const res = await api.testThirdPartyTarget(payloadTarget)
      if (res.ok) {
        setTestResults((prev) => ({ ...prev, [draft.id]: res.value }))
      } else {
        setTestResults((prev) => ({
          ...prev,
          [draft.id]: {
            accepted: false,
            errorMsg: res.error?.message || t('actionError'),
          },
        }))
      }
    } finally {
      setTestingTargetId(null)
    }
  }

  const renderTargetCard = (draft: TargetDraft) => {
    const def = providerList.find((p) => p.id === draft.provider) ?? providerList[0]
    const expanded = Boolean(expandedIds[draft.id])
    const isPending = pendingTargetId === draft.id
    const isTesting = testingTargetId === draft.id
    const testResult = testResults[draft.id]
    const errText = localError[draft.id]
    const subscribedLabels = NOTIFICATION_CATEGORIES.filter((cat) => draft.events[cat]).map((cat) =>
      isZh ? categoryMap[cat].labelZh : categoryMap[cat].labelEn,
    )

    return (
      <div key={draft.id} className="tavlo-hooks-target-card" data-expanded={expanded ? 'true' : 'false'}>
        <div className="tavlo-hooks-target-header">
          <div className="tavlo-hooks-target-main">
            <ToggleSwitch
              checked={draft.enabled}
              disabled={busy || isPending}
              label={draft.name || def.labelEn}
              onChange={(next) => void handleToggleTarget(draft, next)}
              compact
            />
            <PlatformIcon provider={draft.provider} size={22} />
            <div className="tavlo-hooks-target-title-wrap">
              <div className="tavlo-hooks-target-title-row">
                <span className="tavlo-hooks-target-name">{draft.name || (isZh ? def.labelZh : def.labelEn)}</span>
                <span className="tavlo-hooks-badge tavlo-hooks-badge-muted">
                  {isZh ? def.labelZh : def.labelEn}
                </span>
                {draft.isNew && (
                  <span className="tavlo-hooks-badge tavlo-hooks-badge-warn">{t('targetUnsavedBadge')}</span>
                )}
              </div>
              <div className="tavlo-hooks-target-events-summary">
                {subscribedLabels.length > 0 ? subscribedLabels.join(' / ') : t('targetNoEvents')}
              </div>
            </div>
          </div>

          <div className="tavlo-hooks-target-actions">
            <button
              type="button"
              className="tavlo-hooks-btn tavlo-hooks-btn-sm"
              disabled={busy || isTesting}
              onClick={() => void handleTestTarget(draft)}
            >
              <SendIcon size={13} />
              <span>{isTesting ? t('testingBtn') : t('testBtn')}</span>
            </button>
            <button
              type="button"
              className="tavlo-hooks-icon-btn"
              aria-expanded={expanded}
              aria-label={expanded ? t('targetCollapse') : t('targetExpand')}
              title={expanded ? t('targetCollapse') : t('targetExpand')}
              onClick={() => setExpandedIds((prev) => ({ ...prev, [draft.id]: !expanded }))}
            >
              {expanded ? <ChevronDownIcon size={15} /> : <ChevronRightIcon size={15} />}
            </button>
            <button
              type="button"
              className="tavlo-hooks-icon-btn tavlo-hooks-icon-btn-danger"
              disabled={busy || isPending}
              aria-label={t('targetDeleteBtn')}
              title={t('targetDeleteBtn')}
              onClick={() => void handleDeleteTarget(draft)}
            >
              <TrashIcon size={14} />
            </button>
          </div>
        </div>

        {testResult && (
          <div
            className={`tavlo-hooks-inline-result ${testResult.accepted ? 'is-success' : 'is-error'}`}
            role="status"
          >
            {testResult.accepted
              ? formatMessage(t('targetTestOk'), { ms: testResult.elapsedMs ?? 0 })
              : formatMessage(t('targetTestFail'), {
                  msg: testResult.errorMsg || testResult.message || testResult.errorCode || 'Error',
                })}
          </div>
        )}

        {expanded && (
          <div className="tavlo-hooks-target-body">
            <div className="tavlo-hooks-field-grid">
              <div className="tavlo-hooks-field">
                <label className="tavlo-hooks-label">{t('targetNameLabel')}</label>
                <input
                  type="text"
                  className="tavlo-hooks-input"
                  value={draft.name}
                  maxLength={64}
                  placeholder={t('targetNamePlaceholder')}
                  onChange={(e) => {
                    const val = e.currentTarget.value
                    updateDraft(draft.id, (prev) => ({ ...prev, name: val }))
                  }}
                />
              </div>
              <div className="tavlo-hooks-field">
                <label className="tavlo-hooks-label">{t('targetProviderLabel')}</label>
                <select
                  className="tavlo-hooks-select"
                  value={draft.provider}
                  onChange={(e) => handleProviderChange(draft.id, e.currentTarget.value as ThirdPartyProviderId)}
                >
                  {providerList.map((p) => (
                    <option key={p.id} value={p.id}>
                      {isZh ? p.labelZh : p.labelEn}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="tavlo-hooks-field">
              <span className="tavlo-hooks-label">{t('targetEventsLabel')}</span>
              <div className="tavlo-hooks-events-checks">
                {NOTIFICATION_CATEGORIES.map((cat) => {
                  const meta = categoryMap[cat]
                  const checked = Boolean(draft.events[cat])
                  return (
                    <label key={cat} className="tavlo-hooks-check-pill" data-checked={checked ? 'true' : 'false'}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          const nextVal = e.currentTarget.checked
                          updateDraft(draft.id, (prev) => ({
                            ...prev,
                            events: { ...prev.events, [cat]: nextVal },
                          }))
                        }}
                      />
                      <span aria-hidden="true">{meta.icon}</span>
                      <span>{isZh ? meta.labelZh : meta.labelEn}</span>
                    </label>
                  )
                })}
              </div>
            </div>

            <div className="tavlo-hooks-field-grid">
              {def.fields
                .filter((field) => isFieldVisible(field, draft))
                .map((field) => {
                  const fullSpan = field.kind === 'kvLines' || field.kind === 'textarea'
                  const val = draft.config[field.key] ?? ''
                  const label = isZh ? field.labelZh : field.labelEn
                  const secretConfigured = field.kind === 'secret' && Boolean(draft.secretState?.[field.key]?.configured)
                  const secretPreview = draft.secretState?.[field.key]?.preview
                  const revealKey = `${draft.id}:${field.key}`
                  const isRevealed = Boolean(revealedSecrets[revealKey])
                  const placeholder = secretConfigured
                    ? t('secretConfiguredPlaceholder')
                    : (isZh ? field.placeholderZh : field.placeholderEn) || field.placeholder || ''

                  return (
                    <div key={field.key} className={`tavlo-hooks-field${fullSpan ? ' is-full' : ''}`}>
                      <label className="tavlo-hooks-label">
                        <span>{label}</span>
                        {field.required && <span className="tavlo-hooks-req">*</span>}
                        {secretConfigured && secretPreview && (
                          <span className="tavlo-hooks-secret-preview">{secretPreview}</span>
                        )}
                      </label>

                      {field.kind === 'select' ? (
                        <select
                          className="tavlo-hooks-select"
                          value={val}
                          onChange={(e) => {
                            const nextVal = e.currentTarget.value
                            updateDraft(draft.id, (prev) => ({
                              ...prev,
                              config: { ...prev.config, [field.key]: nextVal },
                            }))
                          }}
                        >
                          {(field.options ?? []).map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {isZh ? (opt.labelZh ?? opt.label ?? opt.value) : (opt.labelEn ?? opt.label ?? opt.value)}
                            </option>
                          ))}
                        </select>
                      ) : field.kind === 'secret' ? (
                        <div className="tavlo-hooks-secret-input-wrap">
                          <input
                            type={isRevealed ? 'text' : 'password'}
                            className="tavlo-hooks-input"
                            autoComplete="new-password"
                            spellCheck={false}
                            value={val}
                            placeholder={placeholder}
                            onChange={(e) => {
                              const nextVal = e.currentTarget.value
                              updateDraft(draft.id, (prev) => ({
                                ...prev,
                                config: { ...prev.config, [field.key]: nextVal },
                              }))
                            }}
                          />
                          <button
                            type="button"
                            className="tavlo-hooks-icon-btn"
                            aria-label={isRevealed ? t('hideSecret') : t('showSecret')}
                            title={isRevealed ? t('hideSecret') : t('showSecret')}
                            onClick={() =>
                              setRevealedSecrets((prev) => ({ ...prev, [revealKey]: !isRevealed }))
                            }
                          >
                            {isRevealed ? <EyeOffIcon size={14} /> : <EyeIcon size={14} />}
                          </button>
                        </div>
                      ) : fullSpan ? (
                        <textarea
                          rows={3}
                          className="tavlo-hooks-textarea"
                          spellCheck={false}
                          value={val}
                          placeholder={placeholder}
                          onChange={(e) => {
                            const nextVal = e.currentTarget.value
                            updateDraft(draft.id, (prev) => ({
                              ...prev,
                              config: { ...prev.config, [field.key]: nextVal },
                            }))
                          }}
                        />
                      ) : (
                        <input
                          type={field.kind === 'number' ? 'number' : 'text'}
                          className="tavlo-hooks-input"
                          spellCheck={false}
                          value={val}
                          placeholder={placeholder}
                          onChange={(e) => {
                            const nextVal = e.currentTarget.value
                            updateDraft(draft.id, (prev) => ({
                              ...prev,
                              config: { ...prev.config, [field.key]: nextVal },
                            }))
                          }}
                        />
                      )}
                    </div>
                  )
                })}
            </div>

            {errText && (
              <div className="tavlo-hooks-inline-result is-error" role="alert">
                {errText}
              </div>
            )}

            <div className="tavlo-hooks-target-footer">
              {draft.isNew && (
                <button
                  type="button"
                  className="tavlo-hooks-btn tavlo-hooks-btn-sm"
                  disabled={isPending}
                  onClick={() => setNewDraft(null)}
                >
                  {t('targetCancelBtn')}
                </button>
              )}
              <button
                type="button"
                className="tavlo-hooks-btn tavlo-hooks-btn-primary tavlo-hooks-btn-sm"
                disabled={busy || isPending}
                onClick={() => void handleSaveTarget(draft)}
              >
                {isPending ? t('saving') : t('targetSaveBtn')}
              </button>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="tavlo-hooks-thirdparty">
      <div className="tavlo-hooks-sub-header">
        <div className="tavlo-hooks-sub-title-group">
          <span className="tavlo-hooks-icon-chip is-blue">
            <BellIcon size={15} />
          </span>
          <div>
            <div className="tavlo-hooks-title-with-pills">
              <h4 className="tavlo-hooks-sub-title">{t('thirdPartyTitle')}</h4>
              <span
                className={`tavlo-hooks-badge ${config.thirdParty.enabled ? 'tavlo-hooks-badge-success' : 'tavlo-hooks-badge-muted'}`}
              >
                {config.thirdParty.enabled ? t('thirdPartyEnabled') : t('thirdPartyPaused')}
              </span>
              <span className="tavlo-hooks-badge tavlo-hooks-badge-mono">
                {totalCount}/{MAX_TARGETS}
              </span>
            </div>
            <p className="tavlo-hooks-helper">{t('thirdPartyPrivacy')}</p>
          </div>
        </div>
        <ToggleSwitch
          checked={config.thirdParty.enabled}
          disabled={busy}
          label={t('thirdPartyTitle')}
          onChange={(next) => void handleMasterToggle(next)}
        />
      </div>

      {!config.thirdParty.enabled && savedTargets.length > 0 && (
        <div className="tavlo-hooks-banner is-muted" role="status">
          {t('thirdPartyPausedBanner')}
        </div>
      )}

      <div className="tavlo-hooks-add-bar">
        <div className="tavlo-hooks-add-select-wrap">
          <PlatformIcon provider={selectedNewProvider} size={18} />
          <select
            className="tavlo-hooks-select"
            aria-label={t('targetProviderLabel')}
            value={selectedNewProvider}
            onChange={(e) => setSelectedNewProvider(e.currentTarget.value as ThirdPartyProviderId)}
          >
            {providerList.map((p) => (
              <option key={p.id} value={p.id}>
                {isZh ? p.labelZh : p.labelEn}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          className="tavlo-hooks-btn tavlo-hooks-btn-primary"
          disabled={busy || totalCount >= MAX_TARGETS || Boolean(newDraft)}
          title={totalCount >= MAX_TARGETS ? t('targetLimitReached') : undefined}
          onClick={handleAddTarget}
        >
          <PlusIcon size={14} />
          <span>{t('thirdPartyAddBtn').replace(/^\+\s*/, '')}</span>
        </button>
      </div>

      <div className="tavlo-hooks-banner is-warn">
        <AlertTriangleIcon size={15} />
        <span>{t('thirdPartyCredNotice')}</span>
      </div>

      <div className="tavlo-hooks-target-list">
        {newDraft && renderTargetCard(newDraft)}
        {savedTargets.map((target) => renderTargetCard(getDraft(target)))}
        {!newDraft && savedTargets.length === 0 && (
          <div className="tavlo-hooks-empty-box">{t('thirdPartyEmpty')}</div>
        )}
      </div>
    </div>
  )
}
