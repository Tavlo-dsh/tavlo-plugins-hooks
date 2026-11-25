/**
 * Cross-platform custom/default hook script validation, storage, execution, and log ring buffer.
 */

import { spawn as nodeSpawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { appendFile, chmod, lstat, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { getDefaultScriptById, getDefaultScriptsDir } from './default-scripts.js'

export const MAX_SCRIPT_BYTES = 512 * 1024
export const MAX_SCRIPT_OUTPUT_BYTES = 64 * 1024
export const MAX_EXECUTION_LOGS = 50
export const MAX_LOG_FILE_BYTES = 256 * 1024
export const ALLOWED_SCRIPT_EXTENSIONS = new Set([
  '.mjs',
  '.js',
  '.cjs',
  '.ps1',
  '.sh',
  '.py',
  '.cmd',
  '.bat',
])

const CUSTOM_FILENAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(mjs|js|cjs|ps1|sh|py|cmd|bat)$/i

export class ScriptRunnerError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

export function getCustomScriptsDir(dataDir) {
  if (typeof dataDir !== 'string' || !dataDir.trim()) {
    throw new TypeError('dataDir must be a non-empty string')
  }
  return path.join(dataDir, 'hooks', 'scripts', 'custom')
}

export function getExecutionLogPath(dataDir) {
  if (typeof dataDir !== 'string' || !dataDir.trim()) {
    throw new TypeError('dataDir must be a non-empty string')
  }
  return path.join(dataDir, 'hooks', 'logs', 'execution.jsonl')
}

export function clampTimeoutSeconds(raw) {
  if (raw === undefined || raw === null || raw === '') return 10
  const n = Math.round(Number(raw))
  if (!Number.isFinite(n)) return 10
  return Math.min(60, Math.max(1, n))
}

function sanitizeDisplayName(rawName, fallback) {
  const cleaned = (typeof rawName === 'string' ? rawName : '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
  const base = cleaned || fallback || 'hook-script'
  return base.slice(0, 120)
}

function sanitizeOriginalFilename(raw) {
  const str = typeof raw === 'string' ? raw : ''
  if (str.includes('\0')) {
    throw new ScriptRunnerError('hooks/invalid-script-name', 'Invalid script filename')
  }
  const base = str.split(/[\\/]+/).pop()?.trim() ?? ''
  return base.replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '_').slice(0, 120)
}

function assertContained(baseDir, candidatePath) {
  const resolvedBase = path.resolve(baseDir)
  const resolvedTarget = path.resolve(candidatePath)
  const prefix = resolvedBase.endsWith(path.sep) ? resolvedBase : resolvedBase + path.sep
  if (!resolvedTarget.startsWith(prefix) || path.dirname(resolvedTarget) !== resolvedBase) {
    throw new ScriptRunnerError('hooks/path-escape', 'Script path escapes allowed directory')
  }
  return resolvedTarget
}

export function resolveScriptFilePath(dataDir, scriptEntry) {
  if (!scriptEntry || typeof scriptEntry !== 'object') {
    throw new ScriptRunnerError('hooks/script-not-found', 'Invalid script entry')
  }
  const filename = typeof scriptEntry.filename === 'string' ? scriptEntry.filename : ''
  if (!filename || filename.includes('\0') || filename.includes('/') || filename.includes('\\') || filename === '.' || filename === '..') {
    throw new ScriptRunnerError('hooks/invalid-script-name', 'Invalid script filename')
  }
  if (scriptEntry.kind === 'default') {
    const def = getDefaultScriptById(scriptEntry.id)
    if (!def || def.filename !== filename) {
      throw new ScriptRunnerError('hooks/script-not-found', 'Unknown default script')
    }
    return assertContained(getDefaultScriptsDir(dataDir), path.join(getDefaultScriptsDir(dataDir), def.filename))
  }
  if (scriptEntry.kind === 'custom') {
    if (!CUSTOM_FILENAME_RE.test(filename)) {
      throw new ScriptRunnerError('hooks/invalid-script-name', 'Invalid custom script filename')
    }
    const dir = getCustomScriptsDir(dataDir)
    return assertContained(dir, path.join(dir, filename))
  }
  throw new ScriptRunnerError('hooks/script-not-found', 'Unknown script kind')
}

async function atomicWriteBuffer(targetPath, buf) {
  const tmpPath = `${targetPath}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  try {
    await writeFile(tmpPath, buf)
    await rename(tmpPath, targetPath)
  } catch (error) {
    await unlink(tmpPath).catch(() => {})
    throw error
  }
}

/**
 * Validate and persist an uploaded custom script under `$DSH_HOME/hooks/scripts/custom/`.
 */
export async function saveUploadedScript(dataDir, { filename, buffer, name, matcher, timeoutSeconds }) {
  const cleanOriginal = sanitizeOriginalFilename(filename)
  const ext = path.extname(cleanOriginal).toLowerCase()
  if (!ALLOWED_SCRIPT_EXTENSIONS.has(ext)) {
    throw new ScriptRunnerError(
      'hooks/invalid-script-type',
      `Unsupported script extension "${ext || '(none)'}". Allowed: ${[...ALLOWED_SCRIPT_EXTENSIONS].join(', ')}`,
    )
  }
  const view = Buffer.isBuffer(buffer)
    ? buffer
    : buffer instanceof Uint8Array
      ? Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      : null
  if (!view || view.byteLength === 0) {
    throw new ScriptRunnerError('hooks/empty-script', 'Uploaded script file is empty')
  }
  if (view.byteLength > MAX_SCRIPT_BYTES) {
    throw new ScriptRunnerError('hooks/script-too-large', `Script exceeds ${MAX_SCRIPT_BYTES} bytes limit`)
  }

  const customDir = getCustomScriptsDir(dataDir)
  await mkdir(customDir, { recursive: true })

  const id = randomUUID()
  const storedFilename = `${id}${ext}`
  const targetPath = assertContained(customDir, path.join(customDir, storedFilename))

  await atomicWriteBuffer(targetPath, view)
  if (process.platform !== 'win32') {
    await chmod(targetPath, 0o700).catch(() => {})
  }

  return {
    id,
    kind: 'custom',
    name: sanitizeDisplayName(name, cleanOriginal),
    filename: storedFilename,
    originalFilename: cleanOriginal,
    enabled: true,
    matcher: typeof matcher === 'string' ? matcher.trim().slice(0, 256) : '',
    timeoutSeconds: clampTimeoutSeconds(timeoutSeconds),
    createdAt: new Date().toISOString(),
  }
}

export async function deleteCustomScriptFile(dataDir, filename) {
  if (typeof filename !== 'string' || !CUSTOM_FILENAME_RE.test(filename)) return
  const dir = getCustomScriptsDir(dataDir)
  const targetPath = assertContained(dir, path.join(dir, filename))
  try {
    await unlink(targetPath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

export async function readScriptSource(dataDir, scriptEntry) {
  const targetPath = resolveScriptFilePath(dataDir, scriptEntry)
  const baseDir = scriptEntry.kind === 'default' ? getDefaultScriptsDir(dataDir) : getCustomScriptsDir(dataDir)
  let realBase
  let realTarget
  try {
    const linkInfo = await lstat(targetPath)
    if (linkInfo.isSymbolicLink() || !linkInfo.isFile()) {
      throw new ScriptRunnerError('hooks/script-not-found', 'Script file is not a regular file')
    }
    realBase = await realpath(baseDir)
    realTarget = await realpath(targetPath)
  } catch (error) {
    if (error instanceof ScriptRunnerError) throw error
    if (error?.code === 'ENOENT') {
      throw new ScriptRunnerError('hooks/script-not-found', 'Script file not found')
    }
    throw error
  }
  const prefix = realBase.endsWith(path.sep) ? realBase : realBase + path.sep
  if (!realTarget.startsWith(prefix)) {
    throw new ScriptRunnerError('hooks/path-escape', 'Script path escapes allowed directory')
  }
  const info = await stat(realTarget)
  if (info.size > MAX_SCRIPT_BYTES) {
    throw new ScriptRunnerError('hooks/script-too-large', 'Script exceeds maximum readable size')
  }
  return await readFile(realTarget, 'utf8')
}

export function matchesScriptMatcher(matcher, hookEvent) {
  const raw = typeof matcher === 'string' ? matcher.trim() : ''
  if (!raw || raw === '*') return true
  const target = String(hookEvent?.toolName ?? hookEvent?.matcherTarget ?? hookEvent?.hookPoint ?? '')
  if (!target) return false
  if (raw.length <= 256) {
    try {
      return new RegExp(raw).test(target)
    } catch {
      // Fallback to exact pipe-separated matching when regex syntax is invalid
    }
  }
  const parts = raw.split('|').map((part) => part.trim()).filter(Boolean)
  return parts.includes(target)
}

async function resolveInterpreter(resolvedPath, ext, platform = process.platform) {
  switch (ext) {
    case '.mjs':
    case '.js':
    case '.cjs':
      return [process.execPath, resolvedPath]
    case '.py':
      return [platform === 'win32' ? 'python' : 'python3', resolvedPath]
    case '.sh': {
      try {
        const head = (await readFile(resolvedPath, 'utf8')).slice(0, 128)
        if (/^#![^\r\n]*\bbash\b/i.test(head)) return ['bash', resolvedPath]
      } catch {
        // Ignore read failure and let shell fail naturally
      }
      return ['sh', resolvedPath]
    }
    case '.ps1':
      return [
        platform === 'win32' ? 'powershell.exe' : 'pwsh',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        resolvedPath,
      ]
    case '.cmd':
    case '.bat':
      if (platform !== 'win32') {
        throw new ScriptRunnerError('hooks/unsupported-platform', '.cmd/.bat scripts require Windows')
      }
      return ['cmd.exe', '/d', '/c', resolvedPath]
    default:
      throw new ScriptRunnerError('hooks/invalid-script-type', `Unsupported extension ${ext}`)
  }
}

export function parseDirectiveOutput(stdout) {
  if (typeof stdout !== 'string' || !stdout.trim()) return null
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.startsWith('{') || !line.endsWith('}')) continue
    try {
      const parsed = JSON.parse(line)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
      const out = {}
      if (typeof parsed.notify === 'boolean') out.notify = parsed.notify
      if (typeof parsed.suppress === 'boolean') out.suppress = parsed.suppress
      if (typeof parsed.title === 'string' && parsed.title.trim()) {
        out.title = parsed.title.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 200)
      }
      if (typeof parsed.summary === 'string' && parsed.summary.trim()) {
        out.summary = parsed.summary.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 500)
      }
      if (typeof parsed.level === 'string' && parsed.level.trim()) {
        out.level = parsed.level.trim().slice(0, 40)
      }
      if (parsed.channels !== undefined && typeof parsed.channels === 'object') {
        out.channels = parsed.channels
      }
      return out
    } catch {
      return null
    }
  }
  return null
}

function truncateOutput(text, maxChars = 2000) {
  if (typeof text !== 'string' || !text) return ''
  return text.length > maxChars ? text.slice(0, maxChars) + '…' : text
}

function spawnFallback(spawnImpl, argv, { cwd, env, stdinData, timeoutMs, signal }) {
  return new Promise((resolve) => {
    let settled = false
    let timedOut = false
    const stdoutChunks = []
    const stderrChunks = []
    let stdoutBytes = 0
    let stderrBytes = 0

    let child
    try {
      child = spawnImpl(argv[0], argv.slice(1), {
        cwd,
        env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ exitCode: null, timedOut: false, stdout: '', stderr: '', error: error?.message || 'spawn failed' })
      return
    }

    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      resolve(result)
    }

    const killChild = () => {
      try {
        child.kill('SIGTERM')
      } catch {
        try {
          child.kill()
        } catch {
          // ignore
        }
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // ignore
        }
      }, 500).unref?.()
    }

    const onAbort = () => {
      killChild()
      finish({
        exitCode: null,
        timedOut: false,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        error: 'aborted',
      })
    }

    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })

    const timer = setTimeout(() => {
      timedOut = true
      killChild()
      finish({
        exitCode: null,
        timedOut: true,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        error: `Script timed out after ${timeoutMs}ms`,
      })
    }, timeoutMs)
    timer.unref?.()

    child.stdout?.on('data', (chunk) => {
      if (stdoutBytes >= MAX_SCRIPT_OUTPUT_BYTES) return
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      const slice = buf.subarray(0, MAX_SCRIPT_OUTPUT_BYTES - stdoutBytes)
      stdoutChunks.push(slice)
      stdoutBytes += slice.byteLength
    })
    child.stderr?.on('data', (chunk) => {
      if (stderrBytes >= MAX_SCRIPT_OUTPUT_BYTES) return
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      const slice = buf.subarray(0, MAX_SCRIPT_OUTPUT_BYTES - stderrBytes)
      stderrChunks.push(slice)
      stderrBytes += slice.byteLength
    })

    child.once('error', (error) => {
      finish({
        exitCode: null,
        timedOut,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        error: error?.message || 'process error',
      })
    })

    child.once('close', (code) => {
      finish({
        exitCode: code,
        timedOut,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        error: code === 0 ? undefined : undefined,
      })
    })

    try {
      child.stdin?.end(stdinData)
    } catch {
      // ignore broken pipe
    }
  })
}

export function createScriptRunner({
  getDataDir,
  getSubprocess,
  eventHub,
  spawnImpl = nodeSpawn,
  platform = process.platform,
  now = Date.now,
  logger,
} = {}) {
  const logs = []
  let writeTail = Promise.resolve()

  function appendPersistedLog(entry) {
    let dataDir
    try {
      dataDir = getDataDir?.()
    } catch {
      return writeTail
    }
    if (typeof dataDir !== 'string' || !dataDir.trim()) return writeTail
    const logPath = getExecutionLogPath(dataDir)
    const logDir = path.dirname(logPath)
    const prevPath = path.join(logDir, 'execution.prev.jsonl')
    const line = `${JSON.stringify(entry)}\n`

    writeTail = writeTail
      .then(async () => {
        await mkdir(logDir, { recursive: true })
        try {
          const info = await stat(logPath)
          if (info.size >= MAX_LOG_FILE_BYTES) {
            await rename(logPath, prevPath).catch(() => {})
          }
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error
        }
        await appendFile(logPath, line, 'utf8')
      })
      .catch((error) => {
        logger?.warn?.(`tavlo-hooks: failed to persist execution log: ${error?.message || error}`)
      })
    return writeTail
  }

  async function init() {
    let dataDir
    try {
      dataDir = getDataDir?.()
    } catch {
      return
    }
    if (typeof dataDir !== 'string' || !dataDir.trim()) return
    const logPath = getExecutionLogPath(dataDir)
    let raw = ''
    try {
      raw = await readFile(logPath, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return
      logger?.warn?.(`tavlo-hooks: failed to read execution log: ${error?.message || error}`)
      return
    }
    const parsed = []
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const obj = JSON.parse(trimmed)
        if (obj && typeof obj === 'object' && (obj.kind === 'default' || obj.kind === 'custom')) {
          parsed.push(obj)
        }
      } catch {
        // Ignore malformed log line
      }
    }
    if (parsed.length === 0) return
    const recent = parsed.slice(-MAX_EXECUTION_LOGS).reverse()
    const existingIds = new Set(logs.map((item) => item.id))
    for (const item of recent) {
      if (logs.length >= MAX_EXECUTION_LOGS) break
      if (!existingIds.has(item.id)) {
        logs.push(item)
        existingIds.add(item.id)
      }
    }
  }

  function recordLog(entry) {
    logs.unshift(entry)
    if (logs.length > MAX_EXECUTION_LOGS) {
      logs.length = MAX_EXECUTION_LOGS
    }
    eventHub?.broadcast?.('logs', { logs: [...logs] })
    void appendPersistedLog(entry)
    return entry
  }

  function recordTriggerLog(entry) {
    const record = {
      id: entry?.id || randomUUID(),
      timestamp: entry?.timestamp || new Date(now()).toISOString(),
      ...entry,
    }
    void appendPersistedLog(record)
    return record
  }

  async function flushLogs() {
    await writeTail
  }

  function getLogs(limit = MAX_EXECUTION_LOGS) {
    const cap = Math.min(MAX_EXECUTION_LOGS, Math.max(1, Math.trunc(Number(limit) || MAX_EXECUTION_LOGS)))
    return logs.slice(0, cap)
  }

  async function executeScript(script, hookEvent, { signal, dryRun = false } = {}) {
    const startedAt = now()
    const dataDir = getDataDir()
    const eventId = String(hookEvent?.eventId || randomUUID())
    const hookPoint = String(hookEvent?.hookPoint || '')
    const category = String(hookEvent?.category || 'Notification')
    const timestamp = String(hookEvent?.timestamp || new Date(startedAt).toISOString())
    const turn = typeof hookEvent?.turn === 'number' && Number.isFinite(hookEvent.turn) ? hookEvent.turn : null

    const stdinPayload = {
      eventId,
      hookPoint,
      category,
      timestamp,
      sessionId: hookEvent?.sessionId ? String(hookEvent.sessionId) : null,
      sessionTitle: hookEvent?.sessionTitle ? String(hookEvent.sessionTitle) : null,
      projectName: hookEvent?.projectName ? String(hookEvent.projectName) : null,
      summary: hookEvent?.summary ? String(hookEvent.summary) : '',
      toolName: hookEvent?.toolName ? String(hookEvent.toolName) : null,
      reason: hookEvent?.reason ? String(hookEvent.reason) : null,
      approvalId: hookEvent?.approvalId ? String(hookEvent.approvalId) : null,
      turn,
    }

    let exitCode = null
    let timedOut = false
    let stdout = ''
    let stderr = ''
    let errorMsg

    try {
      const resolvedPath = resolveScriptFilePath(dataDir, script)
      const ext = path.extname(resolvedPath).toLowerCase()
      const argv = await resolveInterpreter(resolvedPath, ext, platform)
      const timeoutMs = clampTimeoutSeconds(script.timeoutSeconds) * 1000
      const env = {
        ...scrubbedParentEnv(),
        DSH_HOOK_POINT: hookPoint,
        DSH_HOOK_CATEGORY: category,
        DSH_HOOK_EVENT_ID: eventId,
        DSH_HOOK_SESSION_ID: stdinPayload.sessionId ?? '',
        DSH_HOOK_PROJECT: stdinPayload.projectName ?? '',
      }
      const stdinData = `${JSON.stringify(stdinPayload)}\n`
      const subprocess = getSubprocess?.()

      if (subprocess && typeof subprocess.spawn === 'function') {
        const timeoutController = new AbortController()
        const timer = setTimeout(() => {
          timedOut = true
          timeoutController.abort()
        }, timeoutMs)
        timer.unref?.()
        const runSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal
        try {
          const handle = subprocess.spawn({
            argv,
            cwd: path.dirname(resolvedPath),
            env,
            graceMs: 1000,
            signal: runSignal,
            stdio: {
              stdin: { data: stdinData },
              stdout: { maxBytes: MAX_SCRIPT_OUTPUT_BYTES },
              stderr: { maxBytes: MAX_SCRIPT_OUTPUT_BYTES },
            },
          })
          const outcome = await handle.done
          exitCode = outcome?.exitCode ?? null
          stdout = handle.collected?.stdout?.readFrom?.(0)?.text ?? ''
          stderr = handle.collected?.stderr?.readFrom?.(0)?.text ?? ''
          if (timedOut) {
            errorMsg = `Script timed out after ${timeoutMs}ms`
          } else if (signal?.aborted) {
            errorMsg = 'aborted'
          }
        } finally {
          clearTimeout(timer)
        }
      } else {
        const res = await spawnFallback(spawnImpl, argv, {
          cwd: path.dirname(resolvedPath),
          env,
          stdinData,
          timeoutMs,
          signal,
        })
        exitCode = res.exitCode
        timedOut = res.timedOut
        stdout = res.stdout
        stderr = res.stderr
        errorMsg = res.error
      }
    } catch (error) {
      errorMsg = error?.message || String(error)
    }

    const elapsedMs = Math.max(0, now() - startedAt)
    const directive = parseDirectiveOutput(stdout)
    const suppressed = Boolean(directive && (directive.suppress === true || directive.notify === false))

    return recordLog({
      id: randomUUID(),
      timestamp: new Date(startedAt).toISOString(),
      mountPointId: hookPoint,
      category,
      scriptId: script.id,
      scriptName: script.name,
      kind: script.kind,
      eventId,
      sessionId: stdinPayload.sessionId,
      turn,
      reason: stdinPayload.reason,
      summary: truncateOutput(stdinPayload.summary, 160),
      exitCode,
      timedOut,
      elapsedMs,
      suppressed,
      ...(directive ? { directive } : {}),
      stdout: truncateOutput(stdout),
      stderr: truncateOutput(stderr),
      ...(errorMsg ? { error: errorMsg } : {}),
      ...(dryRun ? { dryRun: true } : {}),
    })
  }

  return {
    init,
    executeScript,
    getLogs,
    recordTriggerLog,
    flushLogs,
  }
}
