export type NotificationCategory =
  | 'PermissionRequest'
  | 'Notification'
  | 'Stop'
  | 'StopFailure'
  | 'SessionStart'
  | 'UserPromptSubmit'

export type HookVariant = 'approval' | 'attention' | 'success' | 'error' | 'info'

export interface CategoryMeta {
  icon: string
  labelZh: string
  labelEn: string
  variant: HookVariant
  defaultSelected: boolean
}

export type HookGroup = 'core' | 'session_tools' | 'subsystems'

export interface HookMountPointDef {
  id: string
  group: HookGroup
  nameZh: string
  nameEn: string
  descZh: string
  descEn: string
  dshEvents: string[]
  category: NotificationCategory
  defaultEnabled: boolean
  defaultBell: boolean
  supportsMatcher?: boolean
  defaultScriptIds: string[]
}

export interface HookScriptItem {
  id: string
  kind: 'default' | 'custom'
  name: string
  filename: string
  enabled: boolean
  matcher?: string
  timeoutSeconds?: number
  createdAt?: string
}

export interface MountPointState {
  enabled: boolean
  bellEnabled: boolean
  scripts: HookScriptItem[]
}

export type ThirdPartyProviderId =
  | 'bark'
  | 'dingtalk'
  | 'feishu'
  | 'telegram'
  | 'wecom'
  | 'pushplus'
  | 'wxpusher'
  | 'serverchan'
  | 'ntfy'
  | 'gotify'
  | 'custom'

export type ProviderFieldKind =
  | 'text'
  | 'secret'
  | 'number'
  | 'select'
  | 'csv'
  | 'numberCsv'
  | 'kvLines'
  | 'textarea'

export interface ProviderFieldOption {
  value: string
  labelZh?: string
  labelEn?: string
  label?: string
}

export interface ProviderFieldDef {
  key: string
  labelZh: string
  labelEn: string
  kind: ProviderFieldKind
  required?: boolean
  defaultValue?: string | number
  options?: ProviderFieldOption[]
  placeholder?: string
  placeholderZh?: string
  placeholderEn?: string
}

export interface ProviderDefinition {
  id: ThirdPartyProviderId
  labelZh: string
  labelEn: string
  fields: ProviderFieldDef[]
}

export interface SecretFieldState {
  configured: boolean
  preview?: string
}

export interface ThirdPartyTarget {
  id: string
  name: string
  provider: ThirdPartyProviderId
  enabled: boolean
  events: Record<NotificationCategory, boolean>
  config: Record<string, unknown>
  secretState?: Record<string, SecretFieldState>
}

export interface InAppNotificationSettings {
  enabled: boolean
  autoCloseEnabled: boolean
  autoCloseSeconds: number
}

export interface SystemNotificationSettings {
  enabled: boolean
  suppressWhenFocused: boolean
  taskbarAttentionEnabled: boolean
  taskbarAttentionMode: 'finite' | 'untilFocused'
  taskbarAttentionFlashCount: number
  customSoundFilename: string | null
}

export interface ThirdPartySettings {
  enabled: boolean
  targets: ThirdPartyTarget[]
}

export interface HooksConfig {
  inApp: InAppNotificationSettings
  systemNotifications: SystemNotificationSettings
  thirdParty: ThirdPartySettings
  mountPoints: Record<string, MountPointState>
}

export interface CustomSoundInfo {
  filename: string
  bytes: number
  updatedAt: string
}

export interface ExecutionLogEntry {
  id: string
  timestamp: string
  mountPointId: string
  scriptId?: string
  scriptName: string
  exitCode: number | null
  elapsedMs: number
  suppressed?: boolean
  error?: string
  stdout?: string
  stderr?: string
  dryRun?: boolean
  directive?: Record<string, unknown>
  sessionId?: string | null
  turn?: number | null
  reason?: string | null
  summary?: string | null
}

export interface TestSendResult {
  accepted: boolean
  provider?: string
  targetId?: string
  elapsedMs?: number
  httpStatus?: number
  code?: string | number
  message?: string
  deliveryId?: string
  errorCode?: string
}

