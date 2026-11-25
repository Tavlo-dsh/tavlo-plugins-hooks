import { useEffect, useRef, useState } from 'react'
import type { HooksClientApi } from '../api.ts'
import type { TranslateFn } from '../i18n.ts'
import type {
  CategoryMeta,
  CustomSoundInfo,
  HooksConfig,
  NotificationCategory,
  ProviderDefinition,
} from '../types.ts'
import {
  BellIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  MonitorIcon,
  PlayIcon,
  ToggleSwitch,
  TrashIcon,
  UploadIcon,
  Volume2Icon,
} from './Icons.tsx'
import { ThirdPartySection } from './ThirdPartySection.tsx'

export interface NotificationSettingsSectionProps {
  t: TranslateFn
  isZh: boolean
  isWindows: boolean
  config: HooksConfig
  customSound?: CustomSoundInfo | null
  providers?: ProviderDefinition[]
  categories?: Record<NotificationCategory, CategoryMeta>
  revision: number
  busy: boolean
  api: HooksClientApi
  onApplyState: (nextState: { revision: number; config: HooksConfig; customSound?: CustomSoundInfo | null }) => void
  onError: (msg: string | null) => void
  onNotice: (msg: string | null) => void
}

const MAX_WAV_BYTES = 20 * 1024 * 1024

