/**
 * Third-party hook notification provider definitions, validation, signing, and outbound HTTP adapters.
 */

import { createHmac } from 'node:crypto'

export const PROVIDER_IDS = Object.freeze([
  'bark',
  'dingtalk',
  'feishu',
  'telegram',
  'wecom',
  'pushplus',
  'wxpusher',
  'serverchan',
  'ntfy',
  'gotify',
  'custom',
])

const MAX_RESPONSE_BYTES = 64 * 1024
const DEFAULT_TIMEOUT_MS = 5000
const MAX_MESSAGE_CHARS = 160
const FORBIDDEN_CUSTOM_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection'])
const SAFE_HEADER_NAME_RE = /^[A-Za-z0-9-]+$/
const BARK_LEVELS = new Set(['', 'active', 'timeSensitive', 'passive', 'critical'])
const NTFY_AUTH_TYPES = new Set(['none', 'bearer', 'basic'])
const CUSTOM_METHODS = new Set(['POST', 'GET'])
const CUSTOM_BODY_TYPES = new Set(['json', 'form', 'text'])

export const PROVIDER_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'bark',
    labelZh: 'Bark',
    labelEn: 'Bark',
    fields: Object.freeze([
      {
        key: 'serverUrl',
        labelZh: '服务器地址',
        labelEn: 'Server URL',
        kind: 'text',
        required: false,
        defaultValue: 'https://api.day.app',
        placeholder: 'https://api.day.app',
      },
      { key: 'deviceKey', labelZh: 'Device Key', labelEn: 'Device Key', kind: 'secret', required: true },
      { key: 'group', labelZh: '分组 (可选)', labelEn: 'Group (optional)', kind: 'text', required: false },
      { key: 'sound', labelZh: '提示音 (可选)', labelEn: 'Sound (optional)', kind: 'text', required: false },
      {
        key: 'level',
        labelZh: '中断级别',
        labelEn: 'Level',
        kind: 'select',
        required: false,
        defaultValue: '',
        options: [
          { value: '', labelZh: '默认', labelEn: 'Default' },
          { value: 'active', labelZh: 'active', labelEn: 'active' },
          { value: 'timeSensitive', labelZh: 'timeSensitive', labelEn: 'timeSensitive' },
          { value: 'passive', labelZh: 'passive', labelEn: 'passive' },
          { value: 'critical', labelZh: 'critical', labelEn: 'critical' },
        ],
      },
      { key: 'basicUsername', labelZh: 'Basic 用户名 (可选)', labelEn: 'Basic Username', kind: 'text', required: false },
      { key: 'basicPassword', labelZh: 'Basic 密码 (可选)', labelEn: 'Basic Password', kind: 'secret', required: false },
    ]),
  }),
  Object.freeze({
    id: 'dingtalk',
    labelZh: '钉钉机器人',
    labelEn: 'DingTalk',
    fields: Object.freeze([
      {
        key: 'webhookUrl',
        labelZh: 'Webhook URL',
        labelEn: 'Webhook URL',
        kind: 'secret',
        required: true,
        placeholder: 'https://oapi.dingtalk.com/robot/send?access_token=...',
      },
      { key: 'secret', labelZh: '加签密钥 (可选)', labelEn: 'Signing Secret (optional)', kind: 'secret', required: false },
    ]),
  }),
  Object.freeze({
    id: 'feishu',
    labelZh: '飞书机器人',
    labelEn: 'Feishu / Lark',
    fields: Object.freeze([
      {
        key: 'webhookUrl',
        labelZh: 'Webhook URL',
        labelEn: 'Webhook URL',
        kind: 'secret',
        required: true,
        placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/...',
      },
      { key: 'secret', labelZh: '签名密钥 (可选)', labelEn: 'Signing Secret (optional)', kind: 'secret', required: false },
    ]),
  }),
  Object.freeze({
    id: 'telegram',
    labelZh: 'Telegram',
    labelEn: 'Telegram',
    fields: Object.freeze([
      { key: 'botToken', labelZh: 'Bot Token', labelEn: 'Bot Token', kind: 'secret', required: true },
      { key: 'chatId', labelZh: 'Chat ID', labelEn: 'Chat ID', kind: 'text', required: true },
      { key: 'messageThreadId', labelZh: 'Thread ID (可选)', labelEn: 'Thread ID (optional)', kind: 'number', required: false },
    ]),
  }),
  Object.freeze({
    id: 'wecom',
    labelZh: '企业微信',
    labelEn: 'WeCom',
    fields: Object.freeze([
      {
        key: 'webhookUrl',
        labelZh: 'Webhook URL',
        labelEn: 'Webhook URL',
        kind: 'secret',
        required: true,
        placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...',
      },
    ]),
  }),
  Object.freeze({
    id: 'pushplus',
    labelZh: 'PushPlus',
    labelEn: 'PushPlus',
    fields: Object.freeze([
      { key: 'token', labelZh: 'Token', labelEn: 'Token', kind: 'secret', required: true },
      { key: 'template', labelZh: '模板', labelEn: 'Template', kind: 'text', required: false, defaultValue: 'txt' },
      { key: 'channel', labelZh: '发送渠道 (可选)', labelEn: 'Channel (optional)', kind: 'text', required: false },
      { key: 'topic', labelZh: '群组编码 (可选)', labelEn: 'Topic (optional)', kind: 'text', required: false },
      { key: 'webhook', labelZh: 'Webhook 编码 (可选)', labelEn: 'Webhook (optional)', kind: 'text', required: false },
    ]),
  }),
  Object.freeze({
    id: 'wxpusher',
    labelZh: 'WxPusher',
    labelEn: 'WxPusher',
    fields: Object.freeze([
      { key: 'spt', labelZh: 'SPT (推荐)', labelEn: 'SPT (recommended)', kind: 'secret', required: false },
      { key: 'appToken', labelZh: 'App Token (无 SPT 时必填)', labelEn: 'App Token (if no SPT)', kind: 'secret', required: false },
      { key: 'uids', labelZh: 'UID 列表 (逗号分隔)', labelEn: 'UIDs (CSV)', kind: 'csv', required: false },
      { key: 'topicIds', labelZh: 'Topic ID 列表 (逗号分隔)', labelEn: 'Topic IDs (CSV)', kind: 'numberCsv', required: false },
    ]),
  }),
  Object.freeze({
    id: 'serverchan',
    labelZh: 'Server 酱',
    labelEn: 'ServerChan',
    fields: Object.freeze([
      { key: 'sendKey', labelZh: 'SendKey', labelEn: 'SendKey', kind: 'secret', required: true },
    ]),
  }),
  Object.freeze({
    id: 'ntfy',
    labelZh: 'ntfy',
    labelEn: 'ntfy',
    fields: Object.freeze([
      {
        key: 'serverUrl',
        labelZh: '服务器地址',
        labelEn: 'Server URL',
        kind: 'text',
        required: false,
        defaultValue: 'https://ntfy.sh',
        placeholder: 'https://ntfy.sh',
      },
      { key: 'topic', labelZh: 'Topic', labelEn: 'Topic', kind: 'secret', required: true },
      {
        key: 'authType',
        labelZh: '认证方式',
        labelEn: 'Auth Type',
        kind: 'select',
        required: false,
        defaultValue: 'none',
        options: [
          { value: 'none', labelZh: '无认证', labelEn: 'None' },
          { value: 'bearer', labelZh: 'Bearer Token', labelEn: 'Bearer Token' },
          { value: 'basic', labelZh: 'Basic Auth', labelEn: 'Basic Auth' },
        ],
      },
      { key: 'authToken', labelZh: 'Bearer Token', labelEn: 'Bearer Token', kind: 'secret', required: false },
      { key: 'basicUsername', labelZh: 'Basic 用户名', labelEn: 'Basic Username', kind: 'text', required: false },
      { key: 'basicPassword', labelZh: 'Basic 密码', labelEn: 'Basic Password', kind: 'secret', required: false },
      { key: 'priority', labelZh: '优先级 (1-5)', labelEn: 'Priority (1-5)', kind: 'text', required: false },
      { key: 'tags', labelZh: '标签 (逗号分隔)', labelEn: 'Tags (CSV)', kind: 'text', required: false },
    ]),
  }),
  Object.freeze({
    id: 'gotify',
    labelZh: 'Gotify',
    labelEn: 'Gotify',
    fields: Object.freeze([
      {
        key: 'serverUrl',
        labelZh: '服务器地址',
        labelEn: 'Server URL',
        kind: 'text',
        required: true,
        defaultValue: '',
        placeholder: 'https://gotify.example.com',
      },
      { key: 'appToken', labelZh: 'App Token', labelEn: 'App Token', kind: 'secret', required: true },
      { key: 'priority', labelZh: '优先级', labelEn: 'Priority', kind: 'number', required: false, defaultValue: 5 },
    ]),
  }),
  Object.freeze({
    id: 'custom',
    labelZh: '自定义 HTTP',
    labelEn: 'Custom HTTP',
    fields: Object.freeze([
      {
        key: 'method',
        labelZh: '请求方法',
        labelEn: 'Method',
        kind: 'select',
        required: false,
        defaultValue: 'POST',
        options: [
          { value: 'POST', labelZh: 'POST', labelEn: 'POST' },
          { value: 'GET', labelZh: 'GET', labelEn: 'GET' },
        ],
      },
      {
        key: 'url',
        labelZh: '请求 URL',
        labelEn: 'URL',
        kind: 'secret',
        required: true,
        placeholder: 'https://example.com/hook',
      },
      {
        key: 'bodyType',
        labelZh: '请求体格式',
        labelEn: 'Body Type',
        kind: 'select',
        required: false,
        defaultValue: 'json',
        options: [
          { value: 'json', labelZh: 'JSON', labelEn: 'JSON' },
          { value: 'form', labelZh: 'Form (urlencoded)', labelEn: 'Form' },
          { value: 'text', labelZh: '纯文本', labelEn: 'Plain Text' },
        ],
      },
      { key: 'query', labelZh: 'Query 参数 (每行 key=value)', labelEn: 'Query Params (key=value lines)', kind: 'kvLines', required: false },
      { key: 'headers', labelZh: '请求头 (每行 key=value)', labelEn: 'Headers (key=value lines)', kind: 'kvLines', required: false },
      {
        key: 'jsonBody',
        labelZh: 'JSON 模板',
        labelEn: 'JSON Body Template',
        kind: 'textarea',
        required: false,
        defaultValue: '{"title":"{{title}}","body":"{{body}}"}',
      },
      { key: 'formBody', labelZh: 'Form 字段 (每行 key=value)', labelEn: 'Form Body (key=value lines)', kind: 'kvLines', required: false },
      { key: 'textBody', labelZh: '纯文本模板', labelEn: 'Text Body Template', kind: 'textarea', required: false },
    ]),
  }),
])