export interface HooksPluginState {
  revision: number
  isWindows?: boolean
  platform?: string
  config: HooksConfig
  customSound?: CustomSoundInfo | null
  mountPoints?: HookMountPointDef[]
  categories?: Record<NotificationCategory, CategoryMeta>
  providers?: ProviderDefinition[]
  logs?: ExecutionLogEntry[]
}

export interface ScriptSourceResult {
  scriptId: string
  mountPointId: string
  filename: string
  kind: 'default' | 'custom'
  content: string
}

export interface HookToastNotification {
  id: string
  event: string
  category?: NotificationCategory | string
  eventLabel?: string
  icon?: string
  title: string
  body?: string
  summary?: string
  variant?: HookVariant
  sessionId?: string
  sessionTitle?: string
  project?: string
  hookPoint?: string
  approvalId?: string
  soundUrl?: string | null
  playWebAudio?: boolean
  shouldWebNotify?: boolean
  hostSystemNotified?: boolean
  systemNotified?: boolean
  autoCloseEnabled?: boolean
  autoCloseSeconds?: number
  timestamp?: string
}

export interface RpcFailure {
  code?: string
  message?: string
  details?: Record<string, unknown>
}

export type RpcResponse<T> =
  | { ok: true; value: T }
  | { ok: false; error: RpcFailure }

export const NOTIFICATION_CATEGORIES: NotificationCategory[] = [
  'PermissionRequest',
  'Notification',
  'Stop',
  'StopFailure',
  'SessionStart',
  'UserPromptSubmit',
]

export const FALLBACK_CATEGORY_META: Record<NotificationCategory, CategoryMeta> = {
  PermissionRequest: { icon: '🛡️', labelZh: '待审批', labelEn: 'Pending Approval', variant: 'approval', defaultSelected: true },
  Notification: { icon: '🔔', labelZh: '需要关注', labelEn: 'Needs Attention', variant: 'attention', defaultSelected: true },
  Stop: { icon: '✅', labelZh: '任务完成', labelEn: 'Task Completed', variant: 'success', defaultSelected: true },
  StopFailure: { icon: '❌', labelZh: '任务失败', labelEn: 'Task Failed', variant: 'error', defaultSelected: true },
  SessionStart: { icon: '🚀', labelZh: '会话启动', labelEn: 'Session Started', variant: 'info', defaultSelected: false },
  UserPromptSubmit: { icon: '⌨️', labelZh: '运行中', labelEn: 'Running', variant: 'info', defaultSelected: false },
}