export function NotificationSettingsSection({
  t,
  isZh,
  isWindows,
  config,
  customSound,
  providers,
  categories,
  revision,
  busy,
  api,
  onApplyState,
  onError,
  onNotice,
}: NotificationSettingsSectionProps) {
  const [expanded, setExpanded] = useState(true)
  const [autoCloseInput, setAutoCloseInput] = useState(String(config.inApp.autoCloseSeconds ?? 60))
  const [flashCountInput, setFlashCountInput] = useState(String(config.systemNotifications.taskbarAttentionFlashCount ?? 5))
  const [sysTestStatus, setSysTestStatus] = useState<{ ok: boolean; msg: string } | null>(null)
  const [taskbarTestStatus, setTaskbarTestStatus] = useState<{ ok: boolean; msg: string } | null>(null)
  const [soundStatus, setSoundStatus] = useState<{ ok: boolean; msg: string } | null>(null)
  const [uploadingSound, setUploadingSound] = useState(false)
  const [testingSystem, setTestingSystem] = useState(false)
  const [testingTaskbar, setTestingTaskbar] = useState(false)
  const [webPerm, setWebPerm] = useState<string>(() =>
    typeof window !== 'undefined' && 'Notification' in window ? window.Notification.permission : 'granted',
  )
  const soundFileInputRef = useRef<HTMLInputElement>(null)
  const previewAudioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    return () => {
      previewAudioRef.current?.pause()
      previewAudioRef.current = null
    }
  }, [])

  useEffect(() => {
    setAutoCloseInput(String(config.inApp.autoCloseSeconds ?? 60))
  }, [config.inApp.autoCloseSeconds])

  useEffect(() => {
    setFlashCountInput(String(config.systemNotifications.taskbarAttentionFlashCount ?? 5))
  }, [config.systemNotifications.taskbarAttentionFlashCount])

  const savePatch = async (patch: Record<string, unknown>) => {
    onError(null)
    const res = await api.saveSettings(patch, revision)
    if (res.ok) {
      onApplyState(res.value)
    } else {
      onError(res.error?.message || t('actionError'))
    }
  }

  const commitAutoCloseSeconds = () => {
    const parsed = Math.round(Number(autoCloseInput))
    const clamped = Number.isFinite(parsed) ? Math.min(3600, Math.max(5, parsed)) : 60
    setAutoCloseInput(String(clamped))
    if (clamped !== config.inApp.autoCloseSeconds) {
      void savePatch({ inApp: { autoCloseSeconds: clamped } })
    }
  }

  const commitFlashCount = (nextValue?: number) => {
    const raw = nextValue ?? Math.round(Number(flashCountInput))
    const clamped = Number.isFinite(raw) ? Math.min(20, Math.max(1, raw)) : 5
    setFlashCountInput(String(clamped))
    if (clamped !== config.systemNotifications.taskbarAttentionFlashCount) {
      void savePatch({ systemNotifications: { taskbarAttentionFlashCount: clamped } })
    }
  }

  const handleTestSystem = async () => {
    setTestingSystem(true)
    setSysTestStatus(null)
    try {
      const res = await api.testSystemNotification()
      if (res.ok && res.value?.ok !== false) {
        setSysTestStatus({ ok: true, msg: t('testSystemSent') })
      } else {
        setSysTestStatus({ ok: false, msg: res.error?.message || res.value?.error || t('testSystemFailed') })
      }
    } finally {
      setTestingSystem(false)
    }
  }

  const handleTestTaskbar = async () => {
    setTestingTaskbar(true)
    setTaskbarTestStatus(null)
    try {
      const res = await api.testTaskbarFlash({
        mode: config.systemNotifications.taskbarAttentionMode,
        flashCount: config.systemNotifications.taskbarAttentionFlashCount,
      })
      if (res.ok && res.value?.ok !== false) {
        setTaskbarTestStatus({ ok: true, msg: t('testTaskbarSent') })
      } else {
        setTaskbarTestStatus({ ok: false, msg: res.error?.message || res.value?.error || t('testTaskbarFailed') })
      }
    } finally {
      setTestingTaskbar(false)
    }
  }

  const handleSoundFileChange = async (file: File | undefined) => {
    if (!file) return
    setSoundStatus(null)
    if (!/\.wav$/i.test(file.name) || file.size < 12 || file.size > MAX_WAV_BYTES) {
      setSoundStatus({ ok: false, msg: t('soundInvalidFile') })
      return
    }
    setUploadingSound(true)
    try {
      const res = await api.uploadCustomSound(file, revision)
      if (res.ok) {
        onApplyState(res.value)
        setSoundStatus({ ok: true, msg: t('saved') })
      } else {
        setSoundStatus({ ok: false, msg: res.error?.message || t('soundUploadFailed') })
      }
    } finally {
      setUploadingSound(false)
      if (soundFileInputRef.current) soundFileInputRef.current.value = ''
    }
  }

  const handleClearSound = async () => {
    setSoundStatus(null)
    const res = await api.clearCustomSound(revision)
    if (res.ok) {
      onApplyState(res.value)
    } else {
      setSoundStatus({ ok: false, msg: res.error?.message || t('actionError') })
    }
  }

  const handlePreviewSound = () => {
    setSoundStatus(null)
    try {
      previewAudioRef.current?.pause()
      const audio = new Audio(api.getSoundPreviewUrl())
      previewAudioRef.current = audio
      void audio.play().catch(() => {
        setSoundStatus({ ok: false, msg: t('soundPreviewFailed') })
      })
    } catch {
      setSoundStatus({ ok: false, msg: t('soundPreviewFailed') })
    }
  }

  const handleRequestBrowserPerm = async () => {
    if (typeof window === 'undefined' || !('Notification' in window)) return
    try {
      const next = await window.Notification.requestPermission()
      setWebPerm(next)
    } catch {
      // ignore
    }
  }

  const activeSoundName = customSound?.filename || config.systemNotifications.customSoundFilename

  return (
    <section className="tavlo-hooks-card">
      <button
        type="button"
        className="tavlo-hooks-card-header"
        aria-expanded={expanded}
        onClick={() => setExpanded((prev) => !prev)}
      >
        <div className="tavlo-hooks-card-header-left">
          <span className="tavlo-hooks-icon-chip is-blue">
            <BellIcon size={17} />
          </span>
          <div className="tavlo-hooks-card-titles">
            <h3>{t('notificationsTitle')}</h3>
            <p>{t('notificationsSubtitle')}</p>
          </div>
        </div>
        <span className="tavlo-hooks-chevron" aria-hidden="true">
          {expanded ? <ChevronDownIcon size={17} /> : <ChevronRightIcon size={17} />}
        </span>
      </button>

      {expanded && (
        <div className="tavlo-hooks-card-body">
          {/* 1. In-App Notifications */}
          <div className="tavlo-hooks-setting-block">
            <div className="tavlo-hooks-row">
              <div className="tavlo-hooks-row-text">
                <div className="tavlo-hooks-row-title">{t('inAppTitle')}</div>
                <div className="tavlo-hooks-helper">{t('inAppDesc')}</div>
              </div>
              <ToggleSwitch
                checked={config.inApp.enabled}
                disabled={busy}
                label={t('inAppEnabled')}
                onChange={(next) => void savePatch({ inApp: { enabled: next } })}
              />
            </div>

            {config.inApp.enabled && (
              <div className="tavlo-hooks-subpanel">
                <div className="tavlo-hooks-row">
                  <div className="tavlo-hooks-row-text">
                    <div className="tavlo-hooks-row-title-sm">{t('inAppAutoClose')}</div>
                    <div className="tavlo-hooks-helper">{t('inAppAutoCloseHint')}</div>
                  </div>
                  <ToggleSwitch
                    checked={config.inApp.autoCloseEnabled}
                    disabled={busy}
                    label={t('inAppAutoClose')}
                    onChange={(next) => void savePatch({ inApp: { autoCloseEnabled: next } })}
                  />
                </div>
                {config.inApp.autoCloseEnabled && (
                  <div className="tavlo-hooks-inline-field">
                    <label htmlFor="tavlo-hooks-autoclose-sec" className="tavlo-hooks-label">
                      {t('inAppAutoCloseSeconds')}
                    </label>
                    <input
                      id="tavlo-hooks-autoclose-sec"
                      type="number"
                      min={5}
                      max={3600}
                      step={1}
                      className="tavlo-hooks-input tavlo-hooks-input-sm"
                      value={autoCloseInput}
                      onChange={(e) => setAutoCloseInput(e.currentTarget.value)}
                      onBlur={commitAutoCloseSeconds}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          commitAutoCloseSeconds()
                        }
                      }}
                    />
                  </div>
                )}
              </div>
            )}
          </div>

          <hr className="tavlo-hooks-divider" />

          {/* 2. System Notifications */}
          <div className="tavlo-hooks-setting-block">
            <div className="tavlo-hooks-row">
              <div className="tavlo-hooks-row-text tavlo-hooks-row-with-icon">
                <span className="tavlo-hooks-icon-chip is-blue">
                  <BellIcon size={15} />
                </span>
                <div>
                  <div className="tavlo-hooks-row-title">{t('systemNotifyTitle')}</div>
                  <div className="tavlo-hooks-helper">{t('systemNotifyHelper')}</div>
                </div>
              </div>
              <div className="tavlo-hooks-row-controls">
                <button
                  type="button"
                  className="tavlo-hooks-btn tavlo-hooks-btn-sm"
                  disabled={busy || testingSystem}
                  onClick={() => void handleTestSystem()}
                >
                  {testingSystem ? t('testingBtn') : t('testBtn')}
                </button>
                <ToggleSwitch
                  checked={config.systemNotifications.enabled}
                  disabled={busy}
                  label={t('systemNotifyTitle')}
                  onChange={(next) => void savePatch({ systemNotifications: { enabled: next } })}
                />
              </div>
            </div>
            {sysTestStatus && (
              <div className={`tavlo-hooks-inline-result ${sysTestStatus.ok ? 'is-success' : 'is-error'}`} role="status">
                {sysTestStatus.msg}
              </div>
            )}
            {webPerm === 'default' && (
              <div className="tavlo-hooks-perm-bar">
                <span>{t('browserPermissionHint')}</span>
                <button
                  type="button"
                  className="tavlo-hooks-link-btn"
                  onClick={() => void handleRequestBrowserPerm()}
                >
                  {t('browserPermissionGrant')}
                </button>
              </div>
            )}
          </div>

          {/* 3. Windows Taskbar Attention */}
          {isWindows && (
            <>
              <hr className="tavlo-hooks-divider" />
              <div className="tavlo-hooks-setting-block">
                <div className="tavlo-hooks-row">
                  <div className="tavlo-hooks-row-text tavlo-hooks-row-with-icon">
                    <span className="tavlo-hooks-icon-chip">
                      <MonitorIcon size={15} />
                    </span>
                    <div>
                      <div className="tavlo-hooks-row-title">{t('taskbarTitle')}</div>
                      <div className="tavlo-hooks-helper">{t('taskbarHelper')}</div>
                    </div>
                  </div>
                  <div className="tavlo-hooks-row-controls">
                    <button
                      type="button"
                      className="tavlo-hooks-btn tavlo-hooks-btn-sm"
                      disabled={busy || testingTaskbar}
                      onClick={() => void handleTestTaskbar()}
                    >
                      {testingTaskbar ? t('testingBtn') : t('testBtn')}
                    </button>
                    <ToggleSwitch
                      checked={config.systemNotifications.taskbarAttentionEnabled}
                      disabled={busy}
                      label={t('taskbarTitle')}
                      onChange={(next) => void savePatch({ systemNotifications: { taskbarAttentionEnabled: next } })}
                    />
                  </div>
                </div>

                <div className="tavlo-hooks-subpanel tavlo-hooks-taskbar-controls">
                  <div className="tavlo-hooks-field">
                    <span className="tavlo-hooks-label">{t('taskbarModeLabel')}</span>
                    <div className="tavlo-hooks-segmented" role="radiogroup" aria-label={t('taskbarModeLabel')}>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={config.systemNotifications.taskbarAttentionMode === 'finite'}
                        className="tavlo-hooks-seg-btn"
                        data-active={config.systemNotifications.taskbarAttentionMode === 'finite' ? 'true' : 'false'}
                        disabled={busy}
                        onClick={() => void savePatch({ systemNotifications: { taskbarAttentionMode: 'finite' } })}
                      >
                        {t('taskbarModeFinite')}
                      </button>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={config.systemNotifications.taskbarAttentionMode === 'untilFocused'}
                        className="tavlo-hooks-seg-btn"
                        data-active={config.systemNotifications.taskbarAttentionMode === 'untilFocused' ? 'true' : 'false'}
                        disabled={busy}
                        onClick={() => void savePatch({ systemNotifications: { taskbarAttentionMode: 'untilFocused' } })}
                      >
                        {t('taskbarModeUntilFocused')}
                      </button>
                    </div>
                  </div>

                  <div className="tavlo-hooks-field">
                    <label htmlFor="tavlo-hooks-flash-count" className="tavlo-hooks-label">
                      {t('taskbarFlashCountLabel')}
                    </label>
                    <div className="tavlo-hooks-stepper">
                      <button
                        type="button"
                        className="tavlo-hooks-btn tavlo-hooks-btn-sm"
                        disabled={
                          busy ||
                          config.systemNotifications.taskbarAttentionMode !== 'finite' ||
                          config.systemNotifications.taskbarAttentionFlashCount <= 1
                        }
                        onClick={() =>
                          commitFlashCount(config.systemNotifications.taskbarAttentionFlashCount - 1)
                        }
                      >
                        -
                      </button>
                      <input
                        id="tavlo-hooks-flash-count"
                        type="number"
                        min={1}
                        max={20}
                        step={1}
                        className="tavlo-hooks-input tavlo-hooks-input-xs"
                        disabled={busy || config.systemNotifications.taskbarAttentionMode !== 'finite'}
                        value={flashCountInput}
                        onChange={(e) => setFlashCountInput(e.currentTarget.value)}
                        onBlur={() => commitFlashCount()}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            commitFlashCount()
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="tavlo-hooks-btn tavlo-hooks-btn-sm"
                        disabled={
                          busy ||
                          config.systemNotifications.taskbarAttentionMode !== 'finite' ||
                          config.systemNotifications.taskbarAttentionFlashCount >= 20
                        }
                        onClick={() =>
                          commitFlashCount(config.systemNotifications.taskbarAttentionFlashCount + 1)
                        }
                      >
                        +
                      </button>
                    </div>
                  </div>
                </div>

                {taskbarTestStatus && (
                  <div
                    className={`tavlo-hooks-inline-result ${taskbarTestStatus.ok ? 'is-success' : 'is-error'}`}
                    role="status"
                  >
                    {taskbarTestStatus.msg}
                  </div>
                )}
              </div>
            </>
          )}

          <hr className="tavlo-hooks-divider" />

          {/* 4. Custom Notification Sound */}
          <div className="tavlo-hooks-setting-block">
            <div className="tavlo-hooks-row">
              <div className="tavlo-hooks-row-text tavlo-hooks-row-with-icon">
                <span className="tavlo-hooks-icon-chip">
                  <Volume2Icon size={15} />
                </span>
                <div>
                  <div className="tavlo-hooks-title-with-pills">
                    <span className="tavlo-hooks-row-title">{t('soundTitle')}</span>
                    <span className="tavlo-hooks-badge tavlo-hooks-badge-muted">{t('soundFormatBadge')}</span>
                  </div>
                  <div className="tavlo-hooks-helper">{t('soundHelper')}</div>
                </div>
              </div>
              <div className="tavlo-hooks-row-controls">
                <input
                  ref={soundFileInputRef}
                  type="file"
                  accept=".wav,audio/wav"
                  hidden
                  onChange={(e) => void handleSoundFileChange(e.currentTarget.files?.[0])}
                />
                <button
                  type="button"
                  className="tavlo-hooks-btn tavlo-hooks-btn-sm"
                  disabled={busy || uploadingSound}
                  onClick={() => soundFileInputRef.current?.click()}
                >
                  <UploadIcon size={13} />
                  <span>{uploadingSound ? t('soundUploading') : t('soundChoose')}</span>
                </button>
                {activeSoundName && (
                  <button
                    type="button"
                    className="tavlo-hooks-btn tavlo-hooks-btn-sm"
                    disabled={busy}
                    onClick={() => void handleClearSound()}
                  >
                    <TrashIcon size={13} />
                    <span>{t('soundClear')}</span>
                  </button>
                )}
                <button
                  type="button"
                  className="tavlo-hooks-btn tavlo-hooks-btn-sm"
                  disabled={busy || !activeSoundName}
                  onClick={handlePreviewSound}
                >
                  <PlayIcon size={12} />
                  <span>{t('soundPreview')}</span>
                </button>
              </div>
            </div>

            <div className="tavlo-hooks-sound-meta">
              {activeSoundName ? (
                <>
                  <code className="tavlo-hooks-code-pill">{activeSoundName}</code>
                  {customSound?.bytes ? (
                    <span className="tavlo-hooks-helper">{Math.max(1, Math.round(customSound.bytes / 1024))} KB</span>
                  ) : null}
                  <span className="tavlo-hooks-helper">{t('soundSetDesc')}</span>
                </>
              ) : (
                <>
                  <span className="tavlo-hooks-badge tavlo-hooks-badge-muted">{t('soundUnset')}</span>
                  <span className="tavlo-hooks-helper">{t('soundUnsetDesc')}</span>
                </>
              )}
            </div>

            {soundStatus && (
              <div className={`tavlo-hooks-inline-result ${soundStatus.ok ? 'is-success' : 'is-error'}`} role="status">
                {soundStatus.msg}
              </div>
            )}
          </div>

          <hr className="tavlo-hooks-divider" />

          {/* 5. Suppress System Notifications When Focused */}
          <div className="tavlo-hooks-setting-block">
            <div className="tavlo-hooks-row">
              <div className="tavlo-hooks-row-text">
                <div className="tavlo-hooks-row-title">{t('suppressFocusedTitle')}</div>
                <div className="tavlo-hooks-helper">{t('suppressFocusedHelper')}</div>
              </div>
              <ToggleSwitch
                checked={config.systemNotifications.suppressWhenFocused}
                disabled={busy}
                label={t('suppressFocusedTitle')}
                onChange={(next) => void savePatch({ systemNotifications: { suppressWhenFocused: next } })}
              />
            </div>
          </div>

          <hr className="tavlo-hooks-divider" />

          {/* 6. Embedded Third-Party Hook Notifications */}
          <ThirdPartySection
            t={t}
            isZh={isZh}
            config={config}
            providers={providers}
            categories={categories}
            revision={revision}
            busy={busy}
            api={api}
            onApplyState={onApplyState}
            onError={onError}
            onNotice={onNotice}
          />
        </div>
      )}
    </section>
  )
}
