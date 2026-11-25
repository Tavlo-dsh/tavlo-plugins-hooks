import { useCallback, useEffect, useRef, useState } from 'react'
import type { HooksClientApi, LogBus } from '../api.ts'
import { detectIsZh, type TranslateFn } from '../i18n.ts'
import type { HooksPluginState } from '../types.ts'
import { AlertTriangleIcon, RefreshCwIcon, WebhookIcon } from './Icons.tsx'
import { HookMountPointsSection } from './HookMountPointsSection.tsx'
import { NotificationSettingsSection } from './NotificationSettingsSection.tsx'

export interface HookSettingsPageProps {
  t: TranslateFn
  api: HooksClientApi
  logBus: LogBus
  compact?: boolean
  close?: () => void
}

export function HookSettingsPage({ t, api, logBus, compact = false }: HookSettingsPageProps) {
  const [state, setState] = useState<HooksPluginState | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const isZh = detectIsZh(t)

  const loadState = useCallback(async () => {
    setLoading(true)
    setError(null)
    setConflict(false)
    try {
      const res = await api.getState()
      if (!mountedRef.current) return
      if (res.ok) {
        setState(res.value)
      } else {
        setError(res.error?.message || t('loadError'))
      }
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [api, t])

  useEffect(() => {
    void loadState()
  }, [loadState])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 2600)
    return () => clearTimeout(timer)
  }, [notice])

  const handleApplyState = useCallback((partial: Partial<HooksPluginState>) => {
    setState((prev) => {
      if (!prev) return partial as HooksPluginState
      return {
        ...prev,
        ...partial,
      }
    })
    setConflict(false)
  }, [])

  const handleError = useCallback(
    (msg: string | null) => {
      setError(msg)
      if (msg && /conflict|revision/i.test(msg)) {
        setConflict(true)
      }
    },
    [],
  )

  const isWindows =
    state?.isWindows ??
    (typeof navigator !== 'undefined' && /Win/i.test(navigator.platform || navigator.userAgent || ''))

  const enabledMountCount = state
    ? Object.values(state.config.mountPoints ?? {}).filter((m) => m.enabled).length
    : 0
  const totalMountCount = state ? Math.max(state.mountPoints?.length ?? 0, Object.keys(state.config.mountPoints ?? {}).length) : 0
  const activeTargetCount = state
    ? (state.config.thirdParty?.targets ?? []).filter((item) => item.enabled).length
    : 0

  return (
    <div className={`tavlo-hooks-root${compact ? ' is-compact' : ''}`}>
      <header className="tavlo-hooks-page-header">
        <div className="tavlo-hooks-page-title-wrap">
          <span className="tavlo-hooks-hero-badge" aria-hidden="true">
            <WebhookIcon size={20} />
          </span>
          <div>
            <h2 className="tavlo-hooks-page-title">{t('pageTitle')}</h2>
            <p className="tavlo-hooks-page-subtitle">{t('pageSubtitle')}</p>
          </div>
        </div>
        <div className="tavlo-hooks-page-meta">
          {state && (
            <div className="tavlo-hooks-stat-pills">
              <span className="tavlo-hooks-badge tavlo-hooks-badge-blue">
                Hook {enabledMountCount}/{totalMountCount}
              </span>
              {state.config.thirdParty.enabled && activeTargetCount > 0 && (
                <span className="tavlo-hooks-badge tavlo-hooks-badge-success">
                  3rd-Party {activeTargetCount}
                </span>
              )}
            </div>
          )}
          <button
            type="button"
            className="tavlo-hooks-btn tavlo-hooks-btn-sm"
            disabled={loading || busy}
            onClick={() => void loadState()}
          >
            <RefreshCwIcon size={13} />
            <span>{t('refresh')}</span>
          </button>
        </div>
      </header>

      {error && (
        <div className="tavlo-hooks-banner is-error" role="alert">
          <AlertTriangleIcon size={15} />
          <span className="tavlo-hooks-banner-text">{conflict ? t('conflictError') : error}</span>
          <button
            type="button"
            className="tavlo-hooks-btn tavlo-hooks-btn-xs"
            onClick={() => void loadState()}
          >
            {conflict ? t('reload') : t('retry')}
          </button>
        </div>
      )}

      {notice && !error && (
        <div className="tavlo-hooks-banner is-success" role="status">
          <span>{notice}</span>
        </div>
      )}

      {loading && !state ? (
        <div className="tavlo-hooks-loading-card" role="status">
          <span>{t('loading')}</span>
        </div>
      ) : state ? (
        <div className="tavlo-hooks-sections" aria-busy={busy}>
          <NotificationSettingsSection
            t={t}
            isZh={isZh}
            isWindows={Boolean(isWindows)}
            config={state.config}
            customSound={state.customSound}
            providers={state.providers}
            categories={state.categories}
            revision={state.revision}
            busy={busy}
            api={api}
            onApplyState={handleApplyState}
            onError={(msg) => {
              setBusy(false)
              handleError(msg)
            }}
            onNotice={setNotice}
          />

          <HookMountPointsSection
            t={t}
            isZh={isZh}
            config={state.config}
            mountPoints={state.mountPoints}
            categories={state.categories}
            logs={state.logs}
            revision={state.revision}
            busy={busy}
            api={api}
            logBus={logBus}
            onApplyState={handleApplyState}
            onError={handleError}
            onNotice={setNotice}
          />
        </div>
      ) : null}
    </div>
  )
}
