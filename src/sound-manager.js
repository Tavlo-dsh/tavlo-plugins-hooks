/**
 * Custom `.wav` sound validation, atomic storage, and native Host playback.
 */

import { randomBytes } from 'node:crypto'
import { spawn as nodeSpawn } from 'node:child_process'
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const MAX_WAV_BYTES = 20 * 1024 * 1024

const MAX_FILENAME_LENGTH = 120
const DEFAULT_PLAY_TIMEOUT_MS = 15_000
const MAX_PLAY_TIMEOUT_MS = 60_000
const MAX_STDERR_BYTES = 2048

const WIN32_PLAY_COMMAND =
  '$p=$env:DSH_SOUND_PATH; if ($p -and (Test-Path -LiteralPath $p)) { $sp = New-Object System.Media.SoundPlayer $p; $sp.PlaySync() }'

let cachedScrubbedParentEnv = null

async function getScrubbedEnv() {
  if (!cachedScrubbedParentEnv) {
    try {
      const mod = await import('@deepseek-ai/dsh-subprocess')
      if (typeof mod?.scrubbedParentEnv === 'function') {
        cachedScrubbedParentEnv = mod.scrubbedParentEnv
      }
    } catch {
      // Fallback when running isolated tests before dependencies are installed.
    }
    if (!cachedScrubbedParentEnv) {
      cachedScrubbedParentEnv = () => {
        const env = {}
        for (const [key, value] of Object.entries(process.env)) {
          if (
            value !== undefined &&
            !/KEY|PASSWORD|SECRET|TOKEN/i.test(key) &&
            !key.toUpperCase().startsWith('DSH_')
          ) {
            env[key] = value
          }
        }
        return env
      }
    }
  }
  return cachedScrubbedParentEnv()
}

function toBufferView(buf) {
  if (Buffer.isBuffer(buf)) return buf
  if (buf instanceof Uint8Array) {
    return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
  }
  return null
}

/**
 * Validate a WAV buffer against size bounds and RIFF/WAVE header bytes.
 * @param {Buffer|Uint8Array} buf
 * @returns {{ valid: boolean, errorCode?: string, reason?: string }}
 */
export function validateWavBuffer(buf) {
  const view = toBufferView(buf)
  if (!view) {
    return {
      valid: false,
      errorCode: 'sound/invalid-buffer',
      reason: 'Expected a Buffer or Uint8Array.',
    }
  }
  if (view.byteLength === 0) {
    return {
      valid: false,
      errorCode: 'sound/empty',
      reason: 'WAV file is empty.',
    }
  }
  if (view.byteLength > MAX_WAV_BYTES) {
    return {
      valid: false,
      errorCode: 'sound/too-large',
      reason: `WAV file exceeds ${MAX_WAV_BYTES} bytes limit.`,
    }
  }
  if (view.byteLength < 12) {
    return {
      valid: false,
      errorCode: 'sound/invalid-header',
      reason: 'WAV header must be at least 12 bytes.',
    }
  }
  const riff = view.toString('ascii', 0, 4)
  const wave = view.toString('ascii', 8, 12)
  if (riff !== 'RIFF' || wave !== 'WAVE') {
    return {
      valid: false,
      errorCode: 'sound/invalid-wav',
      reason: 'File does not have a valid RIFF/WAVE header.',
    }
  }
  return { valid: true }
}

function sanitizeSoundFilename(originalName) {
  const raw = typeof originalName === 'string' ? originalName : ''
  const base = raw.split(/[\\/]+/).pop()?.trim() ?? ''
  let cleaned = base
    .replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim()
  if (!cleaned) cleaned = 'custom.wav'
  if (!cleaned.toLowerCase().endsWith('.wav')) {
    cleaned = `${cleaned}.wav`
  }
  if (cleaned.length > MAX_FILENAME_LENGTH) {
    const stem = cleaned.slice(0, MAX_FILENAME_LENGTH - 4).replace(/[. ]+$/, '') || 'custom'
    cleaned = `${stem}.wav`
  }
  return cleaned
}