export const FALLBACK_MOUNT_POINTS: HookMountPointDef[] = [
  {
    id: 'approval.request',
    group: 'core',
    nameZh: '待审批权限请求',
    nameEn: 'Approval Request',
    descZh: '工具执行需要用户审批确认时触发。',
    descEn: 'Fires when a tool call awaits user approval.',
    dshEvents: ['approval/request', 'session:approval/asked'],
    category: 'PermissionRequest',
    defaultEnabled: true,
    defaultBell: true,
    defaultScriptIds: ['notify-approval'],
  },
  {
    id: 'user.question',
    group: 'core',
    nameZh: '等待用户回答',
    nameEn: 'User Question',
    descZh: 'Agent 发起提问或请求计划确认时触发。',
    descEn: 'Fires when the agent asks a question or requests plan review.',
    dshEvents: ['user-questions/request'],
    category: 'Notification',
    defaultEnabled: true,
    defaultBell: true,
    defaultScriptIds: ['notify-attention'],
  },
  {
    id: 'turn.completed',
    group: 'core',
    nameZh: '回合完成',
    nameEn: 'Turn Completed',
    descZh: '主会话 Agent 回合真正完成并进入等待用户状态时触发（自动排除子 Agent、Goal 中间轮次与队列续跑）。',
    descEn: 'Fires when a main-session agent turn finishes and enters idle (excludes subagents, intermediate Goal rounds, and queued continuations).',
    dshEvents: ['session:turn/end[completed]'],
    category: 'Stop',
    defaultEnabled: true,
    defaultBell: true,
    defaultScriptIds: ['notify-task-done'],
  },
  {
    id: 'turn.failed',
    group: 'core',
    nameZh: '执行失败',
    nameEn: 'Turn Failed',
    descZh: '回合或代理循环发生错误时触发。',
    descEn: 'Fires when a turn or agent loop fails.',
    dshEvents: ['session:turn/end[error]', 'agent/error', 'agent-loop/config-start-failed'],
    category: 'StopFailure',
    defaultEnabled: true,
    defaultBell: true,
    defaultScriptIds: ['notify-task-failed'],
  },
  {
    id: 'turn.attention',
    group: 'core',
    nameZh: '回合中断 / 阻塞',
    nameEn: 'Turn Needs Attention',
    descZh: '回合被阻塞、达到上限、中止或中断时触发。',
    descEn: 'Fires when a turn stops due to block, max tokens, abort, or interrupt.',
    dshEvents: ['session:turn/end[blocked|max-tokens|aborted|interrupted]'],
    category: 'Notification',
    defaultEnabled: true,
    defaultBell: true,
    defaultScriptIds: ['notify-attention'],
  },
  {
    id: 'session.start',
    group: 'session_tools',
    nameZh: '会话启动',
    nameEn: 'Session Start',
    descZh: '新会话或 Agent 实例创建时触发。',
    descEn: 'Fires when a session or agent is created.',
    dshEvents: ['agent/created', 'session/created'],
    category: 'SessionStart',
    defaultEnabled: false,
    defaultBell: false,
    defaultScriptIds: ['notify-session-start'],
  },
  {
    id: 'turn.start',
    group: 'session_tools',
    nameZh: '新回合开始',
    nameEn: 'Turn Start',
    descZh: '提交用户输入并开始新一轮执行时触发。',
    descEn: 'Fires when a new turn starts.',
    dshEvents: ['session:turn/start'],
    category: 'UserPromptSubmit',
    defaultEnabled: false,
    defaultBell: false,
    defaultScriptIds: [],
  },
  {
    id: 'session.end',
    group: 'session_tools',
    nameZh: '会话结束',
    nameEn: 'Session End',
    descZh: '会话或 Agent 释放销毁时触发。',
    descEn: 'Fires when a session or agent is disposed.',
    dshEvents: ['session/disposed', 'agent/disposed'],
    category: 'SessionStart',
    defaultEnabled: false,
    defaultBell: false,
    defaultScriptIds: [],
  },
  {
    id: 'tool.pre',
    group: 'session_tools',
    nameZh: '工具调用前',
    nameEn: 'Pre Tool Execute',
    descZh: '工具执行前观察（可按工具名称正则匹配）。',
    descEn: 'Observes tool invocations before execution (supports matcher).',
    dshEvents: ['tools/pre-execute'],
    category: 'UserPromptSubmit',
    defaultEnabled: false,
    defaultBell: false,
    supportsMatcher: true,
    defaultScriptIds: [],
  },
  {
    id: 'tool.post',
    group: 'session_tools',
    nameZh: '工具调用成功',
    nameEn: 'Post Tool Execute',
    descZh: '工具调用成功返回结果后触发（支持审计示例脚本）。',
    descEn: 'Fires after a tool succeeds (supports matcher and audit log script).',
    dshEvents: ['tools/result[ok]'],
    category: 'UserPromptSubmit',
    defaultEnabled: false,
    defaultBell: false,
    supportsMatcher: true,
    defaultScriptIds: ['audit-log-example'],
  },
  {
    id: 'tool.failure',
    group: 'session_tools',
    nameZh: '工具调用失败',
    nameEn: 'Tool Failure',
    descZh: '工具调用返回错误时触发（可按工具名称匹配）。',
    descEn: 'Fires when a tool execution returns an error (supports matcher).',
    dshEvents: ['tools/result[error]'],
    category: 'StopFailure',
    defaultEnabled: false,
    defaultBell: false,
    supportsMatcher: true,
    defaultScriptIds: [],
  },
  {
    id: 'subagent.start',
    group: 'subsystems',
    nameZh: '子 Agent 启动',
    nameEn: 'Subagent Start',
    descZh: '子 Agent 开始运行时触发。',
    descEn: 'Fires when a subagent starts.',
    dshEvents: ['subagent/start'],
    category: 'UserPromptSubmit',
    defaultEnabled: false,
    defaultBell: false,
    defaultScriptIds: [],
  },
  {
    id: 'subagent.end',
    group: 'subsystems',
    nameZh: '子 Agent 完成',
    nameEn: 'Subagent End',
    descZh: '子 Agent 运行结束时触发。',
    descEn: 'Fires when a subagent finishes.',
    dshEvents: ['subagent/end'],
    category: 'Stop',
    defaultEnabled: false,
    defaultBell: false,
    defaultScriptIds: ['notify-subagent-end'],
  },
  {
    id: 'job.settled',
    group: 'subsystems',
    nameZh: '后台任务结束',
    nameEn: 'Background Job Settled',
    descZh: '仅在真正异步的后台任务（不含普通前台命令）完成、被终止或失败时触发。',
    descEn: 'Fires only when an unawaited background job completes, is killed, or fails (excludes foreground shell commands).',
    dshEvents: ['jobs:settled[background]'],
    category: 'Stop',
    defaultEnabled: false,
    defaultBell: false,
    defaultScriptIds: ['notify-job-settled'],
  },
  {
    id: 'workflow.start',
    group: 'subsystems',
    nameZh: '工作流开始',
    nameEn: 'Workflow Start',
    descZh: 'Python 编排工作流开始执行时触发。',
    descEn: 'Fires when a workflow starts.',
    dshEvents: ['workflow/start'],
    category: 'UserPromptSubmit',
    defaultEnabled: false,
    defaultBell: false,
    defaultScriptIds: [],
  },
  {
    id: 'workflow.end',
    group: 'subsystems',
    nameZh: '工作流结束',
    nameEn: 'Workflow End',
    descZh: '工作流完成时触发。',
    descEn: 'Fires when a workflow ends.',
    dshEvents: ['workflow/end'],
    category: 'Stop',
    defaultEnabled: false,
    defaultBell: false,
    defaultScriptIds: [],
  },
  {
    id: 'compaction.end',
    group: 'subsystems',
    nameZh: '上下文压缩完成',
    nameEn: 'Compaction End',
    descZh: '会话上下文压缩整理完成时触发。',
    descEn: 'Fires when context compaction finishes.',
    dshEvents: ['session:compaction/end'],
    category: 'Notification',
    defaultEnabled: false,
    defaultBell: false,
    defaultScriptIds: [],
  },
  {
    id: 'goal.changed',
    group: 'subsystems',
    nameZh: '目标状态变更',
    nameEn: 'Goal Changed',
    descZh: '长期目标或激活状态发生变化时触发。',
    descEn: 'Fires when a goal or its activation status changes.',
    dshEvents: ['goal/changed', 'goal/activation-changed'],
    category: 'Notification',
    defaultEnabled: false,
    defaultBell: false,
    defaultScriptIds: [],
  },
  {
    id: 'account.attention',
    group: 'subsystems',
    nameZh: '账号与登录提醒',
    nameEn: 'Account Attention',
    descZh: '账号会话过期或模型需要重新登录时触发。',
    descEn: 'Fires when account session expires or model sign-in is required.',
    dshEvents: ['deepseek-account/session-expired', 'model-sign-in-required'],
    category: 'Notification',
    defaultEnabled: true,
    defaultBell: true,
    defaultScriptIds: ['notify-attention'],
  },
]

