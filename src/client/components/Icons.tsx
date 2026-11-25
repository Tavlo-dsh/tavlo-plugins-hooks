import type { CSSProperties, ReactNode } from 'react'
import type { ThirdPartyProviderId } from '../types.ts'

export interface IconProps {
  size?: number
  className?: string
  style?: CSSProperties
}

function Svg({
  size = 16,
  className,
  style,
  children,
}: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
      style={{ flexShrink: 0, display: 'inline-block', ...style }}
    >
      {children}
    </svg>
  )
}

export function WebhookIcon({ size = 16, className, style }: IconProps) {
  return (
    <Svg size={size} className={className} style={style}>
      <path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2" />
      <path d="m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06" />
      <path d="m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8" />
    </Svg>
  )
}

export function BellIcon({ size = 16, className, style }: IconProps) {
  return (
    <Svg size={size} className={className} style={style}>
      <path d="M10.268 21a2 2 0 0 0 3.464 0" />
      <path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" />
    </Svg>
  )
}

export function BellOffIcon({ size = 16, className, style }: IconProps) {
  return (
    <Svg size={size} className={className} style={style}>
      <path d="M10.268 21a2 2 0 0 0 3.464 0" />
      <path d="M17 17H4a1 1 0 0 1-.74-1.673C4.59 13.956 6 12.499 6 8a6 6 0 0 1 .258-1.742" />
      <path d="m2 2 20 20" />
      <path d="M8.668 3.01A6 6 0 0 1 18 8c0 2.687.77 4.653 1.707 6.05" />
    </Svg>
  )
}

export function Volume2Icon({ size = 16, className, style }: IconProps) {
  return (
    <Svg size={size} className={className} style={style}>
      <path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z" />
      <path d="M16 9a5 5 0 0 1 0 6" />
      <path d="M19.364 18.364a9 9 0 0 0 0-12.728" />
    </Svg>
  )
}

export function PlayIcon({ size = 14, className, style }: IconProps) {
  return (
    <Svg size={size} className={className} style={style}>
      <polygon points="6 3 20 12 6 21 6 3" />
    </Svg>
  )
}

export function TrashIcon({ size = 15, className, style }: IconProps) {
  return (
    <Svg size={size} className={className} style={style}>
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    </Svg>
  )
}

export function UploadIcon({ size = 15, className, style }: IconProps) {
  return (
    <Svg size={size} className={className} style={style}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" x2="12" y1="3" y2="15" />
    </Svg>
  )
}

export function FileCodeIcon({ size = 15, className, style }: IconProps) {
  return (
    <Svg size={size} className={className} style={style}>
      <path d="M10 12.5 8 15l2 2.5" />
      <path d="m14 12.5 2 2.5-2 2.5" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z" />
    </Svg>
  )
}

export function RotateCcwIcon({ size = 15, className, style }: IconProps) {
  return (
    <Svg size={size} className={className} style={style}>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </Svg>
  )
}

export function TerminalIcon({ size = 15, className, style }: IconProps) {
  return (
    <Svg size={size} className={className} style={style}>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" x2="20" y1="19" y2="19" />
    </Svg>
  )
}

export function ChevronDownIcon({ size = 16, className, style }: IconProps) {
  return (
    <Svg size={size} className={className} style={style}>
      <path d="m6 9 6 6 6-6" />
    </Svg>
  )
}

export function ChevronRightIcon({ size = 16, className, style }: IconProps) {
  return (
    <Svg size={size} className={className} style={style}>
      <path d="m9 18 6-6-6-6" />
    </Svg>
  )
}

export function PlusIcon({ size = 15, className, style }: IconProps) {
  return (
    <Svg size={size} className={className} style={style}>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </Svg>
  )
}

export function EyeIcon({ size = 15, className, style }: IconProps) {
  return (
    <Svg size={size} className={className} style={style}>
      <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  )
}

export function EyeOffIcon({ size = 15, className, style }: IconProps) {
  return (
    <Svg size={size} className={className} style={style}>
      <path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" />
      <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
      <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" />
      <path d="m2 2 20 20" />
    </Svg>
  )
}

export function CheckIcon({ size = 14, className, style }: IconProps) {
  return (
    <Svg size={size} className={className} style={style}>
      <path d="M20 6 9 17l-5-5" />
    </Svg>
  )
}

export function AlertTriangleIcon({ size = 15, className, style }: IconProps) {
  return (
    <Svg size={size} className={className} style={style}>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </Svg>
  )
}

export function XIcon({ size = 15, className, style }: IconProps) {
  return (
    <Svg size={size} className={className} style={style}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </Svg>
  )
}

export function RefreshCwIcon({ size = 14, className, style }: IconProps) {
  return (
    <Svg size={size} className={className} style={style}>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </Svg>
  )
}

export function MonitorIcon({ size = 15, className, style }: IconProps) {
  return (
    <Svg size={size} className={className} style={style}>
      <rect width="20" height="14" x="2" y="3" rx="2" />
      <line x1="8" x2="16" y1="21" y2="21" />
      <line x1="12" x2="12" y1="17" y2="21" />
    </Svg>
  )
}

export function SendIcon({ size = 14, className, style }: IconProps) {
  return (
    <Svg size={size} className={className} style={style}>
      <path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" />
      <path d="m21.854 2.147-10.94 10.939" />
    </Svg>
  )
}

export function CopyIcon({ size = 14, className, style }: IconProps) {
  return (
    <Svg size={size} className={className} style={style}>
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </Svg>
  )
}

export function ToggleSwitch({
  checked,
  onChange,
  label,
  disabled = false,
  title,
  compact = false,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
  title?: string
  compact?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      className={`tavlo-hooks-switch${compact ? ' is-compact' : ''}`}
      data-checked={checked ? 'true' : 'false'}
      onClick={(e) => {
        e.stopPropagation()
        if (!disabled) onChange(!checked)
      }}
    >
      <span className="tavlo-hooks-switch-thumb" aria-hidden="true" />
    </button>
  )
}

const PROVIDER_COLORS: Record<ThirdPartyProviderId, { bg: string; fg: string; label: string }> = {
  bark: { bg: '#ef4444', fg: '#fff', label: 'BK' },
  dingtalk: { bg: '#0089ff', fg: '#fff', label: '钉' },
  feishu: { bg: '#00d6b9', fg: '#063b36', label: '飞' },
  telegram: { bg: '#26a5e4', fg: '#fff', label: 'TG' },
  wecom: { bg: '#2b7de9', fg: '#fff', label: '企' },
  pushplus: { bg: '#10b981', fg: '#fff', label: 'P+' },
  wxpusher: { bg: '#07c160', fg: '#fff', label: 'Wx' },
  serverchan: { bg: '#f59e0b', fg: '#fff', label: '酱' },
  ntfy: { bg: '#317f6f', fg: '#fff', label: 'nt' },
  gotify: { bg: '#6366f1', fg: '#fff', label: 'Go' },
  custom: { bg: '#64748b', fg: '#fff', label: '{}' },
}

export function PlatformIcon({
  provider,
  size = 18,
}: {
  provider: ThirdPartyProviderId | string
  size?: number
}) {
  const palette = PROVIDER_COLORS[provider as ThirdPartyProviderId] ?? PROVIDER_COLORS.custom
  return (
    <span
      aria-hidden="true"
      className="tavlo-hooks-platform-glyph"
      style={{
        width: size,
        height: size,
        borderRadius: Math.max(4, Math.round(size * 0.28)),
        background: palette.bg,
        color: palette.fg,
        fontSize: Math.max(9, Math.round(size * 0.52)),
      }}
    >
      {palette.label}
    </span>
  )
}
