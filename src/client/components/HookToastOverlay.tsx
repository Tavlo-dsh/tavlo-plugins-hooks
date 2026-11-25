import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { HooksClientApi, LogBus } from '../api.ts'
import type { TranslateFn } from '../i18n.ts'
import type { ExecutionLogEntry, HookToastNotification } from '../types.ts'
import { XIcon } from './Icons.tsx'

export interface HookToastOverlayProps {
  t: TranslateFn
  api: HooksClientApi
  logBus?: LogBus
  openSession?: (sessionId: string) => void
}

interface ActiveToast extends HookToastNotification {
  receivedAt: number
}

const MAX_VISIBLE_TOASTS = 5

function clampSeconds(raw: unknown): number {
  const num = Number(raw)
  if (!Number.isFinite(num)) return 60
  return Math.min(3600, Math.max(5, Math.round(num)))
}

function resolveSoundUrl(url: string): string {
  const clean = url.startsWith('/') ? url.slice(1) : url
  const sep = clean.includes('?') ? '&' : '?'
  return `${clean}${sep}ts=${Date.now()}`
}

export function HookToastOverlay({ t, api, logBus, openSession }: HookToastOverlayProps) {
  const [toasts, setToasts] = useState<ActiveToast[]>([])
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const openSessionRef = useRef(openSession)
  openSessionRef.current = openSession

  const removeToast = (id: string) => {
    const existing = timersRef.current.get(id)
    if (existing) {
      clearTimeout(existing)
      timersRef.current.delete(id)
    }
    setToasts((prev) => prev.filter((item) => item.id !== id))
  }

  useEffect(() => {
    const clientId = api.getClientId()

    const reportFocus = (focusedOverride?: boolean) => {
      if (typeof document === 'undefined') return
      const focused = typeof focusedOverride === 'boolean' ? focusedOverride : document.hasFocus()
      const visible = document.visibilityState === 'visible'
      void api.postClientState({ clientId, focused, visible })
    }

    reportFocus()

    const onFocus = () => reportFocus(true)
    const onBlur = () => reportFocus(false)
    const onVisibility = () => reportFocus()
    const onPageHide = () => {
      void api.postClientState({ clientId, focused: false, visible: false, closing: true })
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('focus', onFocus)
      window.addEventListener('blur', onBlur)
      window.addEventListener('pagehide', onPageHide)
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility)
    }
    const heartbeat = setInterval(() => reportFocus(), 30000)

    const unsubscribe = api.subscribeEvents({
      onNotification(payload) {
        if (!payload || !payload.id) return
        const toastId = String(payload.id)

        setToasts((prev) => {
          const withoutSame = prev.filter((item) => item.id !== toastId)
          return [{ ...payload, id: toastId, receivedAt: Date.now() }, ...withoutSame].slice(0, MAX_VISIBLE_TOASTS)
        })

        const oldTimer = timersRef.current.get(toastId)
        if (oldTimer) {
          clearTimeout(oldTimer)
          timersRef.current.delete(toastId)
        }
        if (payload.autoCloseEnabled !== false) {
          const ms = clampSeconds(payload.autoCloseSeconds) * 1000
          const timer = setTimeout(() => {
            removeToast(toastId)
          }, ms)
          timersRef.current.set(toastId, timer)
        }

        if (payload.playWebAudio && payload.soundUrl && typeof Audio !== 'undefined') {
          try {
            const audio = new Audio(resolveSoundUrl(payload.soundUrl))
            void audio.play().catch(() => {})
          } catch {
            // Ignore autoplay restriction
          }
        }

        if (
          payload.shouldWebNotify &&
          !payload.hostSystemNotified &&
          !payload.systemNotified &&
          typeof window !== 'undefined' &&
          'Notification' in window &&
          window.Notification.permission === 'granted'
        ) {
          try {
            const osNotice = new window.Notification(payload.title || 'DSH Hook', {
              body: payload.summary || payload.body || '',
              tag: toastId,
            })
            osNotice.onclick = () => {
              try { window.focus() } catch { /* ignore */ }
              if (payload.sessionId) openSessionRef.current?.(payload.sessionId)
              osNotice.close()
            }
          } catch {
            // Ignore browser notification failure
          }
        }
      },
      onDismiss(payload) {
        if (!payload) return
        setToasts((prev) => {
          const kept: ActiveToast[] = []
          for (const item of prev) {
            const matchId = payload.id && item.id === payload.id
            const matchApproval = payload.approvalId && item.approvalId === payload.approvalId
            if (matchId || matchApproval) {
              const timer = timersRef.current.get(item.id)
              if (timer) {
                clearTimeout(timer)
                timersRef.current.delete(item.id)
              }
            } else {
              kept.push(item)
            }
          }
          return kept
        })
      },
      onLogs(payload) {
        if (!logBus) return
        const entries = Array.isArray(payload) ? payload : Array.isArray(payload?.logs) ? payload.logs : null
        if (entries) logBus.publish(entries as ExecutionLogEntry[])
      },
    })

    const timers = timersRef.current
    return () => {
      unsubscribe()
      clearInterval(heartbeat)
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', onFocus)
        window.removeEventListener('blur', onBlur)
        window.removeEventListener('pagehide', onPageHide)
      }
      void api.postClientState({ clientId, focused: false, visible: false, closing: true })
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility)
      }
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    }
  }, [api, logBus])

  if (toasts.length === 0 || typeof document === 'undefined') {
    return null
  }

  return createPortal(
    <div className="tavlo-hooks-toast-stack" role="region" aria-label={t('inAppTitle')} aria-live="polite">
      {toasts.map((toast) => {
        const variant = toast.variant ?? 'info'
        const sourceLabel = toast.sessionTitle || toast.project
        const actionLabel = variant === 'approval' || variant === 'attention' ? t('toastHandleAction') : t('toastJumpSession')
        return (
          <div key={toast.id} className="tavlo-hooks-toast-card" data-variant={variant} role="status">
            <div className="tavlo-hooks-toast-accent" aria-hidden="true" />
            <div className="tavlo-hooks-toast-body">
              <div className="tavlo-hooks-toast-head">
                <div className="tavlo-hooks-toast-eyebrow">
                  {toast.icon && <span aria-hidden="true">{toast.icon}</span>}
                  <span>{toast.eventLabel || t('toastEyebrow')}</span>
                  {toast.hookPoint && <span className="tavlo-hooks-toast-point">{toast.hookPoint}</span>}
                </div>
                <button
                  type="button"
                  className="tavlo-hooks-icon-btn"
                  aria-label={t('toastDismiss')}
                  onClick={() => removeToast(toast.id)}
                >
                  <XIcon size={14} />
                </button>
              </div>
              <div className="tavlo-hooks-toast-title">{toast.title}</div>
              {sourceLabel && (
                <div className="tavlo-hooks-toast-source">
                  {t('toastFromPrefix')}
                  <span>{sourceLabel}</span>
                </div>
              )}
              {(toast.summary || toast.body) && (
                <div className="tavlo-hooks-toast-summary">{toast.summary || toast.body}</div>
              )}
              {toast.sessionId && openSession && (
                <div className="tavlo-hooks-toast-actions">
                  <button
                    type="button"
                    className="tavlo-hooks-btn tavlo-hooks-btn-primary tavlo-hooks-btn-xs"
                    onClick={() => {
                      openSession(toast.sessionId!)
                      removeToast(toast.id)
                    }}
                  >
                    {actionLabel}
                  </button>
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>,
    document.body,
  )
}