export const FALLBACK_PROVIDERS: ProviderDefinition[] = [
  {
    id: 'bark',
    labelZh: 'Bark',
    labelEn: 'Bark',
    fields: [
      { key: 'serverUrl', labelZh: '服务器地址', labelEn: 'Server URL', kind: 'text', defaultValue: 'https://api.day.app', placeholder: 'https://api.day.app' },
      { key: 'deviceKey', labelZh: 'Device Key', labelEn: 'Device Key', kind: 'secret', required: true },
      { key: 'group', labelZh: '分组 (可选)', labelEn: 'Group (optional)', kind: 'text' },
      { key: 'sound', labelZh: '提示音 (可选)', labelEn: 'Sound (optional)', kind: 'text' },
      {
        key: 'level',
        labelZh: '中断级别',
        labelEn: 'Level',
        kind: 'select',
        options: [
          { value: '', labelZh: '默认', labelEn: 'Default' },
          { value: 'active', labelZh: 'active' },
          { value: 'timeSensitive', labelZh: 'timeSensitive' },
          { value: 'passive', labelZh: 'passive' },
          { value: 'critical', labelZh: 'critical' },
        ],
      },
      { key: 'basicUsername', labelZh: 'Basic 用户名 (可选)', labelEn: 'Basic Username', kind: 'text' },
      { key: 'basicPassword', labelZh: 'Basic 密码 (可选)', labelEn: 'Basic Password', kind: 'secret' },
    ],
  },
  {
    id: 'dingtalk',
    labelZh: '钉钉机器人',
    labelEn: 'DingTalk',
    fields: [
      { key: 'webhookUrl', labelZh: 'Webhook URL', labelEn: 'Webhook URL', kind: 'secret', required: true },
      { key: 'secret', labelZh: '加签密钥 (可选)', labelEn: 'Signing Secret (optional)', kind: 'secret' },
    ],
  },
  {
    id: 'feishu',
    labelZh: '飞书机器人',
    labelEn: 'Feishu / Lark',
    fields: [
      { key: 'webhookUrl', labelZh: 'Webhook URL', labelEn: 'Webhook URL', kind: 'secret', required: true },
      { key: 'secret', labelZh: '签名密钥 (可选)', labelEn: 'Signing Secret (optional)', kind: 'secret' },
    ],
  },
  {
    id: 'telegram',
    labelZh: 'Telegram',
    labelEn: 'Telegram',
    fields: [
      { key: 'botToken', labelZh: 'Bot Token', labelEn: 'Bot Token', kind: 'secret', required: true },
      { key: 'chatId', labelZh: 'Chat ID', labelEn: 'Chat ID', kind: 'text', required: true },
      { key: 'messageThreadId', labelZh: 'Thread ID (可选)', labelEn: 'Thread ID (optional)', kind: 'number' },
    ],
  },
  {
    id: 'wecom',
    labelZh: '企业微信',
    labelEn: 'WeCom',
    fields: [
      { key: 'webhookUrl', labelZh: 'Webhook URL', labelEn: 'Webhook URL', kind: 'secret', required: true },
    ],
  },
  {
    id: 'pushplus',
    labelZh: 'PushPlus',
    labelEn: 'PushPlus',
    fields: [
      { key: 'token', labelZh: 'Token', labelEn: 'Token', kind: 'secret', required: true },
      { key: 'template', labelZh: '模板', labelEn: 'Template', kind: 'text', defaultValue: 'txt' },
      { key: 'channel', labelZh: '发送渠道 (可选)', labelEn: 'Channel (optional)', kind: 'text' },
      { key: 'topic', labelZh: '群组编码 (可选)', labelEn: 'Topic (optional)', kind: 'text' },
      { key: 'webhook', labelZh: 'Webhook 编码 (可选)', labelEn: 'Webhook (optional)', kind: 'text' },
    ],
  },
  {
    id: 'wxpusher',
    labelZh: 'WxPusher',
    labelEn: 'WxPusher',
    fields: [
      { key: 'spt', labelZh: 'SPT (推荐)', labelEn: 'SPT (recommended)', kind: 'secret' },
      { key: 'appToken', labelZh: 'App Token (无 SPT 时必填)', labelEn: 'App Token (if no SPT)', kind: 'secret' },
      { key: 'uids', labelZh: 'UID 列表 (逗号分隔)', labelEn: 'UIDs (CSV)', kind: 'csv' },
      { key: 'topicIds', labelZh: 'Topic ID 列表 (逗号分隔)', labelEn: 'Topic IDs (CSV)', kind: 'numberCsv' },
    ],
  },
  {
    id: 'serverchan',
    labelZh: 'Server 酱',
    labelEn: 'ServerChan',
    fields: [
      { key: 'sendKey', labelZh: 'SendKey', labelEn: 'SendKey', kind: 'secret', required: true },
    ],
  },
  {
    id: 'ntfy',
    labelZh: 'ntfy',
    labelEn: 'ntfy',
    fields: [
      { key: 'serverUrl', labelZh: '服务器地址', labelEn: 'Server URL', kind: 'text', defaultValue: 'https://ntfy.sh' },
      { key: 'topic', labelZh: 'Topic', labelEn: 'Topic', kind: 'secret', required: true },
      {
        key: 'authType',
        labelZh: '认证方式',
        labelEn: 'Auth Type',
        kind: 'select',
        defaultValue: 'none',
        options: [
          { value: 'none', labelZh: '无认证', labelEn: 'None' },
          { value: 'bearer', labelZh: 'Bearer Token', labelEn: 'Bearer Token' },
          { value: 'basic', labelZh: 'Basic Auth', labelEn: 'Basic Auth' },
        ],
      },
      { key: 'authToken', labelZh: 'Bearer Token', labelEn: 'Bearer Token', kind: 'secret' },
      { key: 'basicUsername', labelZh: 'Basic 用户名', labelEn: 'Basic Username', kind: 'text' },
      { key: 'basicPassword', labelZh: 'Basic 密码', labelEn: 'Basic Password', kind: 'secret' },
      { key: 'priority', labelZh: '优先级 (1-5)', labelEn: 'Priority (1-5)', kind: 'text' },
      { key: 'tags', labelZh: '标签 (逗号分隔)', labelEn: 'Tags (CSV)', kind: 'text' },
    ],
  },
  {
    id: 'gotify',
    labelZh: 'Gotify',
    labelEn: 'Gotify',
    fields: [
      { key: 'serverUrl', labelZh: '服务器地址', labelEn: 'Server URL', kind: 'text', required: true, placeholder: 'https://gotify.example.com' },
      { key: 'appToken', labelZh: 'App Token', labelEn: 'App Token', kind: 'secret', required: true },
      { key: 'priority', labelZh: '优先级', labelEn: 'Priority', kind: 'number', defaultValue: 5 },
    ],
  },
  {
    id: 'custom',
    labelZh: '自定义 HTTP',
    labelEn: 'Custom HTTP',
    fields: [
      {
        key: 'method',
        labelZh: '请求方法',
        labelEn: 'Method',
        kind: 'select',
        defaultValue: 'POST',
        options: [
          { value: 'POST', labelZh: 'POST', labelEn: 'POST' },
          { value: 'GET', labelZh: 'GET', labelEn: 'GET' },
        ],
      },
      { key: 'url', labelZh: '请求 URL', labelEn: 'URL', kind: 'secret', required: true },
      {
        key: 'bodyType',
        labelZh: '请求体格式',
        labelEn: 'Body Type',
        kind: 'select',
        defaultValue: 'json',
        options: [
          { value: 'json', labelZh: 'JSON', labelEn: 'JSON' },
          { value: 'form', labelZh: 'Form (urlencoded)', labelEn: 'Form' },
          { value: 'text', labelZh: '纯文本', labelEn: 'Plain Text' },
        ],
      },
      { key: 'query', labelZh: 'Query 参数 (每行 key=value)', labelEn: 'Query Params (key=value lines)', kind: 'kvLines' },
      { key: 'headers', labelZh: '请求头 (每行 key=value)', labelEn: 'Headers (key=value lines)', kind: 'kvLines' },
      { key: 'jsonBody', labelZh: 'JSON 模板', labelEn: 'JSON Body Template', kind: 'textarea', defaultValue: '{"title":"{{title}}","body":"{{body}}"}' },
      { key: 'formBody', labelZh: 'Form 字段 (每行 key=value)', labelEn: 'Form Body (key=value lines)', kind: 'kvLines' },
      { key: 'textBody', labelZh: '纯文本模板', labelEn: 'Text Body Template', kind: 'textarea' },
    ],
  },
]
