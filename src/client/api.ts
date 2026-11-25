import type {
  ExecutionLogEntry,
  HookToastNotification,
  HooksPluginState,
  RpcResponse,
  ScriptSourceResult,
  TestSendResult,
  ThirdPartyTarget,
} from './types.ts'

export interface ConnectionLike {
  rpc?: {
    call<T = unknown>(prefix: string, method: string, payload: unknown, signal?: AbortSignal): Promise<T>
  }
}

export type RpcOperation =
  | 'getState'
  | 'saveSettings'
  | 'toggleMountPoint'
  | 'toggleMountPointBell'
  | 'toggleScript'
  | 'updateScriptMeta'
  | 'deleteScript'
  | 'resetDefaultScripts'
  | 'testMountPoint'
  | 'testScript'
  | 'getExecutionLogs'
  | 'saveThirdPartyTarget'
  | 'toggleThirdPartyTarget'
  | 'deleteThirdPartyTarget'
  | 'testThirdPartyTarget'
  | 'clearCustomSound'
  | 'testSystemNotification'
  | 'testTaskbarFlash'

export interface HooksClientApi {
  call<T = unknown>(operation: RpcOperation, input?: Record<string, unknown>, timeoutMs?: number): Promise<RpcResponse<T>>
  getState(): Promise<RpcResponse<HooksPluginState>>
  saveSettings(patch: Record<string, unknown>, expectedRevision?: number): Promise<RpcResponse<HooksPluginState>>
  toggleMountPoint(mountPointId: string, enabled: boolean, expectedRevision?: number): Promise<RpcResponse<HooksPluginState>>
  toggleMountPointBell(mountPointId: string, bellEnabled: boolean, expectedRevision?: number): Promise<RpcResponse<HooksPluginState>>
  toggleScript(mountPointId: string, scriptId: string, enabled: boolean, expectedRevision?: number): Promise<RpcResponse<HooksPluginState>>
  updateScriptMeta(
    mountPointId: string,
    scriptId: string,
    patch: { name?: string; matcher?: string; timeoutSeconds?: number },
    expectedRevision?: number,
  ): Promise<RpcResponse<HooksPluginState>>
  deleteScript(mountPointId: string, scriptId: string, expectedRevision?: number): Promise<RpcResponse<HooksPluginState>>
  resetDefaultScripts(expectedRevision?: number): Promise<RpcResponse<HooksPluginState>>
  testMountPoint(mountPointId: string): Promise<RpcResponse<{ ok?: boolean; suppressed?: boolean; elapsedMs?: number; logs?: ExecutionLogEntry[]; state?: HooksPluginState }>>
  testScript(mountPointId: string, scriptId: string): Promise<RpcResponse<{ exitCode?: number | null; elapsedMs?: number; suppressed?: boolean; stdout?: string; stderr?: string; error?: string; logs?: ExecutionLogEntry[] }>>
  getExecutionLogs(): Promise<RpcResponse<{ logs: ExecutionLogEntry[] }>>
  saveThirdPartyTarget(
    target: Partial<ThirdPartyTarget> & { secrets?: Record<string, string> },
    expectedRevision?: number,
  ): Promise<RpcResponse<HooksPluginState>>
  toggleThirdPartyTarget(targetId: string, enabled: boolean, expectedRevision?: number): Promise<RpcResponse<HooksPluginState>>
  deleteThirdPartyTarget(targetId: string, expectedRevision?: number): Promise<RpcResponse<HooksPluginState>>
  testThirdPartyTarget(
    target: Partial<ThirdPartyTarget> & { secrets?: Record<string, string> },
  ): Promise<RpcResponse<TestSendResult>>
  clearCustomSound(expectedRevision?: number): Promise<RpcResponse<HooksPluginState>>
  testSystemNotification(): Promise<RpcResponse<{ ok?: boolean; channel?: string; error?: string }>>
  testTaskbarFlash(overrides?: { mode?: 'finite' | 'untilFocused'; flashCount?: number }): Promise<RpcResponse<{ ok?: boolean; skipped?: boolean; error?: string }>>
  uploadScript(params: {
    mountPointId: string
    file: File
    name?: string
    matcher?: string
    timeoutSeconds?: number
    expectedRevision?: number
  }): Promise<RpcResponse<HooksPluginState & { script?: unknown }>>
  getScriptSource(mountPointId: string, scriptId: string): Promise<RpcResponse<ScriptSourceResult>>
  uploadCustomSound(file: File, expectedRevision?: number): Promise<RpcResponse<HooksPluginState>>
  getSoundPreviewUrl(): string
  postClientState(payload: { clientId: string; focused: boolean; visible: boolean; closing?: boolean }): Promise<void>
  subscribeEvents(handlers: {
    onNotification?: (payload: HookToastNotification) => void
    onDismiss?: (payload: { id?: string; approvalId?: string }) => void
    onLogs?: (payload: { logs?: ExecutionLogEntry[] } | ExecutionLogEntry[]) => void
    onStatus?: (connected: boolean) => void
  }): () => void
  getClientId(): string
}

