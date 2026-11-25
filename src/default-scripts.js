/**
 * Materializes cross-platform default Node ESM hook scripts under `$DSH_HOME/hooks/scripts/default/`.
 */

import { randomBytes } from 'node:crypto'
import { chmod, mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

function buildNotifyScript({ header, level }) {
  return `// ${header}
// Cross-platform DSH Hook script. Reads JSON payload from STDIN and outputs a directive JSON line.
// Return { "suppress": true } to suppress notification for matching events, or customize title/summary.

import { readFileSync } from 'node:fs'

let payload = {}
try {
  const raw = readFileSync(0, 'utf8').trim()
  if (raw) payload = JSON.parse(raw)
} catch {
  // Ignore malformed STDIN
}

const directive = {
  notify: true,
  level: ${JSON.stringify(level)},
  hookPoint: payload.hookPoint || process.env.DSH_HOOK_POINT || '',
}

process.stdout.write(JSON.stringify(directive) + '\\n')
`
}

const AUDIT_LOG_SCRIPT = `// DSH Hook Tool Audit Example Script
// Writes a compact, redacted JSONL audit entry under $DSH_HOME/hooks/logs/tool-audit.jsonl.
// Outputs { "suppress": true } by default so routine tool calls do not trigger notification spam;
// remove "suppress": true if you want every audited tool call to notify.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

let payload = {}
try {
  const raw = readFileSync(0, 'utf8').trim()
  if (raw) payload = JSON.parse(raw)
} catch {
  // Ignore malformed STDIN
}

const logsDir = path.resolve(import.meta.dirname, '../../logs')
mkdirSync(logsDir, { recursive: true })

const entry = {
  timestamp: payload.timestamp || new Date().toISOString(),
  eventId: payload.eventId || process.env.DSH_HOOK_EVENT_ID || null,
  hookPoint: payload.hookPoint || process.env.DSH_HOOK_POINT || 'tool.post',
  category: payload.category || process.env.DSH_HOOK_CATEGORY || 'UserPromptSubmit',
  sessionId: payload.sessionId || process.env.DSH_HOOK_SESSION_ID || null,
  projectName: payload.projectName || process.env.DSH_HOOK_PROJECT || null,
  toolName: payload.toolName || null,
}

appendFileSync(path.join(logsDir, 'tool-audit.jsonl'), JSON.stringify(entry) + '\\n', 'utf8')

process.stdout.write(JSON.stringify({
  notify: false,
  suppress: true,
  audited: true,
  summary: entry.toolName ? \`Audited tool: \${entry.toolName}\` : 'Tool audited',
}) + '\\n')
`

export const DEFAULT_SCRIPTS = Object.freeze([
  Object.freeze({
    id: 'notify-approval',
    filename: 'notify-approval.mjs',
    nameZh: '待审批通知脚本',
    nameEn: 'Approval Notification Script',
    enabledByDefault: true,
    content: buildNotifyScript({ header: 'DSH Default Hook: Approval Request', level: 'approval' }),
  }),
  Object.freeze({
    id: 'notify-attention',
    filename: 'notify-attention.mjs',
    nameZh: '需要关注通知脚本',
    nameEn: 'Attention Notification Script',
    enabledByDefault: true,
    content: buildNotifyScript({ header: 'DSH Default Hook: Needs Attention', level: 'attention' }),
  }),
  Object.freeze({
    id: 'notify-task-done',
    filename: 'notify-task-done.mjs',
    nameZh: '任务完成通知脚本',
    nameEn: 'Task Completed Notification Script',
    enabledByDefault: true,
    content: buildNotifyScript({ header: 'DSH Default Hook: Task Completed', level: 'success' }),
  }),
  Object.freeze({
    id: 'notify-task-failed',
    filename: 'notify-task-failed.mjs',
    nameZh: '任务失败通知脚本',
    nameEn: 'Task Failed Notification Script',
    enabledByDefault: true,
    content: buildNotifyScript({ header: 'DSH Default Hook: Task Failed', level: 'error' }),
  }),
  Object.freeze({
    id: 'notify-job-settled',
    filename: 'notify-job-settled.mjs',
    nameZh: '后台任务结束通知脚本',
    nameEn: 'Background Job Settled Script',
    enabledByDefault: false,
    content: buildNotifyScript({ header: 'DSH Default Hook: Job Settled', level: 'info' }),
  }),
  Object.freeze({
    id: 'notify-session-start',
    filename: 'notify-session-start.mjs',
    nameZh: '会话启动通知脚本',
    nameEn: 'Session Start Notification Script',
    enabledByDefault: false,
    content: buildNotifyScript({ header: 'DSH Default Hook: Session Start', level: 'info' }),
  }),
  Object.freeze({
    id: 'notify-subagent-end',
    filename: 'notify-subagent-end.mjs',
    nameZh: '子 Agent 完成通知脚本',
    nameEn: 'Subagent Finished Notification Script',
    enabledByDefault: false,
    content: buildNotifyScript({ header: 'DSH Default Hook: Subagent Finished', level: 'success' }),
  }),
  Object.freeze({
    id: 'audit-log-example',
    filename: 'audit-log-example.mjs',
    nameZh: '工具审计日志示例脚本',
    nameEn: 'Tool Audit Log Example Script',
    enabledByDefault: false,
    content: AUDIT_LOG_SCRIPT,
  }),
])

const DEFAULT_SCRIPT_MAP = new Map(DEFAULT_SCRIPTS.map((item) => [item.id, item]))

export function getDefaultScriptById(id) {
  return typeof id === 'string' ? DEFAULT_SCRIPT_MAP.get(id) : undefined
}

export function getDefaultScriptsDir(dataDir) {
  if (typeof dataDir !== 'string' || !dataDir.trim()) {
    throw new TypeError('dataDir must be a non-empty string')
  }
  return path.join(dataDir, 'hooks', 'scripts', 'default')
}

async function atomicWriteText(targetPath, content) {
  const tmpPath = `${targetPath}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  try {
    await writeFile(tmpPath, content, 'utf8')
    await rename(tmpPath, targetPath)
  } catch (error) {
    await unlink(tmpPath).catch(() => {})
    throw error
  }
}

/**
 * Materialize all 8 built-in `.mjs` scripts into `$DSH_HOME/hooks/scripts/default/`.
 * @param {string} dataDir
 * @param {{ overwrite?: boolean }} [opts]
 */
export async function ensureDefaultScripts(dataDir, { overwrite = false } = {}) {
  const dir = getDefaultScriptsDir(dataDir)
  await mkdir(dir, { recursive: true })
  const materialized = []
  for (const script of DEFAULT_SCRIPTS) {
    const filePath = path.join(dir, script.filename)
    let exists = false
    if (!overwrite) {
      try {
        const info = await stat(filePath)
        exists = info.isFile()
      } catch {
        exists = false
      }
    }
    if (overwrite || !exists) {
      await atomicWriteText(filePath, script.content)
      if (process.platform !== 'win32') {
        await chmod(filePath, 0o700).catch(() => {})
      }
    }
    materialized.push(filePath)
  }
  return materialized
}
