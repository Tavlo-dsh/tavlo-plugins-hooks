/**
 * Cross-platform OS system notifications (WinRT/WSL/macOS/Linux) and Windows taskbar attention flashing.
 */

import { spawn as nodeSpawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

const MAX_TITLE_CHARS = 200
const MAX_BODY_CHARS = 1000
const DEFAULT_FLASH_COUNT = 5
const MIN_FLASH_COUNT = 1
const MAX_FLASH_COUNT = 20
const DEFAULT_TIMEOUT_MS = 10_000
const MAX_STDIO_BYTES = 4096
const WSL_POWERSHELL_FALLBACK = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'

const PS_TOAST_SCRIPT = `
$ErrorActionPreference = 'Stop'
$title = [string]$env:DSH_TOAST_TITLE
$body = [string]$env:DSH_TOAST_BODY
$silent = ($env:DSH_TOAST_SILENT -eq '1' -or $env:DSH_TOAST_SILENT -eq 'true')
if ([string]::IsNullOrWhiteSpace($title)) { exit 0 }
$escTitle = [System.Security.SecurityElement]::Escape($title)
$escBody = [System.Security.SecurityElement]::Escape($body)
$audio = if ($silent) { '<audio silent="true"/>' } else { '' }
$xmlText = "<toast><visual><binding template=\`"ToastGeneric\`"><text>$escTitle</text><text>$escBody</text></binding></visual>$audio</toast>"
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
  $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
  $doc.LoadXml($xmlText)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $doc
  $appIds = @(
    '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe',
    'DSH'
  )
  foreach ($aid in $appIds) {
    try {
      $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aid)
      $notifier.Show($toast)
      Write-Output 'WINRT_OK'
      exit 0
    } catch {}
  }
} catch {}
try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $ni = New-Object System.Windows.Forms.NotifyIcon
  $ni.Icon = [System.Drawing.SystemIcons]::Information
  $ni.BalloonTipTitle = $title
  $ni.BalloonTipText = if ([string]::IsNullOrEmpty($body)) { ' ' } else { $body }
  $ni.Visible = $true
  $ni.ShowBalloonTip(5000)
  Start-Sleep -Milliseconds 250
  $ni.Dispose()
  Write-Output 'BALLOON_OK'
  exit 0
} catch {
  exit 0
}
`.trim()

const PS_FLASH_SCRIPT = `
$ErrorActionPreference = 'Stop'
$mode = [string]$env:DSH_FLASH_MODE
if ([string]::IsNullOrWhiteSpace($mode)) { $mode = 'finite' }
$countRaw = 0
[void][int]::TryParse([string]$env:DSH_FLASH_COUNT, [ref]$countRaw)
if ($countRaw -lt 1) { $countRaw = 5 }
if ($countRaw -gt 20) { $countRaw = 20 }
$targetPid = 0
[void][int]::TryParse([string]$env:DSH_TARGET_PID, [ref]$targetPid)
$hint = [string]$env:DSH_WINDOW_HINT
if ([string]::IsNullOrWhiteSpace($hint)) { $hint = 'DSH' }

$code = @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class DshTaskbarAttention {
  [StructLayout(LayoutKind.Sequential)]
  public struct FLASHWINFO {
    public uint cbSize;
    public IntPtr hwnd;
    public uint dwFlags;
    public uint uCount;
    public uint dwTimeout;
  }

  public const uint FLASHW_STOP = 0;
  public const uint FLASHW_TRAY = 2;
  public const uint FLASHW_TIMERNOFG = 12;

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool FlashWindowEx(ref FLASHWINFO pwfi);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

  [DllImport("user32.dll")]
  private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

  private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

  public static IntPtr FindTargetWindow(int targetPid, string hint) {
    if (targetPid > 0) {
      try {
        var proc = Process.GetProcessById(targetPid);
        if (proc.MainWindowHandle != IntPtr.Zero && IsWindowVisible(proc.MainWindowHandle)) {
          return proc.MainWindowHandle;
        }
      } catch {}
    }

    IntPtr pidHwnd = IntPtr.Zero;
    IntPtr hintHwnd = IntPtr.Zero;
    string[] hints = string.IsNullOrWhiteSpace(hint)
      ? new[] { "DSH", "Tavlo", "DeepSeek" }
      : new[] { hint, "DSH", "Tavlo", "DeepSeek" };

    EnumWindows((hwnd, lParam) => {
      if (!IsWindowVisible(hwnd)) return true;
      if (targetPid > 0 && pidHwnd == IntPtr.Zero) {
        uint winPid;
        GetWindowThreadProcessId(hwnd, out winPid);
        if (winPid == (uint)targetPid) {
          pidHwnd = hwnd;
          return false;
        }
      }
      if (hintHwnd == IntPtr.Zero) {
        var sb = new StringBuilder(512);
        if (GetWindowText(hwnd, sb, sb.Capacity) > 0) {
          string title = sb.ToString();
          foreach (string h in hints) {
            if (!string.IsNullOrEmpty(h) && title.IndexOf(h, StringComparison.OrdinalIgnoreCase) >= 0) {
              hintHwnd = hwnd;
              break;
            }
          }
        }
      }
      return true;
    }, IntPtr.Zero);

    return pidHwnd != IntPtr.Zero ? pidHwnd : hintHwnd;
  }

  public static string Apply(int targetPid, string hint, string mode, uint count) {
    IntPtr hwnd = FindTargetWindow(targetPid, hint);
    if (hwnd == IntPtr.Zero) return "NO_HWND";
    var info = new FLASHWINFO {
      cbSize = (uint)Marshal.SizeOf(typeof(FLASHWINFO)),
      hwnd = hwnd,
      dwTimeout = 0
    };
    if (mode == "stop") {
      info.dwFlags = FLASHW_STOP;
      info.uCount = 0;
    } else if (mode == "untilFocused") {
      info.dwFlags = FLASHW_TRAY | FLASHW_TIMERNOFG;
      info.uCount = uint.MaxValue;
    } else {
      info.dwFlags = FLASHW_TRAY;
      info.uCount = count;
    }
    FlashWindowEx(ref info);
    return "FLASHED";
  }
}
'@
if (-not ('DshTaskbarAttention' -as [type])) {
  Add-Type -TypeDefinition $code -Language CSharp
}
Write-Output ([DshTaskbarAttention]::Apply($targetPid, $hint, $mode, [uint32]$countRaw))
`.trim()

let cachedScrubbedParentEnv = null

async function getScrubbedEnv(baseEnv = process.env) {
  if (baseEnv !== process.env) {
    const env = {}
    for (const [key, value] of Object.entries(baseEnv || {})) {
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
  if (!cachedScrubbedParentEnv) {
    try {
      const mod = await import('@deepseek-ai/dsh-subprocess')
      if (typeof mod?.scrubbedParentEnv === 'function') {
        cachedScrubbedParentEnv = mod.scrubbedParentEnv
      }
    } catch {
      // Fallback when dependencies are not installed yet.
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

function stripAndTruncate(raw, maxCodepoints) {
  const clean = (raw == null ? '' : String(raw))
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
  const codepoints = Array.from(clean)
  if (codepoints.length <= maxCodepoints) return clean
  return codepoints.slice(0, maxCodepoints).join('')
}

/**
 * Detect whether the current Linux environment is running inside WSL.
 * @param {{ platform?: string, env?: NodeJS.ProcessEnv, procVersion?: string }} [opts]
 * @returns {boolean}
 */
export function isWsl({ platform = process.platform, env = process.env, procVersion } = {}) {
  if (platform !== 'linux') return false
  if (env?.WSL_DISTRO_NAME || env?.WSL_INTEROP) return true
  if (typeof procVersion === 'string') {
    return /microsoft/i.test(procVersion)
  }
  try {
    const content = readFileSync('/proc/version', 'utf8')
    return /microsoft/i.test(content)
  } catch {
    return false
  }
}

/**
 * Escape XML special characters and strip NUL / invalid control characters.
 * @param {string} str
 * @returns {string}
 */
export function escapeXml(str) {
  const clean = (str == null ? '' : String(str))
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
  return clean
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Build an XML-escaped ToastGeneric payload for Windows notifications.
 * @param {{ title?: string, body?: string, silent?: boolean }} params
 * @returns {string}
 */
export function buildWindowsToastCommandPayload({ title = '', body = '', silent = false } = {}) {
  const safeTitle = stripAndTruncate(title, MAX_TITLE_CHARS)
  const safeBody = stripAndTruncate(body, MAX_BODY_CHARS)
  const audioNode = silent ? '<audio silent="true"/>' : ''
  return `<toast><visual><binding template="ToastGeneric"><text>${escapeXml(safeTitle)}</text><text>${escapeXml(safeBody)}</text></binding></visual>${audioNode}</toast>`
}

function runSpawn(spawnImpl, cmd, args, options, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false
    let exitFallbackTimer = null
    const stdoutChunks = []
    const stderrChunks = []
    let stdoutLen = 0
    let stderrLen = 0

    let child
    try {
      child = spawnImpl(cmd, args, options)
    } catch (error) {
      resolve({ ok: false, stdout: '', stderr: '', error: error?.message || 'spawn failed', spawnError: true })
      return
    }
    if (!child || typeof child.once !== 'function') {
      resolve({ ok: false, stdout: '', stderr: '', error: 'Invalid child process handle', spawnError: true })
      return
    }

    const timer = setTimeout(() => {
      try {
        child.kill?.('SIGKILL')
      } catch {
        try {
          child.kill?.()
        } catch {
          // Ignore kill errors
        }
      }
      finish({ ok: false, stdout: '', stderr: '', error: 'timeout' })
    }, timeoutMs)
    timer.unref?.()

    function collect(stream, chunks, getLen, setLen) {
      if (!stream || typeof stream.on !== 'function') return
      stream.on('data', (chunk) => {
        const len = getLen()
        if (len >= MAX_STDIO_BYTES) return
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
        const slice = buf.subarray(0, MAX_STDIO_BYTES - len)
        chunks.push(slice)
        setLen(len + slice.length)
      })
    }

    collect(child.stdout, stdoutChunks, () => stdoutLen, (n) => { stdoutLen = n })
    collect(child.stderr, stderrChunks, () => stderrLen, (n) => { stderrLen = n })

    function finish(result) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (exitFallbackTimer) clearTimeout(exitFallbackTimer)
      resolve(result)
    }

    child.once('error', (error) => {
      finish({
        ok: false,
        stdout: Buffer.concat(stdoutChunks).toString('utf8').trim(),
        stderr: Buffer.concat(stderrChunks).toString('utf8').trim(),
        error: error?.message || 'process error',
        spawnError: error?.code === 'ENOENT',
      })
    })

    const complete = (code, signal) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim()
      const stderr = Buffer.concat(stderrChunks).toString('utf8').replace(/\s+/g, ' ').trim()
      if (code === 0) {
        finish({ ok: true, stdout, stderr })
      } else {
        finish({
          ok: false,
          stdout,
          stderr,
          error: stderr || (signal ? `signal ${signal}` : `exit code ${code}`),
        })
      }
    }

    child.once('close', complete)
    child.once('exit', (code, signal) => {
      if (settled) return
      exitFallbackTimer = setTimeout(() => complete(code, signal), 25)
      exitFallbackTimer.unref?.()
    })
  })
}

/**
 * Send a native OS notification across Windows, WSL, macOS, and Linux.
 * Never throws; returns structured delivery metadata.
 */
export async function sendSystemNotification({
  title,
  body,
  urgency = 'normal',
  silent = false,
  platform = process.platform,
  env = process.env,
  spawnImpl = nodeSpawn,
} = {}) {
  const safeTitle = stripAndTruncate(title, MAX_TITLE_CHARS).trim()
  if (!safeTitle) {
    return { ok: false, channel: 'none', error: 'Notification title is required.' }
  }
  const safeBody = stripAndTruncate(body ?? '', MAX_BODY_CHARS)
  const wsl = isWsl({ platform, env })
  const scrubbedEnv = await getScrubbedEnv(env)

  if (platform === 'win32' || wsl) {
    const channel = wsl ? 'wsl' : 'winrt'
    const psArgs = ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', PS_TOAST_SCRIPT]
    const psOpts = {
      env: {
        ...scrubbedEnv,
        DSH_TOAST_TITLE: safeTitle,
        DSH_TOAST_BODY: safeBody,
        DSH_TOAST_SILENT: silent ? '1' : '0',
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
    let res = await runSpawn(spawnImpl, 'powershell.exe', psArgs, psOpts)
    if (!res.ok && wsl && res.spawnError) {
      res = await runSpawn(spawnImpl, WSL_POWERSHELL_FALLBACK, psArgs, psOpts)
    }
    return res.ok ? { ok: true, channel } : { ok: false, channel, error: res.error || 'Toast failed' }
  }

  if (platform === 'darwin') {
    const res = await runSpawn(
      spawnImpl,
      'osascript',
      ['-e', 'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run', safeTitle, safeBody],
      {
        env: scrubbedEnv,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    return res.ok
      ? { ok: true, channel: 'osascript' }
      : { ok: false, channel: 'osascript', error: res.error || 'osascript failed' }
  }

  if (platform === 'linux') {
    const level = urgency === 'critical' ? 'critical' : 'normal'
    const res = await runSpawn(
      spawnImpl,
      'notify-send',
      ['--app-name=DSH', `--urgency=${level}`, '--', safeTitle, safeBody],
      {
        env: scrubbedEnv,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    return res.ok
      ? { ok: true, channel: 'notify-send' }
      : { ok: false, channel: 'notify-send', error: res.error || 'notify-send failed' }
  }

  return { ok: false, channel: 'none', error: `Unsupported platform: ${platform}` }
}

async function runWindowsTaskbarFlash({
  mode,
  flashCount,
  targetPid,
  windowTitleHint,
  platform,
  spawnImpl,
}) {
  if (platform !== 'win32') {
    return { ok: true, skipped: true }
  }

  const parsedCount = Number(flashCount)
  const clampedCount = Number.isFinite(parsedCount)
    ? Math.min(MAX_FLASH_COUNT, Math.max(MIN_FLASH_COUNT, Math.round(parsedCount)))
    : DEFAULT_FLASH_COUNT

  const normalizedMode =
    mode === 'stop' ? 'stop' : mode === 'untilFocused' ? 'untilFocused' : 'finite'

  const parsedPid = Number(targetPid)
  const safePid = Number.isInteger(parsedPid) && parsedPid > 0 ? parsedPid : 0
  const safeHint = stripAndTruncate(windowTitleHint || 'DSH', 120).trim() || 'DSH'
  const scrubbedEnv = await getScrubbedEnv()

  const res = await runSpawn(
    spawnImpl,
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', PS_FLASH_SCRIPT],
    {
      env: {
        ...scrubbedEnv,
        DSH_FLASH_MODE: normalizedMode,
        DSH_FLASH_COUNT: normalizedMode === 'stop' ? '0' : String(clampedCount),
        DSH_TARGET_PID: String(safePid),
        DSH_WINDOW_HINT: safeHint,
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  if (!res.ok) {
    return { ok: false, error: res.error || 'FlashWindowEx failed' }
  }
  if (res.stdout === 'NO_HWND') {
    return { ok: true, skipped: true }
  }
  return { ok: true }
}

/**
 * Flash the Windows taskbar icon when DSH is unfocused.
 */
export async function flashTaskbar({
  mode = 'finite',
  flashCount = DEFAULT_FLASH_COUNT,
  targetPid = process.ppid,
  windowTitleHint = 'DSH',
  platform = process.platform,
  spawnImpl = nodeSpawn,
} = {}) {
  return runWindowsTaskbarFlash({
    mode: mode === 'untilFocused' ? 'untilFocused' : 'finite',
    flashCount,
    targetPid,
    windowTitleHint,
    platform,
    spawnImpl,
  })
}

/**
 * Stop any active Windows taskbar attention flashing (`FLASHW_STOP`).
 */
export async function clearTaskbarAttention({
  targetPid = process.ppid,
  windowTitleHint = 'DSH',
  platform = process.platform,
  spawnImpl = nodeSpawn,
} = {}) {
  return runWindowsTaskbarFlash({
    mode: 'stop',
    flashCount: 0,
    targetPid,
    windowTitleHint,
    platform,
    spawnImpl,
  })
}