function normalizeRpcResponse<T>(raw: unknown): RpcResponse<T> {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: { code: 'hooks/malformed', message: 'Malformed response' } }
  }
  const obj = raw as Record<string, unknown>
  if (obj.type === 'server-response' && 'result' in obj) {
    return normalizeRpcResponse<T>(obj.result)
  }
  if (typeof obj.ok === 'boolean') {
    if (obj.ok) {
      return { ok: true, value: ('value' in obj ? obj.value : obj) as T }
    }
    const err = (obj.error && typeof obj.error === 'object' ? obj.error : {}) as { code?: string; message?: string; details?: Record<string, unknown> }
    return { ok: false, error: err }
  }
  if ('revision' in obj && 'config' in obj) {
    return { ok: true, value: obj as unknown as T }
  }
  return { ok: true, value: obj as unknown as T }
}

function createClientId(): string {
  try {
    if (typeof window !== 'undefined' && window.crypto?.randomUUID) {
      return window.crypto.randomUUID()
    }
    if (typeof window !== 'undefined' && window.crypto?.getRandomValues) {
      const bytes = window.crypto.getRandomValues(new Uint8Array(16))
      return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
    }
  } catch {
    // Fallback below
  }
  return `client_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

export function createHooksApi(connection?: ConnectionLike): HooksClientApi {
  const clientId = createClientId()

  async function call<T = unknown>(
    operation: RpcOperation,
    input: Record<string, unknown> = {},
    timeoutMs = 30000,
  ): Promise<RpcResponse<T>> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      if (connection?.rpc?.call) {
        const res = await connection.rpc.call('/api', 'tavlo-hooks/rpc', { operation, input }, controller.signal)
        return normalizeRpcResponse<T>(res)
      }
      const response = await window.fetch('api/tavlo-hooks/rpc', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation, input }),
        signal: controller.signal,
      })
      const json = await response.json().catch(() => null)
      if (!response.ok && !json) {
        return { ok: false, error: { code: `http/${response.status}`, message: `HTTP ${response.status}` } }
      }
      return normalizeRpcResponse<T>(json)
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'hooks/network',
          message: error instanceof Error ? error.message : String(error),
        },
      }
    } finally {
      clearTimeout(timer)
    }
  }

  async function uploadScript(params: {
    mountPointId: string
    file: File
    name?: string
    matcher?: string
    timeoutSeconds?: number
    expectedRevision?: number
  }): Promise<RpcResponse<HooksPluginState & { script?: unknown }>> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 45000)
    try {
      const qs = new URLSearchParams({
        mountPointId: params.mountPointId,
        filename: params.file.name,
      })
      if (params.name) qs.set('name', params.name)
      if (params.matcher !== undefined) qs.set('matcher', params.matcher)
      if (params.timeoutSeconds !== undefined) qs.set('timeoutSeconds', String(params.timeoutSeconds))
      if (params.expectedRevision !== undefined) qs.set('expectedRevision', String(params.expectedRevision))
      const response = await window.fetch(`api/tavlo-hooks/scripts/upload?${qs.toString()}`, {
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'error',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: params.file,
        signal: controller.signal,
      })
      const json = await response.json().catch(() => null)
      if (!response.ok && !json) {
        return { ok: false, error: { code: `http/${response.status}`, message: `HTTP ${response.status}` } }
      }
      return normalizeRpcResponse<HooksPluginState & { script?: unknown }>(json)
    } catch (error) {
      return {
        ok: false,
        error: { code: 'hooks/upload-failed', message: error instanceof Error ? error.message : String(error) },
      }
    } finally {
      clearTimeout(timer)
    }
  }

  async function getScriptSource(mountPointId: string, scriptId: string): Promise<RpcResponse<ScriptSourceResult>> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20000)
    try {
      const qs = new URLSearchParams({ mountPointId, scriptId })
      const response = await window.fetch(`api/tavlo-hooks/scripts/source?${qs.toString()}`, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
      })
      const json = await response.json().catch(() => null)
      if (!response.ok && !json) {
        return { ok: false, error: { code: `http/${response.status}`, message: `HTTP ${response.status}` } }
      }
      return normalizeRpcResponse<ScriptSourceResult>(json)
    } catch (error) {
      return {
        ok: false,
        error: { code: 'hooks/source-failed', message: error instanceof Error ? error.message : String(error) },
      }
    } finally {
      clearTimeout(timer)
    }
  }

  async function uploadCustomSound(file: File, expectedRevision?: number): Promise<RpcResponse<HooksPluginState>> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 45000)
    try {
      const qs = new URLSearchParams({ filename: file.name })
      if (expectedRevision !== undefined) qs.set('expectedRevision', String(expectedRevision))
      const response = await window.fetch(`api/tavlo-hooks/sound/upload?${qs.toString()}`, {
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'error',
        headers: { 'Content-Type': 'audio/wav' },
        body: file,
        signal: controller.signal,
      })
      const json = await response.json().catch(() => null)
      if (!response.ok && !json) {
        return { ok: false, error: { code: `http/${response.status}`, message: `HTTP ${response.status}` } }
      }
      return normalizeRpcResponse<HooksPluginState>(json)
    } catch (error) {
      return {
        ok: false,
        error: { code: 'hooks/sound-upload-failed', message: error instanceof Error ? error.message : String(error) },
      }
    } finally {
      clearTimeout(timer)
    }
  }

  async function postClientState(payload: { clientId: string; focused: boolean; visible: boolean; closing?: boolean }): Promise<void> {
    try {
      await window.fetch('api/tavlo-hooks/client-state', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    } catch {
      // Best-effort presence signal
    }
  }

  function subscribeEvents(handlers: {
    onNotification?: (payload: HookToastNotification) => void
    onDismiss?: (payload: { id?: string; approvalId?: string }) => void
    onLogs?: (payload: { logs?: ExecutionLogEntry[] } | ExecutionLogEntry[]) => void
    onStatus?: (connected: boolean) => void
  }): () => void {
    let disposed = false
    let suspended = false
    let streamController: AbortController | undefined
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    let retryDelay = 1000

    async function connect(): Promise<void> {
      if (disposed || suspended || streamController) return
      const startedAt = Date.now()
      const controller = new AbortController()
      streamController = controller
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      let watchdog: ReturnType<typeof setTimeout> | undefined

      const resetWatchdog = () => {
        if (watchdog) clearTimeout(watchdog)
        watchdog = setTimeout(() => controller.abort(), 90000)
      }
      resetWatchdog()

      try {
        const response = await window.fetch('api/tavlo-hooks/events', {
          method: 'GET',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { accept: 'text/event-stream' },
          signal: controller.signal,
        })
        if (disposed || controller.signal.aborted) {
          await response.body?.cancel().catch(() => {})
          return
        }
        const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
        if (!response.ok || contentType !== 'text/event-stream' || !response.body) {
          throw new Error('SSE stream unavailable')
        }
        handlers.onStatus?.(true)
        reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        while (!disposed && !controller.signal.aborted) {
          const { done, value } = await reader.read()
          if (done) throw new Error('SSE stream closed')
          if (disposed || controller.signal.aborted) break
          resetWatchdog()
          buffer += decoder.decode(value, { stream: true })
          if (buffer.length > 4 * 1024 * 1024) throw new Error('SSE buffer overflow')

          let match: RegExpExecArray | null
          while (!disposed && !controller.signal.aborted && (match = /\r?\n\r?\n/.exec(buffer))) {
            const frame = buffer.slice(0, match.index)
            buffer = buffer.slice(match.index + match[0].length)
            let eventName = 'message'
            const dataLines: string[] = []
            for (const line of frame.split(/\r?\n/)) {
              if (!line || line.startsWith(':')) continue
              if (line.startsWith('event:')) {
                eventName = line.slice(6).trim()
              } else if (line.startsWith('data:')) {
                dataLines.push(line.slice(5).replace(/^ /, ''))
              }
            }
            if (!dataLines.length) continue
            const rawData = dataLines.join('\n')
            let parsed: unknown
            try {
              parsed = JSON.parse(rawData)
            } catch {
              continue
            }
            if (eventName === 'notification') {
              handlers.onNotification?.(parsed as HookToastNotification)
            } else if (eventName === 'dismiss') {
              handlers.onDismiss?.(parsed as { id?: string; approvalId?: string })
            } else if (eventName === 'logs') {
              handlers.onLogs?.(parsed as { logs?: ExecutionLogEntry[] } | ExecutionLogEntry[])
            }
          }
        }
      } catch {
        if (!disposed) handlers.onStatus?.(false)
      } finally {
        if (watchdog) clearTimeout(watchdog)
        controller.abort()
        try { await reader?.cancel() } catch { /* ignore */ }
        try { reader?.releaseLock() } catch { /* ignore */ }
        if (streamController === controller) streamController = undefined
        if (!disposed && !suspended) {
          if (Date.now() - startedAt >= 30000) retryDelay = 1000
          reconnectTimer = setTimeout(() => {
            reconnectTimer = undefined
            void connect()
          }, retryDelay)
          retryDelay = Math.min(retryDelay * 2, 15000)
        }
      }
    }

    const pause = () => {
      suspended = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = undefined
      streamController?.abort()
    }
    const resume = () => {
      suspended = false
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = undefined
      if (!streamController && !disposed) void connect()
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', pause)
      window.addEventListener('pageshow', resume)
      window.addEventListener('online', resume)
    }
    void connect()

    return () => {
      disposed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      streamController?.abort()
      if (typeof window !== 'undefined') {
        window.removeEventListener('pagehide', pause)
        window.removeEventListener('pageshow', resume)
        window.removeEventListener('online', resume)
      }
    }
  }

  return {
    call,
    getState: () => call<HooksPluginState>('getState', {}),
    saveSettings: (patch, expectedRevision) =>
      call<HooksPluginState>('saveSettings', {
        ...patch,
        ...(expectedRevision !== undefined ? { expectedRevision } : {}),
      }),
    toggleMountPoint: (mountPointId, enabled, expectedRevision) =>
      call<HooksPluginState>('toggleMountPoint', {
        mountPointId,
        enabled,
        ...(expectedRevision !== undefined ? { expectedRevision } : {}),
      }),
    toggleMountPointBell: (mountPointId, bellEnabled, expectedRevision) =>
      call<HooksPluginState>('toggleMountPointBell', {
        mountPointId,
        bellEnabled,
        ...(expectedRevision !== undefined ? { expectedRevision } : {}),
      }),
    toggleScript: (mountPointId, scriptId, enabled, expectedRevision) =>
      call<HooksPluginState>('toggleScript', {
        mountPointId,
        scriptId,
        enabled,
        ...(expectedRevision !== undefined ? { expectedRevision } : {}),
      }),
    updateScriptMeta: (mountPointId, scriptId, patch, expectedRevision) =>
      call<HooksPluginState>('updateScriptMeta', {
        mountPointId,
        scriptId,
        ...patch,
        ...(expectedRevision !== undefined ? { expectedRevision } : {}),
      }),
    deleteScript: (mountPointId, scriptId, expectedRevision) =>
      call<HooksPluginState>('deleteScript', {
        mountPointId,
        scriptId,
        ...(expectedRevision !== undefined ? { expectedRevision } : {}),
      }),
    resetDefaultScripts: (expectedRevision) =>
      call<HooksPluginState>('resetDefaultScripts', expectedRevision !== undefined ? { expectedRevision } : {}),
    testMountPoint: (mountPointId) => call('testMountPoint', { mountPointId }, 45000),
    testScript: (mountPointId, scriptId) => call('testScript', { mountPointId, scriptId }, 45000),
    getExecutionLogs: () => call<{ logs: ExecutionLogEntry[] }>('getExecutionLogs', {}),
    saveThirdPartyTarget: (target, expectedRevision) =>
      call<HooksPluginState>('saveThirdPartyTarget', {
        target,
        ...(expectedRevision !== undefined ? { expectedRevision } : {}),
      }),
    toggleThirdPartyTarget: (targetId, enabled, expectedRevision) =>
      call<HooksPluginState>('toggleThirdPartyTarget', {
        targetId,
        enabled,
        ...(expectedRevision !== undefined ? { expectedRevision } : {}),
      }),
    deleteThirdPartyTarget: (targetId, expectedRevision) =>
      call<HooksPluginState>('deleteThirdPartyTarget', {
        targetId,
        ...(expectedRevision !== undefined ? { expectedRevision } : {}),
      }),
    testThirdPartyTarget: (target) => call<TestSendResult>('testThirdPartyTarget', { target }, 45000),
    clearCustomSound: (expectedRevision) =>
      call<HooksPluginState>('clearCustomSound', expectedRevision !== undefined ? { expectedRevision } : {}),
    testSystemNotification: () => call('testSystemNotification', {}),
    testTaskbarFlash: (overrides) => call('testTaskbarFlash', overrides ?? {}),
    uploadScript,
    getScriptSource,
    uploadCustomSound,
    getSoundPreviewUrl: () => `api/tavlo-hooks/sound/current?ts=${Date.now()}`,
    postClientState,
    subscribeEvents,
    getClientId: () => clientId,
  }
}

export interface LogBus {
  subscribe(listener: (logs: ExecutionLogEntry[]) => void): () => void
  publish(logs: ExecutionLogEntry[]): void
}

export function createLogBus(): LogBus {
  const listeners = new Set<(logs: ExecutionLogEntry[]) => void>()
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    publish(logs) {
      for (const listener of listeners) listener(logs)
    },
  }
}