const PROVIDER_MAP = new Map(PROVIDER_DEFINITIONS.map((def) => [def.id, def]))

export function getProviderDefinition(provider) {
  return typeof provider === 'string' ? PROVIDER_MAP.get(provider) : undefined
}

/**
 * Return the field keys marked `kind === 'secret'` for a given provider.
 * @param {string} provider
 * @returns {string[]}
 */
export function getSecretFieldKeys(provider) {
  const def = getProviderDefinition(provider)
  if (!def) return []
  return def.fields.filter((field) => field.kind === 'secret').map((field) => field.key)
}

function asTrimmedString(val) {
  return typeof val === 'string' ? val.trim() : val == null ? '' : String(val).trim()
}

function parseCsvStrings(raw) {
  if (Array.isArray(raw)) {
    return raw.map((item) => asTrimmedString(item)).filter(Boolean)
  }
  if (typeof raw === 'string') {
    return raw
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return []
}

function parseNumberCsv(raw) {
  const items = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean)
      : []
  const parsed = []
  for (const item of items) {
    const num = Number(item)
    if (!Number.isInteger(num)) {
      return { valid: false, values: [] }
    }
    parsed.push(num)
  }
  return { valid: true, values: parsed }
}

function parseKvLines(raw) {
  if (Array.isArray(raw)) {
    const rows = []
    for (const entry of raw) {
      if (entry && typeof entry === 'object' && typeof entry.key === 'string') {
        const key = entry.key.trim()
        if (key) rows.push({ key, value: entry.value == null ? '' : String(entry.value) })
      }
    }
    return rows
  }
  if (typeof raw !== 'string') return []
  const rows = []
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const idx = line.indexOf('=')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    if (key) rows.push({ key, value })
  }
  return rows
}