/**
 * Resolve the path where the active custom WAV sound is stored.
 * @param {string} dataDir
 * @returns {string}
 */
export function getCustomSoundPath(dataDir) {
  if (typeof dataDir !== 'string' || !dataDir.trim()) {
    throw new TypeError('dataDir must be a non-empty string')
  }
  return path.join(dataDir, 'sounds', 'custom.wav')
}

function getCustomSoundMetaPath(dataDir) {
  return `${getCustomSoundPath(dataDir)}.json`
}

async function atomicWriteFile(targetPath, data) {
  const suffix = `.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  const tmpPath = `${targetPath}${suffix}`
  try {
    await writeFile(tmpPath, data)
    await rename(tmpPath, targetPath)
  } catch (error) {
    await unlink(tmpPath).catch(() => {})
    throw error
  }
}

/**
 * Validate and persist a custom WAV sound and its metadata atomically.
 * @param {string} dataDir
 * @param {Buffer|Uint8Array} buf
 * @param {string} originalName
 * @returns {Promise<{ filename: string, bytes: number, updatedAt: string }>}
 */
export async function saveCustomSound(dataDir, buf, originalName) {
  const check = validateWavBuffer(buf)
  if (!check.valid) {
    const err = new Error(check.reason || 'Invalid WAV sound')
    err.code = check.errorCode || 'sound/invalid-wav'
    throw err
  }
  const view = toBufferView(buf)
  const soundPath = getCustomSoundPath(dataDir)
  const metaPath = getCustomSoundMetaPath(dataDir)
  await mkdir(path.dirname(soundPath), { recursive: true })

  const info = {
    filename: sanitizeSoundFilename(originalName),
    bytes: view.byteLength,
    updatedAt: new Date().toISOString(),
  }

  await atomicWriteFile(soundPath, view)
  await atomicWriteFile(metaPath, JSON.stringify(info, null, 2))
  return info
}

/**
 * Read custom WAV metadata and verify the audio file exists and passes RIFF/WAVE header + size checks.
 * @param {string} dataDir
 * @returns {Promise<{ filename: string, bytes: number, updatedAt: string } | null>}
 */
export async function getCustomSoundInfo(dataDir) {
  if (typeof dataDir !== 'string' || !dataDir.trim()) return null
  const soundPath = getCustomSoundPath(dataDir)
  const metaPath = getCustomSoundMetaPath(dataDir)

  let meta
  try {
    const raw = await readFile(metaPath, 'utf8')
    meta = JSON.parse(raw)
  } catch {
    return null
  }
  if (!meta || typeof meta !== 'object' || typeof meta.filename !== 'string' || !meta.filename.trim()) {
    return null
  }

  let fileStat
  try {
    fileStat = await stat(soundPath)
  } catch {
    return null
  }
  if (!fileStat.isFile() || fileStat.size < 12 || fileStat.size > MAX_WAV_BYTES) {
    return null
  }

  let handle
  try {
    handle = await open(soundPath, 'r')
    const header = Buffer.alloc(12)
    const { bytesRead } = await handle.read(header, 0, 12, 0)
    if (bytesRead < 12) return null
    if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
      return null
    }
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }

  return {
    filename: sanitizeSoundFilename(meta.filename),
    bytes: fileStat.size,
    updatedAt: typeof meta.updatedAt === 'string' ? meta.updatedAt : fileStat.mtime.toISOString(),
  }
}

/**
 * Remove custom WAV audio and metadata, ignoring ENOENT.
 * @param {string} dataDir
 * @returns {Promise<void>}
 */
export async function clearCustomSound(dataDir) {
  if (typeof dataDir !== 'string' || !dataDir.trim()) return
  const targets = [getCustomSoundPath(dataDir), getCustomSoundMetaPath(dataDir)]
  for (const target of targets) {
    try {
      await unlink(target)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
}

function runCommandWithTimeout(spawnImpl, cmd, args, options, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    let exitFallbackTimer = null
    const stderrChunks = []
    let stderrLen = 0

    let child
    try {
      child = spawnImpl(cmd, args, options)
    } catch (error) {
      resolve({ played: false, reason: error?.message || 'spawn failed' })
      return
    }
    if (!child || typeof child.once !== 'function') {
      resolve({ played: false, reason: 'Invalid child process handle' })
      return
    }

    const timer = setTimeout(() => {
      try {
        child.kill?.('SIGKILL')
      } catch {
        try {
          child.kill?.()
        } catch {
          // Ignore kill error
        }
      }
      finish({ played: false, reason: 'timeout' })
    }, timeoutMs)
    timer.unref?.()

    function finish(result) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (exitFallbackTimer) clearTimeout(exitFallbackTimer)
      resolve(result)
    }

    if (child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', (chunk) => {
        if (stderrLen >= MAX_STDERR_BYTES) return
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
        const slice = buf.subarray(0, MAX_STDERR_BYTES - stderrLen)
        stderrChunks.push(slice)
        stderrLen += slice.length
      })
    }

    child.once('error', (error) => {
      finish({ played: false, reason: error?.message || 'process error' })
    })

    const handleCompletion = (code, signal) => {
      if (code === 0) {
        finish({ played: true })
        return
      }
      const stderrText = Buffer.concat(stderrChunks).toString('utf8').replace(/\s+/g, ' ').trim()
      const detail = stderrText || (signal ? `signal ${signal}` : `exit code ${code}`)
      finish({ played: false, reason: detail })
    }

    child.once('close', handleCompletion)
    child.once('exit', (code, signal) => {
      if (settled) return
      exitFallbackTimer = setTimeout(() => handleCompletion(code, signal), 25)
      exitFallbackTimer.unref?.()
    })
  })
}

/**
 * Play a local WAV file on the Host OS with bounded timeout and non-throwing result.
 * @param {string} filePath
 * @param {{ platform?: string, spawnImpl?: Function, timeoutMs?: number }} [opts]
 * @returns {Promise<{ played: boolean, reason?: string }>}
 */
export async function playNativeSound(
  filePath,
  { platform = process.platform, spawnImpl = nodeSpawn, timeoutMs = DEFAULT_PLAY_TIMEOUT_MS } = {},
) {
  if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0')) {
    return { played: false, reason: 'Invalid sound file path' }
  }
  const boundedTimeout =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.min(Math.round(timeoutMs), MAX_PLAY_TIMEOUT_MS)
      : DEFAULT_PLAY_TIMEOUT_MS

  const scrubbedEnv = await getScrubbedEnv()

  if (platform === 'win32') {
    return runCommandWithTimeout(
      spawnImpl,
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', WIN32_PLAY_COMMAND],
      {
        env: { ...scrubbedEnv, DSH_SOUND_PATH: filePath },
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      },
      boundedTimeout,
    )
  }

  if (platform === 'darwin') {
    return runCommandWithTimeout(
      spawnImpl,
      'afplay',
      [filePath],
      {
        env: scrubbedEnv,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      },
      boundedTimeout,
    )
  }

  if (platform === 'linux') {
    const deadline = Date.now() + boundedTimeout
    const first = await runCommandWithTimeout(
      spawnImpl,
      'paplay',
      [filePath],
      {
        env: scrubbedEnv,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      },
      boundedTimeout,
    )
    if (first.played || first.reason === 'timeout') return first
    const remaining = Math.max(1000, deadline - Date.now())
    return runCommandWithTimeout(
      spawnImpl,
      'aplay',
      [filePath],
      {
        env: scrubbedEnv,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      },
      remaining,
    )
  }

  return { played: false, reason: `Unsupported platform: ${platform}` }
}
