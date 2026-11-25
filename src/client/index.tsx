import './styles.css'
import { createHooksApi, createLogBus, type ConnectionLike } from './api.ts'
import { EN, LOCALE_NS, ZH, type TranslateFn } from './i18n.ts'
import { HookSettingsPage } from './components/HookSettingsPage.tsx'
import { HookToastOverlay } from './components/HookToastOverlay.tsx'
import { WebhookIcon } from './components/Icons.tsx'

declare const __TAVLO_HOOKS_CSS__: string | undefined

interface ClientContextLike {
  effect(run: () => void | (() => void), label?: string): void
  get?(name: string): unknown
  locale: {
    register(ns: string, langOrDict: string | Record<string, unknown>, dict?: Record<string, string>): () => void
    bind(ns: string): TranslateFn
  }
  slots: {
    inject(name: string, add: () => unknown): void
    register(options: Record<string, unknown>, component: unknown): unknown
  }
  connection?: ConnectionLike
}

const SECTION_ID = 'tavlo-hooks.settings'
const OVERLAY_ID = 'tavlo-hooks.toast-overlay'
const PACKAGE_NAME = '@tavlo-dsh/dsh-plugin-hooks'

function HookSectionNavIcon({ size = 16, active }: { size?: number; active?: boolean }) {
  return (
    <span
      className="tavlo-hooks-nav-icon"
      data-active={active ? 'true' : 'false'}
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <WebhookIcon size={size} />
    </span>
  )
}

export const inject = ['slots', 'locale', 'connection']

export function apply(ctx: ClientContextLike): void {
  ctx.effect(() => ctx.locale.register(LOCALE_NS, 'en', EN), 'tavlo-hooks: en locale')
  ctx.effect(() => ctx.locale.register(LOCALE_NS, 'zh', ZH), 'tavlo-hooks: zh locale')

  const t = ctx.locale.bind(LOCALE_NS)
  const api = createHooksApi(ctx.connection)
  const logBus = createLogBus()

  ctx.effect(() => {
    if (typeof document === 'undefined') return
    const cssText = typeof __TAVLO_HOOKS_CSS__ === 'string' ? __TAVLO_HOOKS_CSS__ : ''
    if (!cssText) return
    const style = document.createElement('style')
    style.dataset.tavloHooksStyle = 'true'
    style.textContent = cssText
    document.head.appendChild(style)
    return () => {
      style.remove()
    }
  }, 'tavlo-hooks: scoped styles')

  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: SECTION_ID,
        order: 45,
        label: () => t('nav'),
        inject: () => ({ t, api, logBus }),
      },
      HookSettingsPage,
    ),
  )

  ctx.slots.inject('settings.section.icon', () =>
    ctx.slots.register(
      {
        name: 'settings.section.icon',
        id: SECTION_ID,
      },
      HookSectionNavIcon,
    ),
  )

  ctx.slots.inject('plugins.bundle.config', () =>
    ctx.slots.register(
      {
        name: 'plugins.bundle.config',
        key: PACKAGE_NAME,
        locale: LOCALE_NS,
      },
      ({ t: slotT, view }: { t?: TranslateFn; view?: 'summary' | 'page' }) => {
        if (view !== 'page') return null
        return <HookSettingsPage t={slotT ?? t} api={api} logBus={logBus} compact />
      },
    ),
  )

  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: OVERLAY_ID,
        inject: () => ({
          t,
          api,
          logBus,
          openSession: (sessionId: string) => {
            const ws = ctx.get?.('uiWorkspace') as { openSession?: (id: string) => void } | undefined
            ws?.openSession?.(sessionId)
          },
        }),
      },
      HookToastOverlay,
    ),
  )
}