function validateHttpUrl(rawUrl, label = 'URL') {
  const trimmed = asTrimmedString(rawUrl)
  if (!trimmed) {
    return { valid: false, error: `${label} is required.` }
  }
  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    return { valid: false, error: `${label} is not a valid URL.` }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, error: `${label} must use http: or https: protocol.` }
  }
  if (!parsed.hostname) {
    return { valid: false, error: `${label} must include a valid host.` }
  }
  if (parsed.username || parsed.password) {
    return { valid: false, error: `${label} must not embed username or password credentials.` }
  }
  return { valid: true, url: parsed }
}

function validateCustomHeaders(rawHeaders) {
  const rows = parseKvLines(rawHeaders)
  for (const { key, value } of rows) {
    if (!SAFE_HEADER_NAME_RE.test(key)) {
      return { valid: false, error: `Invalid header name: ${key}` }
    }
    if (FORBIDDEN_CUSTOM_HEADERS.has(key.toLowerCase())) {
      return { valid: false, error: `Header "${key}" is forbidden.` }
    }
    if (/[\r\n\0]/.test(value)) {
      return { valid: false, error: `Header "${key}" contains invalid control characters.` }
    }
  }
  return { valid: true, rows }
}

function encodeHeaderValue(val) {
  const clean = String(val ?? '').replace(/[\r\n\0]+/g, ' ').trim()
  if (/^[\x20-\x7e]*$/.test(clean)) return clean
  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`
}

function truncateMessage(text) {
  const clean = String(text ?? '')
    .replace(/[\r\n\t\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const chars = Array.from(clean)
  return chars.length <= MAX_MESSAGE_CHARS ? clean : chars.slice(0, MAX_MESSAGE_CHARS).join('')
}

/**
 * Validate a merged provider configuration (non-secret fields + resolved secrets).
 * @param {string} provider
 * @param {Record<string, unknown>} mergedConfig
 * @returns {{ valid: boolean, error?: string, errors?: string[] }}
 */
export function validateProviderConfig(provider, mergedConfig = {}) {
  const def = getProviderDefinition(provider)
  if (!def) {
    const error = `Unknown provider: ${String(provider)}`
    return { valid: false, error, errors: [error] }
  }
  if (mergedConfig !== null && mergedConfig !== undefined && (typeof mergedConfig !== 'object' || Array.isArray(mergedConfig))) {
    const error = 'Provider configuration must be an object.'
    return { valid: false, error, errors: [error] }
  }
  const cfg = mergedConfig || {}
  const errors = []

  const pushErr = (msg) => {
    if (msg) errors.push(msg)
  }

  switch (provider) {
    case 'dingtalk':
    case 'feishu':
    case 'wecom': {
      const check = validateHttpUrl(cfg.webhookUrl, 'webhookUrl')
      if (!check.valid) pushErr(check.error)
      break
    }

    case 'bark': {
      const serverUrl = asTrimmedString(cfg.serverUrl) || 'https://api.day.app'
      const urlCheck = validateHttpUrl(serverUrl, 'serverUrl')
      if (!urlCheck.valid) pushErr(urlCheck.error)
      const deviceKey = asTrimmedString(cfg.deviceKey)
      if (!deviceKey) {
        pushErr('deviceKey is required.')
      } else if (/[/?#\s\x00-\x1f]/.test(deviceKey)) {
        pushErr('deviceKey contains invalid characters.')
      }
      const level = asTrimmedString(cfg.level)
      if (level && !BARK_LEVELS.has(level)) {
        pushErr(`Invalid Bark level: ${level}`)
      }
      const user = asTrimmedString(cfg.basicUsername)
      const pass = asTrimmedString(cfg.basicPassword)
      if ((user && !pass) || (!user && pass)) {
        pushErr('Both basicUsername and basicPassword are required for Basic auth.')
      }
      break
    }

    case 'pushplus': {
      if (!asTrimmedString(cfg.token)) {
        pushErr('token is required.')
      }
      break
    }

    case 'wxpusher': {
      const spt = asTrimmedString(cfg.spt)
      const appToken = asTrimmedString(cfg.appToken)
      if (!spt && !appToken) {
        pushErr('WxPusher requires spt or appToken.')
      }
      if (cfg.topicIds !== undefined && cfg.topicIds !== null && String(cfg.topicIds).trim() !== '') {
        const parsedTopics = parseNumberCsv(cfg.topicIds)
        if (!parsedTopics.valid) {
          pushErr('topicIds must be comma-separated integers.')
        }
      }
      break
    }

    case 'serverchan': {
      const sendKey = asTrimmedString(cfg.sendKey)
      if (!sendKey) {
        pushErr('sendKey is required.')
      } else if (!/^[A-Za-z0-9_-]+$/.test(sendKey)) {
        pushErr('sendKey contains invalid characters.')
      }
      break
    }

    case 'telegram': {
      const botToken = asTrimmedString(cfg.botToken)
      if (!botToken) {
        pushErr('botToken is required.')
      } else if (!/^[A-Za-z0-9_:-]+$/.test(botToken)) {
        pushErr('botToken contains invalid characters.')
      }
      if (!asTrimmedString(cfg.chatId)) {
        pushErr('chatId is required.')
      }
      const threadRaw = asTrimmedString(cfg.messageThreadId)
      if (threadRaw && !Number.isInteger(Number(threadRaw))) {
        pushErr('messageThreadId must be an integer.')
      }
      break
    }

    case 'ntfy': {
      const serverUrl = asTrimmedString(cfg.serverUrl) || 'https://ntfy.sh'
      const urlCheck = validateHttpUrl(serverUrl, 'serverUrl')
      if (!urlCheck.valid) pushErr(urlCheck.error)
      const topic = asTrimmedString(cfg.topic)
      if (!topic) {
        pushErr('topic is required.')
      } else if (/[/?#\x00-\x1f]/.test(topic)) {
        pushErr('topic contains invalid characters.')
      }
      const authType = asTrimmedString(cfg.authType) || 'none'
      if (!NTFY_AUTH_TYPES.has(authType)) {
        pushErr(`Invalid authType: ${authType}`)
      } else if (authType === 'bearer' && !asTrimmedString(cfg.authToken)) {
        pushErr('authToken is required for bearer authentication.')
      } else if (authType === 'basic' && (!asTrimmedString(cfg.basicUsername) || !asTrimmedString(cfg.basicPassword))) {
        pushErr('basicUsername and basicPassword are required for basic authentication.')
      }
      break
    }

    case 'gotify': {
      const urlCheck = validateHttpUrl(cfg.serverUrl, 'serverUrl')
      if (!urlCheck.valid) pushErr(urlCheck.error)
      if (!asTrimmedString(cfg.appToken)) {
        pushErr('appToken is required.')
      }
      const prioRaw = asTrimmedString(cfg.priority)
      if (prioRaw && !Number.isInteger(Number(prioRaw))) {
        pushErr('priority must be an integer.')
      }
      break
    }

    case 'custom': {
      const method = (asTrimmedString(cfg.method) || 'POST').toUpperCase()
      if (!CUSTOM_METHODS.has(method)) {
        pushErr(`Unsupported HTTP method: ${method}`)
      }
      const urlCheck = validateHttpUrl(cfg.url, 'url')
      if (!urlCheck.valid) pushErr(urlCheck.error)
      const bodyType = (asTrimmedString(cfg.bodyType) || 'json').toLowerCase()
      if (!CUSTOM_BODY_TYPES.has(bodyType)) {
        pushErr(`Unsupported bodyType: ${bodyType}`)
      }
      const headerCheck = validateCustomHeaders(cfg.headers)
      if (!headerCheck.valid) pushErr(headerCheck.error)
      if (method === 'POST' && bodyType === 'json') {
        const jsonTemplate = asTrimmedString(cfg.jsonBody) || '{"title":"{{title}}","body":"{{body}}"}'
        try {
          JSON.parse(jsonTemplate)
        } catch {
          pushErr('jsonBody must be valid JSON.')
        }
      }
      break
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, error: errors[0], errors }
}

function getTemplateVars(message = {}) {
  return {
    title: String(message.title ?? ''),
    body: String(message.body ?? ''),
    event: String(message.event ?? ''),
    source: String(message.source ?? 'DSH'),
    project: String(message.project ?? ''),
    time: String(message.time ?? ''),
    id: String(message.id ?? ''),
  }
}

function applyTemplate(str, vars, { urlEncode = false } = {}) {
  return String(str).replace(/\{\{(title|body|event|source|project|time|id)\}\}/g, (_, key) => {
    const val = vars[key] ?? ''
    return urlEncode ? encodeURIComponent(val) : val
  })
}

function replaceJsonLeaves(node, vars) {
  if (typeof node === 'string') {
    return applyTemplate(node, vars)
  }
  if (Array.isArray(node)) {
    return node.map((item) => replaceJsonLeaves(item, vars))
  }
  if (node && typeof node === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(node)) {
      out[k] = replaceJsonLeaves(v, vars)
    }
    return out
  }
  return node
}

function buildProviderRequest(provider, cfg, message) {
  const title = String(message?.title ?? 'DSH Hook')
  const body = String(message?.body ?? title)

  switch (provider) {
    case 'dingtalk': {
      const url = new URL(asTrimmedString(cfg.webhookUrl))
      const secret = asTrimmedString(cfg.secret)
      if (secret) {
        const ts = String(Date.now())
        const sign = createHmac('sha256', secret).update(`${ts}\n${secret}`, 'utf8').digest('base64')
        url.searchParams.set('timestamp', ts)
        url.searchParams.set('sign', sign)
      }
      return {
        url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ msgtype: 'text', text: { content: body } }),
        evaluate(status, json) {
          const code = json?.errcode ?? null
          const accepted = status >= 200 && status < 300 && json?.errcode === 0
          return {
            accepted,
            code,
            message: accepted ? 'OK' : truncateMessage(json?.errmsg || `DingTalk error (HTTP ${status})`),
            deliveryId: null,
          }
        },
      }
    }

    case 'feishu': {
      const url = new URL(asTrimmedString(cfg.webhookUrl))
      const secret = asTrimmedString(cfg.secret)
      const payload = { msg_type: 'text', content: { text: body } }
      if (secret) {
        const ts = String(Math.floor(Date.now() / 1000))
        const key = `${ts}\n${secret}`
        payload.timestamp = ts
        payload.sign = createHmac('sha256', Buffer.from(key, 'utf8')).update(Buffer.alloc(0)).digest('base64')
      }
      return {
        url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(payload),
        evaluate(status, json) {
          const code = json?.code ?? null
          const accepted = status >= 200 && status < 300 && json?.code === 0
          return {
            accepted,
            code,
            message: accepted ? 'OK' : truncateMessage(json?.msg || `Feishu error (HTTP ${status})`),
            deliveryId: null,
          }
        },
      }
    }

    case 'wecom': {
      const url = new URL(asTrimmedString(cfg.webhookUrl))
      return {
        url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ msgtype: 'text', text: { content: body } }),
        evaluate(status, json) {
          const code = json?.errcode ?? null
          const accepted = status >= 200 && status < 300 && json?.errcode === 0
          return {
            accepted,
            code,
            message: accepted ? 'OK' : truncateMessage(json?.errmsg || `WeCom error (HTTP ${status})`),
            deliveryId: null,
          }
        },
      }
    }

    case 'bark': {
      const base = (asTrimmedString(cfg.serverUrl) || 'https://api.day.app').replace(/\/+$/, '')
      const url = new URL(`${base}/${encodeURIComponent(asTrimmedString(cfg.deviceKey))}`)
      const headers = { 'Content-Type': 'application/json; charset=utf-8' }
      const user = asTrimmedString(cfg.basicUsername)
      const pass = asTrimmedString(cfg.basicPassword)
      if (user && pass) {
        headers.Authorization = `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`
      }
      const payload = { title, body }
      const group = asTrimmedString(cfg.group)
      const sound = asTrimmedString(cfg.sound)
      const level = asTrimmedString(cfg.level)
      if (group) payload.group = group
      if (sound) payload.sound = sound
      if (level) payload.level = level
      return {
        url,
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        evaluate(status, json) {
          const code = json?.code ?? null
          const accepted = status >= 200 && status < 300 && json?.code === 200
          return {
            accepted,
            code,
            message: accepted ? 'OK' : truncateMessage(json?.message || `Bark error (HTTP ${status})`),
            deliveryId: null,
          }
        },
      }
    }

    case 'pushplus': {
      const url = new URL('https://www.pushplus.plus/send')
      const payload = {
        token: asTrimmedString(cfg.token),
        title,
        content: body,
        template: asTrimmedString(cfg.template) || 'txt',
      }
      const channel = asTrimmedString(cfg.channel)
      const topic = asTrimmedString(cfg.topic)
      const webhook = asTrimmedString(cfg.webhook)
      if (channel) payload.channel = channel
      if (topic) payload.topic = topic
      if (webhook) payload.webhook = webhook
      return {
        url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(payload),
        evaluate(status, json) {
          const code = json?.code ?? null
          const accepted = status >= 200 && status < 300 && json?.code === 200
          return {
            accepted,
            code,
            message: accepted ? 'OK' : truncateMessage(json?.msg || `PushPlus error (HTTP ${status})`),
            deliveryId: json?.data != null ? String(json.data) : null,
          }
        },
      }
    }

    case 'wxpusher': {
      const url = new URL('https://wxpusher.zjiecode.com/api/send/message')
      const payload = {
        content: body,
        summary: title,
        contentType: 1,
      }
      const spt = asTrimmedString(cfg.spt)
      if (spt) {
        payload.spt = spt
      } else {
        payload.appToken = asTrimmedString(cfg.appToken)
        const uids = parseCsvStrings(cfg.uids)
        if (uids.length > 0) payload.uids = uids
        const topicIds = parseNumberCsv(cfg.topicIds)
        if (topicIds.valid && topicIds.values.length > 0) payload.topicIds = topicIds.values
      }
      return {
        url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(payload),
        evaluate(status, json) {
          const code = json?.code ?? null
          const accepted = status >= 200 && status < 300 && json?.code === 1000
          return {
            accepted,
            code,
            message: accepted ? 'OK' : truncateMessage(json?.msg || `WxPusher error (HTTP ${status})`),
            deliveryId: null,
          }
        },
      }
    }

    case 'serverchan': {
      const sendKey = asTrimmedString(cfg.sendKey)
      const url = sendKey.startsWith('sctp')
        ? new URL(`https://${sendKey}.push.ft07.com/send`)
        : new URL(`https://sctapi.ftqq.com/${sendKey}.send`)
      return {
        url,
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
        body: new URLSearchParams({ title, desp: body }).toString(),
        evaluate(status, json) {
          const code = json?.code ?? null
          const accepted = status >= 200 && status < 300 && json?.code === 0
          return {
            accepted,
            code,
            message: accepted ? 'OK' : truncateMessage(json?.message || json?.errmsg || `ServerChan error (HTTP ${status})`),
            deliveryId: json?.data?.pushid != null ? String(json.data.pushid) : null,
          }
        },
      }
    }

    case 'telegram': {
      const botToken = asTrimmedString(cfg.botToken)
      const url = new URL(`https://api.telegram.org/bot${botToken}/sendMessage`)
      const payload = {
        chat_id: asTrimmedString(cfg.chatId),
        text: body,
        disable_web_page_preview: true,
      }
      const threadRaw = asTrimmedString(cfg.messageThreadId)
      if (threadRaw) {
        payload.message_thread_id = Number(threadRaw)
      }
      return {
        url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(payload),
        evaluate(status, json) {
          const accepted = status >= 200 && status < 300 && json?.ok === true
          return {
            accepted,
            code: json?.error_code ?? (accepted ? 0 : null),
            message: accepted ? 'OK' : truncateMessage(json?.description || `Telegram error (HTTP ${status})`),
            deliveryId: json?.result?.message_id != null ? String(json.result.message_id) : null,
          }
        },
      }
    }

    case 'ntfy': {
      const base = (asTrimmedString(cfg.serverUrl) || 'https://ntfy.sh').replace(/\/+$/, '')
      const url = new URL(`${base}/${encodeURIComponent(asTrimmedString(cfg.topic))}`)
      const headers = {
        'Content-Type': 'text/plain; charset=utf-8',
        Title: encodeHeaderValue(title),
      }
      const priority = asTrimmedString(cfg.priority)
      const tags = asTrimmedString(cfg.tags)
      if (priority) headers.Priority = encodeHeaderValue(priority)
      if (tags) headers.Tags = encodeHeaderValue(tags)

      const authType = asTrimmedString(cfg.authType) || 'none'
      if (authType === 'bearer') {
        headers.Authorization = `Bearer ${asTrimmedString(cfg.authToken)}`
      } else if (authType === 'basic') {
        const creds = `${asTrimmedString(cfg.basicUsername)}:${asTrimmedString(cfg.basicPassword)}`
        headers.Authorization = `Basic ${Buffer.from(creds, 'utf8').toString('base64')}`
      }
      return {
        url,
        method: 'POST',
        headers,
        body,
        evaluate(status, json) {
          const hasId = typeof json?.id === 'string' && json.id.length > 0
          const accepted = status >= 200 && status < 300 && hasId
          return {
            accepted,
            code: json?.code ?? (accepted ? status : null),
            message: accepted ? 'OK' : truncateMessage(json?.error || `ntfy error (HTTP ${status})`),
            deliveryId: hasId ? json.id : null,
          }
        },
      }
    }

    case 'gotify': {
      const base = asTrimmedString(cfg.serverUrl).replace(/\/+$/, '')
      const url = new URL(`${base}/message`)
      url.searchParams.set('token', asTrimmedString(cfg.appToken))
      const priorityRaw = asTrimmedString(cfg.priority)
      const priority = priorityRaw === '' ? 5 : Math.trunc(Number(priorityRaw))
      return {
        url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ title, message: body, priority }),
        evaluate(status, json) {
          const hasId = json?.id !== undefined && json?.id !== null
          const accepted = status >= 200 && status < 300 && hasId
          return {
            accepted,
            code: json?.errorCode ?? (accepted ? status : null),
            message: accepted ? 'OK' : truncateMessage(json?.errorDescription || json?.error || `Gotify error (HTTP ${status})`),
            deliveryId: hasId ? String(json.id) : null,
          }
        },
      }
    }

    case 'custom': {
      const vars = getTemplateVars(message)
      const method = (asTrimmedString(cfg.method) || 'POST').toUpperCase()
      const renderedUrl = applyTemplate(asTrimmedString(cfg.url), vars, { urlEncode: true })
      const url = new URL(renderedUrl)
      if (url.username || url.password || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
        throw new Error('Invalid rendered custom URL')
      }
      for (const { key, value } of parseKvLines(cfg.query)) {
        url.searchParams.append(key, applyTemplate(value, vars))
      }

      const headers = {}
      let hasContentType = false
      for (const { key, value } of parseKvLines(cfg.headers)) {
        if (key.toLowerCase() === 'content-type') hasContentType = true
        headers[key] = encodeHeaderValue(applyTemplate(value, vars))
      }

      let reqBody
      if (method === 'POST') {
        const bodyType = (asTrimmedString(cfg.bodyType) || 'json').toLowerCase()
        if (bodyType === 'json') {
          if (!hasContentType) headers['Content-Type'] = 'application/json; charset=utf-8'
          const parsed = JSON.parse(asTrimmedString(cfg.jsonBody) || '{"title":"{{title}}","body":"{{body}}"}')
          reqBody = JSON.stringify(replaceJsonLeaves(parsed, vars))
        } else if (bodyType === 'form') {
          if (!hasContentType) headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=utf-8'
          const params = new URLSearchParams()
          for (const { key, value } of parseKvLines(cfg.formBody)) {
            params.append(key, applyTemplate(value, vars))
          }
          reqBody = params.toString()
        } else {
          if (!hasContentType) headers['Content-Type'] = 'text/plain; charset=utf-8'
          reqBody = applyTemplate(cfg.textBody == null ? '{{body}}' : String(cfg.textBody), vars)
        }
      }

      return {
        url,
        method,
        headers,
        body: reqBody,
        evaluate(status, json, rawText) {
          const accepted = status >= 200 && status < 300
          return {
            accepted,
            code: status,
            message: accepted ? 'OK' : truncateMessage(json?.message || json?.error || rawText || `HTTP ${status}`),
            deliveryId: json?.id != null ? String(json.id) : null,
          }
        },
      }
    }

    default:
      throw new Error(`Unsupported provider: ${provider}`)
  }
}

async function readCappedBodyText(response) {
  if (response?.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader()
    const chunks = []
    let total = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value || value.byteLength === 0) continue
        const remaining = MAX_RESPONSE_BYTES - total
        if (remaining <= 0) {
          await reader.cancel().catch(() => {})
          break
        }
        const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value
        chunks.push(slice)
        total += slice.byteLength
        if (total >= MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => {})
          break
        }
      }
    } finally {
      try {
        reader.releaseLock?.()
      } catch {
        // Ignore release errors
      }
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))).toString('utf8')
  }
  if (typeof response?.text === 'function') {
    const text = await response.text()
    return typeof text === 'string' ? text.slice(0, MAX_RESPONSE_BYTES) : ''
  }
  if (typeof response?.json === 'function') {
    const json = await response.json()
    return JSON.stringify(json ?? null).slice(0, MAX_RESPONSE_BYTES)
  }
  return ''
}

/**
 * Dispatch a redacted notification message to a single third-party provider target.
 * Never logs or returns secrets or full URLs (errors reference host only).
 */
export async function sendToProvider(
  provider,
  mergedConfig,
  message,
  { fetchImpl = globalThis.fetch, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
  const check = validateProviderConfig(provider, mergedConfig)
  if (!check.valid) {
    return {
      accepted: false,
      httpStatus: null,
      code: null,
      message: truncateMessage(check.error || 'Invalid provider configuration'),
      deliveryId: null,
      errorCode: 'provider/invalid-config',
    }
  }
  if (typeof fetchImpl !== 'function') {
    return {
      accepted: false,
      httpStatus: null,
      code: null,
      message: 'Fetch implementation is unavailable.',
      deliveryId: null,
      errorCode: 'provider/network',
    }
  }
  if (signal?.aborted) {
    return {
      accepted: false,
      httpStatus: null,
      code: null,
      message: 'Request aborted.',
      deliveryId: null,
      errorCode: 'provider/aborted',
    }
  }

  let spec
  try {
    spec = buildProviderRequest(provider, mergedConfig || {}, message)
  } catch (error) {
    return {
      accepted: false,
      httpStatus: null,
      code: null,
      message: truncateMessage(error?.message || 'Failed to build provider request'),
      deliveryId: null,
      errorCode: 'provider/invalid-config',
    }
  }

  const host = spec.url.host
  const boundedTimeout =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(Math.round(timeoutMs), 60_000) : DEFAULT_TIMEOUT_MS

  const localTimeout = new AbortController()
  const combinedSignal = signal ? AbortSignal.any([signal, localTimeout.signal]) : localTimeout.signal

  let timer
  let onAbort
  const abortPromise = new Promise((_, reject) => {
    onAbort = () => reject(new Error(signal?.aborted ? 'aborted' : 'timeout'))
    combinedSignal.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => {
      localTimeout.abort(new DOMException(`Timed out after ${boundedTimeout}ms`, 'TimeoutError'))
    }, boundedTimeout)
    timer.unref?.()
  })

  try {
    const execute = async () => {
      const response = await fetchImpl(spec.url.href, {
        method: spec.method,
        headers: spec.headers,
        body: spec.body,
        redirect: 'error',
        credentials: 'omit',
        signal: combinedSignal,
      })

      const httpStatus = response?.status ?? null
      if (response?.redirected) {
        void response.body?.cancel?.().catch(() => {})
        return {
          accepted: false,
          httpStatus,
          code: null,
          message: `Redirect blocked for ${host}`,
          deliveryId: null,
          errorCode: 'provider/redirect',
        }
      }

      const rawText = await readCappedBodyText(response)
      let json = null
      if (rawText) {
        try {
          json = JSON.parse(rawText)
        } catch {
          json = null
        }
      }

      const verdict = spec.evaluate(Number(httpStatus), json, rawText)
      return {
        accepted: Boolean(verdict.accepted),
        httpStatus,
        code: verdict.code ?? null,
        message: truncateMessage(verdict.message || (verdict.accepted ? 'OK' : `HTTP ${httpStatus}`)),
        deliveryId: verdict.deliveryId ?? null,
        errorCode: verdict.accepted
          ? null
          : httpStatus && (httpStatus < 200 || httpStatus >= 300)
            ? 'provider/http'
            : 'provider/rejected',
      }
    }

    return await Promise.race([execute(), abortPromise])
  } catch (error) {
    const isTimeout = localTimeout.signal.aborted || error?.name === 'TimeoutError' || error?.message === 'timeout'
    const isAborted = !isTimeout && Boolean(signal?.aborted)
    return {
      accepted: false,
      httpStatus: null,
      code: null,
      message: truncateMessage(
        isAborted
          ? `Request aborted (${host})`
          : isTimeout
            ? `Request timed out after ${boundedTimeout}ms (${host})`
            : `Network request failed (${host})`,
      ),
      deliveryId: null,
      errorCode: isAborted ? 'provider/aborted' : isTimeout ? 'provider/timeout' : 'provider/network',
    }
  } finally {
    clearTimeout(timer)
    combinedSignal.removeEventListener('abort', onAbort)
  }
}
