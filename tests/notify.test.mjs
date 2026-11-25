import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  createNotificationDispatcher,
  formatRedactedMessage,
  MAX_CONCURRENCY,
  QUEUE_CAPACITY,
} from '../src/notification-dispatcher.js'
import {
  clearCustomSound,
  getCustomSoundInfo,
  getCustomSoundPath,
  MAX_WAV_BYTES,
  playNativeSound,
  saveCustomSound,
  validateWavBuffer,
} from '../src/sound-manager.js'
import {
  buildWindowsToastCommandPayload,
  clearTaskbarAttention,
  escapeXml,
  flashTaskbar,
  isWsl,
  sendSystemNotification,
} from '../src/system-notifier.js'
import {
  PROVIDER_IDS,
  sendToProvider,
  validateProviderConfig,
} from '../src/third-party-providers.js'

function createValidWavBuffer(payloadBytes = 8) {
  const buf = Buffer.alloc(44 + payloadBytes)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + payloadBytes, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(8000, 24)
  buf.writeUInt32LE(8000, 28)
  buf.writeUInt16LE(1, 32)
  buf.writeUInt16LE(8, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(payloadBytes, 40)
  return buf
}

function makeFakeResponse(status, bodyObjOrText, { headers = {}, redirected = false } = {}) {
  const text = typeof bodyObjOrText === 'string' ? bodyObjOrText : JSON.stringify(bodyObjOrText)
  const bytes = Buffer.from(text, 'utf8')
  return {
    status,
    redirected,
    headers: new Headers(headers),
    body: new ReadableStream({
      start(controller) {
        if (bytes.byteLength > 0) controller.enqueue(bytes)
        controller.close()
      },
    }),
  }
}

function createFakeSpawn(onSpawn) {
  const calls = []
  const spawnImpl = (cmd, args, options) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {
      child.killed = true
    }
    const record = { cmd, args, options, child }
    calls.push(record)
    queueMicrotask(() => onSpawn(record))
    return child
  }
  return { spawnImpl, calls }
}

test('third-party-providers: all 11 providers URL, headers, payload, and known HMAC test vectors', async (t) => {
  // Deterministic timestamp: 1700000000123 ms -> 1700000000 s
  t.mock.method(Date, 'now', () => 1700000000123)

  const sampleMsg = {
    id: 'evt-100',
    event: 'Stop',
    source: 'DSH',
    project: 'my-repo',
    time: '2026-11-24 10:00:00',
    title: 'DSH ✅ 任务完成',
    body: '📌 内容：完成构建',
  }

  // Known HMAC-SHA256 test vectors (timestamp=1700000000123ms / 1700000000s):
  const dingSecret = 'SEC_ding_vector_key'
  const expectedDingSign = 'X+onMODJXX43oIkoXo+lLYVvSemrwspw2pI+M22ERXw='
  assert.equal(
    expectedDingSign,
    createHmac('sha256', dingSecret).update('1700000000123\nSEC_ding_vector_key', 'utf8').digest('base64'),
  )
  const feishuSecret = 'feishu_vector_secret'
  const expectedFeishuSign = 'a1iA7JMTmvlaOqN8SSdXQcwrjydpRqtgVh4WgPHgNJA='
  assert.equal(
    expectedFeishuSign,
    createHmac('sha256', Buffer.from('1700000000\nfeishu_vector_secret', 'utf8'))
      .update(Buffer.alloc(0))
      .digest('base64'),
  )

  assert.equal(PROVIDER_IDS.length, 11)

  // 1. Bark (with Basic Auth & optional fields; invalid chars rejected)
  {
    assert.equal(validateProviderConfig('bark', { deviceKey: 'dev key/1' }).valid, false)
    const seen = []
    const res = await sendToProvider(
      'bark',
      {
        serverUrl: 'https://bark.example.com/',
        deviceKey: 'dev+key=1',
        group: 'DSH',
        sound: 'bell',
        level: 'timeSensitive',
        basicUsername: 'alice',
        basicPassword: 'pw',
      },
      sampleMsg,
      {
        fetchImpl: async (url, init) => {
          seen.push({ url, init })
          return makeFakeResponse(200, { code: 200, message: 'success' })
        },
      },
    )
    assert.equal(res.accepted, true)
    assert.equal(seen[0].url, 'https://bark.example.com/dev%2Bkey%3D1')
    assert.equal(seen[0].init.headers.Authorization, `Basic ${Buffer.from('alice:pw').toString('base64')}`)
    assert.deepEqual(JSON.parse(seen[0].init.body), {
      title: sampleMsg.title,
      body: sampleMsg.body,
      group: 'DSH',
      sound: 'bell',
      level: 'timeSensitive',
    })
  }

  // 2. DingTalk (signed)
  {
    const seen = []
    const res = await sendToProvider(
      'dingtalk',
      { webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=abc', secret: dingSecret },
      sampleMsg,
      {
        fetchImpl: async (url, init) => {
          seen.push({ url: new URL(url), init })
          return makeFakeResponse(200, { errcode: 0, errmsg: 'ok' })
        },
      },
    )
    assert.equal(res.accepted, true)
    assert.equal(seen[0].url.searchParams.get('access_token'), 'abc')
    assert.equal(seen[0].url.searchParams.get('timestamp'), '1700000000123')
    assert.equal(seen[0].url.searchParams.get('sign'), expectedDingSign)
    assert.deepEqual(JSON.parse(seen[0].init.body), { msgtype: 'text', text: { content: sampleMsg.body } })
  }

  // 3. Feishu (signed)
  {
    const seen = []
    const res = await sendToProvider(
      'feishu',
      { webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/xyz', secret: feishuSecret },
      sampleMsg,
      {
        fetchImpl: async (url, init) => {
          seen.push({ url, init })
          return makeFakeResponse(200, { code: 0, msg: 'success' })
        },
      },
    )
    assert.equal(res.accepted, true)
    assert.equal(seen[0].url, 'https://open.feishu.cn/open-apis/bot/v2/hook/xyz')
    assert.deepEqual(JSON.parse(seen[0].init.body), {
      msg_type: 'text',
      content: { text: sampleMsg.body },
      timestamp: '1700000000',
      sign: expectedFeishuSign,
    })
  }

  // 4. Telegram
  {
    const seen = []
    const res = await sendToProvider(
      'telegram',
      { botToken: '123456:ABC-DEF', chatId: '-100999', messageThreadId: '42' },
      sampleMsg,
      {
        fetchImpl: async (url, init) => {
          seen.push({ url, init })
          return makeFakeResponse(200, { ok: true, result: { message_id: 777 } })
        },
      },
    )
    assert.equal(res.accepted, true)
    assert.equal(res.deliveryId, '777')
    assert.equal(seen[0].url, 'https://api.telegram.org/bot123456:ABC-DEF/sendMessage')
    assert.deepEqual(JSON.parse(seen[0].init.body), {
      chat_id: '-100999',
      text: sampleMsg.body,
      disable_web_page_preview: true,
      message_thread_id: 42,
    })
  }

  // 5. WeCom
  {
    const seen = []
    const res = await sendToProvider(
      'wecom',
      { webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k1' },
      sampleMsg,
      {
        fetchImpl: async (url, init) => {
          seen.push({ url, init })
          return makeFakeResponse(200, { errcode: 0, errmsg: 'ok' })
        },
      },
    )
    assert.equal(res.accepted, true)
    assert.equal(seen[0].url, 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k1')
    assert.deepEqual(JSON.parse(seen[0].init.body), { msgtype: 'text', text: { content: sampleMsg.body } })
  }

  // 6. PushPlus
  {
    const seen = []
    const res = await sendToProvider(
      'pushplus',
      { token: 'pp_tok', template: 'markdown', channel: 'wechat', topic: 'g1', webhook: 'w1' },
      sampleMsg,
      {
        fetchImpl: async (url, init) => {
          seen.push({ url, init })
          return makeFakeResponse(200, { code: 200, data: 'pp-888' })
        },
      },
    )
    assert.equal(res.accepted, true)
    assert.equal(res.deliveryId, 'pp-888')
    assert.equal(seen[0].url, 'https://www.pushplus.plus/send')
    assert.deepEqual(JSON.parse(seen[0].init.body), {
      token: 'pp_tok',
      title: sampleMsg.title,
      content: sampleMsg.body,
      template: 'markdown',
      channel: 'wechat',
      topic: 'g1',
      webhook: 'w1',
    })
  }

  // 7. WxPusher (SPT mode and appToken+uids+topicIds mode)
  {
    const seen = []
    const resSpt = await sendToProvider('wxpusher', { spt: 'SPT_abc' }, sampleMsg, {
      fetchImpl: async (url, init) => {
        seen.push({ url, body: JSON.parse(init.body) })
        return makeFakeResponse(200, { code: 1000, msg: 'ok' })
      },
    })
    assert.equal(resSpt.accepted, true)
    assert.equal(seen[0].url, 'https://wxpusher.zjiecode.com/api/send/message')
    assert.deepEqual(seen[0].body, {
      content: sampleMsg.body,
      summary: sampleMsg.title,
      contentType: 1,
      spt: 'SPT_abc',
    })

    const resApp = await sendToProvider(
      'wxpusher',
      { appToken: 'AT_1', uids: 'UID_1, UID_2', topicIds: '101, 202' },
      sampleMsg,
      {
        fetchImpl: async (url, init) => {
          seen.push({ url, body: JSON.parse(init.body) })
          return makeFakeResponse(200, { code: 1000 })
        },
      },
    )
    assert.equal(resApp.accepted, true)
    assert.deepEqual(seen[1].body, {
      content: sampleMsg.body,
      summary: sampleMsg.title,
      contentType: 1,
      appToken: 'AT_1',
      uids: ['UID_1', 'UID_2'],
      topicIds: [101, 202],
    })
  }

  // 8. ServerChan (sctp vs sctapi routing)
  {
    const seen = []
    const r1 = await sendToProvider('serverchan', { sendKey: 'sctp12345abc' }, sampleMsg, {
      fetchImpl: async (url, init) => {
        seen.push({ url, init })
        return makeFakeResponse(200, { code: 0, data: { pushid: 'p1' } })
      },
    })
    assert.equal(r1.accepted, true)
    assert.equal(seen[0].url, 'https://sctp12345abc.push.ft07.com/send')
    assert.equal(seen[0].init.headers['Content-Type'], 'application/x-www-form-urlencoded; charset=utf-8')
    const params = new URLSearchParams(seen[0].init.body)
    assert.equal(params.get('title'), sampleMsg.title)
    assert.equal(params.get('desp'), sampleMsg.body)

    const r2 = await sendToProvider('serverchan', { sendKey: 'SCT987654' }, sampleMsg, {
      fetchImpl: async (url) => {
        seen.push({ url })
        return makeFakeResponse(200, { code: 0, data: { pushid: 'p2' } })
      },
    })
    assert.equal(r2.accepted, true)
    assert.equal(seen[1].url, 'https://sctapi.ftqq.com/SCT987654.send')
  }

  // 9. ntfy (RFC2047 UTF-8 Title + Bearer auth)
  {
    const seen = []
    const res = await sendToProvider(
      'ntfy',
      {
        serverUrl: 'https://ntfy.example.org/',
        topic: 'dsh-alerts',
        authType: 'bearer',
        authToken: 'tk_ntfy',
        priority: '4',
        tags: 'bell,rocket',
      },
      sampleMsg,
      {
        fetchImpl: async (url, init) => {
          seen.push({ url, init })
          return makeFakeResponse(200, { id: 'ntfy-msg-1' })
        },
      },
    )
    assert.equal(res.accepted, true)
    assert.equal(res.deliveryId, 'ntfy-msg-1')
    assert.equal(seen[0].url, 'https://ntfy.example.org/dsh-alerts')
    assert.equal(seen[0].init.headers.Authorization, 'Bearer tk_ntfy')
    assert.equal(
      seen[0].init.headers.Title,
      `=?UTF-8?B?${Buffer.from(sampleMsg.title, 'utf8').toString('base64')}?=`,
    )
    assert.equal(seen[0].init.headers.Priority, '4')
    assert.equal(seen[0].init.headers.Tags, 'bell,rocket')
    assert.equal(seen[0].init.body, sampleMsg.body)
  }

  // 10. Gotify
  {
    const seen = []
    const res = await sendToProvider(
      'gotify',
      { serverUrl: 'https://gotify.example.org/', appToken: 'A_gotify', priority: 8 },
      sampleMsg,
      {
        fetchImpl: async (url, init) => {
          seen.push({ url, init })
          return makeFakeResponse(200, { id: 321 })
        },
      },
    )
    assert.equal(res.accepted, true)
    assert.equal(res.deliveryId, '321')
    assert.equal(seen[0].url, 'https://gotify.example.org/message?token=A_gotify')
    assert.deepEqual(JSON.parse(seen[0].init.body), {
      title: sampleMsg.title,
      message: sampleMsg.body,
      priority: 8,
    })
  }

  // 11. Custom HTTP recursive JSON substitution, forbidden headers, and embedded credentials rejection
  {
    const seen = []
    const res = await sendToProvider(
      'custom',
      {
        method: 'POST',
        url: 'https://hooks.example.org/notify/{{project}}',
        bodyType: 'json',
        query: 'ev={{event}}',
        headers: 'X-Project={{project}}',
        jsonBody: JSON.stringify({
          meta: { project: '{{project}}', source: '{{source}}' },
          lines: ['{{title}}', '{{body}}', 42],
        }),
      },
      sampleMsg,
      {
        fetchImpl: async (url, init) => {
          seen.push({ url, init })
          return makeFakeResponse(200, { id: 'c-1' })
        },
      },
    )
    assert.equal(res.accepted, true)
    assert.equal(seen[0].url, 'https://hooks.example.org/notify/my-repo?ev=Stop')
    assert.equal(seen[0].init.headers['X-Project'], 'my-repo')
    assert.equal(seen[0].init.headers['Content-Type'], 'application/json; charset=utf-8')
    assert.deepEqual(JSON.parse(seen[0].init.body), {
      meta: { project: 'my-repo', source: 'DSH' },
      lines: [sampleMsg.title, sampleMsg.body, 42],
    })
  }

  for (const forbidden of ['Host', 'host', 'Content-Length', 'Transfer-Encoding', 'Connection']) {
    const check = validateProviderConfig('custom', {
      method: 'POST',
      url: 'https://hooks.example.org/notify',
      headers: `${forbidden}=evil.example`,
    })
    assert.equal(check.valid, false, `Expected forbidden header ${forbidden} to fail`)
  }

  for (const [provider, cfg] of [
    ['custom', { url: 'https://user:pass@hooks.example.org/notify' }],
    ['dingtalk', { webhookUrl: 'https://user:pass@oapi.dingtalk.com/robot/send?access_token=a' }],
    ['feishu', { webhookUrl: 'https://user:pass@open.feishu.cn/open-apis/bot/v2/hook/a' }],
    ['wecom', { webhookUrl: 'https://user:pass@qyapi.weixin.qq.com/cgi-bin/webhook/send?key=a' }],
    ['bark', { serverUrl: 'https://user:pass@api.day.app', deviceKey: 'dk' }],
    ['ntfy', { serverUrl: 'https://user:pass@ntfy.sh', topic: 't1' }],
    ['gotify', { serverUrl: 'https://user:pass@gotify.example.com', appToken: 'tok' }],
  ]) {
    const check = validateProviderConfig(provider, cfg)
    assert.equal(check.valid, false, `Expected embedded credentials in ${provider} URL to be rejected`)
    assert.match(check.error, /username or password/i)
  }
})

test('formatRedactedMessage: redacts prompts, terminal output, and absolute paths', () => {
  const formatted = formatRedactedMessage({
    id: 'msg-redact-1',
    hookPoint: 'tool.failure',
    category: 'StopFailure',
    cwd: 'C:\\Users\\1\\secret\\alpha-app',
    prompt: 'DO_NOT_LEAK_USER_PROMPT',
    terminalOutput: 'DO_NOT_LEAK_TERMINAL_OUTPUT',
    stdout: 'DO_NOT_LEAK_STDOUT',
    stderr: 'DO_NOT_LEAK_STDERR',
    summary:
      'Error in C:\\Users\\1\\secret\\file.ts and /home/user/repo/index.js plus \\\\corp-nas\\share\\keys.txt\r\n\t\x00',
    timestamp: '2026-11-24T10:15:30Z',
  })

  assert.equal(formatted.project, 'alpha-app')
  assert.equal(formatted.title, 'DSH ❌ 任务失败')

  const combined = `${formatted.title}\n${formatted.body}\n${formatted.summary}`
  assert.equal(combined.includes('DO_NOT_LEAK_USER_PROMPT'), false)
  assert.equal(combined.includes('DO_NOT_LEAK_TERMINAL_OUTPUT'), false)
  assert.equal(combined.includes('DO_NOT_LEAK_STDOUT'), false)
  assert.equal(combined.includes('DO_NOT_LEAK_STDERR'), false)
  assert.equal(combined.includes('C:\\Users\\1\\secret'), false)
  assert.equal(combined.includes('/home/user/repo'), false)
  assert.equal(combined.includes('\\\\corp-nas\\share'), false)
  assert.equal(combined.includes('[path]'), true)
  assert.equal(/[\x00-\x08\x0b-\x1f\x7f]/.test(formatted.summary), false)
})

test('notification-dispatcher: enforces MAX_CONCURRENCY=4 and QUEUE_CAPACITY=64', async () => {
  assert.equal(MAX_CONCURRENCY, 4)
  assert.equal(QUEUE_CAPACITY, 64)

  let inFlight = 0
  let maxObserved = 0
  const waiters = []
  let completed = 0

  const fetchImpl = () => {
    inFlight++
    if (inFlight > maxObserved) maxObserved = inFlight
    return new Promise((resolve) => {
      waiters.push(() => {
        inFlight--
        completed++
        resolve(makeFakeResponse(200, { errcode: 0 }))
      })
    })
  }

  const targets = Array.from({ length: 20 }, (_, i) => ({
    id: `t-${i}`,
    name: `WeCom-${i}`,
    provider: 'wecom',
    enabled: true,
    events: { Stop: true },
    config: {},
  }))

  const dispatcher = createNotificationDispatcher({
    getConfig: () => ({
      inApp: { enabled: false },
      systemNotifications: { enabled: false, taskbarAttentionEnabled: false },
      thirdParty: { enabled: true, targets },
      mountPoints: { 'turn.completed': { enabled: true, bellEnabled: false } },
    }),
    getResolvedSecrets: (id) => ({ webhookUrl: `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${id}` }),
    fetchImpl,
  })

  // 4 batches x 20 targets = 80 attempts:
  // Batch 1 queues 20, immediately draining 4 (MAX_CONCURRENCY=4) -> 16 remain in queue
  // Batch 2 queues 20 -> 36 in queue
  // Batch 3 queues 20 -> 56 in queue
  // Batch 4 queues 8 (filling QUEUE_CAPACITY=64) and drops 12 -> total 68 executed
  const results = []
  for (let b = 0; b < 4; b++) {
    results.push(await dispatcher.dispatch({ hookPoint: 'turn.completed', category: 'Stop', summary: `batch ${b}` }))
  }

  assert.deepEqual(
    results.map((r) => r.thirdParty),
    [
      { queued: 20, dropped: 0 },
      { queued: 20, dropped: 0 },
      { queued: 20, dropped: 0 },
      { queued: 8, dropped: 12 },
    ],
  )

  // Allow microtasks to kick off initial workers
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(inFlight, MAX_CONCURRENCY)
  assert.equal(maxObserved, MAX_CONCURRENCY)

  // Drain all 68 accepted requests (4 in-flight + 64 queued)
  while (waiters.length > 0 || inFlight > 0) {
    while (waiters.length > 0) {
      waiters.shift()()
    }
    await new Promise((r) => setTimeout(r, 5))
  }

  assert.equal(completed, QUEUE_CAPACITY + MAX_CONCURRENCY)
  assert.equal(maxObserved, MAX_CONCURRENCY)
  await dispatcher.dispose()
})

test('sound-manager: validateWavBuffer checks RIFF/WAVE, PNG, empty, undersized, >20 MiB, plus storage & playNativeSound', async () => {
  assert.equal(validateWavBuffer(createValidWavBuffer()).valid, true)

  const renamedPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3, 4])
  const pngRes = validateWavBuffer(renamedPng)
  assert.equal(pngRes.valid, false)
  assert.equal(pngRes.errorCode, 'sound/invalid-wav')

  const emptyRes = validateWavBuffer(Buffer.alloc(0))
  assert.equal(emptyRes.valid, false)
  assert.equal(emptyRes.errorCode, 'sound/empty')

  const smallRes = validateWavBuffer(Buffer.from('RIFF1234WAV', 'ascii'))
  assert.equal(smallRes.valid, false)
  assert.equal(smallRes.errorCode, 'sound/invalid-header')

  const overLimit = Buffer.alloc(MAX_WAV_BYTES + 1)
  overLimit.write('RIFF', 0, 'ascii')
  overLimit.write('WAVE', 8, 'ascii')
  const bigRes = validateWavBuffer(overLimit)
  assert.equal(bigRes.valid, false)
  assert.equal(bigRes.errorCode, 'sound/too-large')

  const tempDir = await mkdtemp(path.join(tmpdir(), 'dsh-hooks-sound-'))
  try {
    const saved = await saveCustomSound(tempDir, createValidWavBuffer(32), '../../bad<>name.wav')
    assert.equal(saved.filename, 'bad__name.wav')
    assert.equal(saved.bytes, 76)
    const info = await getCustomSoundInfo(tempDir)
    assert.equal(info?.filename, 'bad__name.wav')
    assert.equal(info?.bytes, 76)

    // Corrupt WAV header on disk -> getCustomSoundInfo returns null
    await writeFile(getCustomSoundPath(tempDir), renamedPng)
    assert.equal(await getCustomSoundInfo(tempDir), null)

    await clearCustomSound(tempDir)
    assert.equal(await getCustomSoundInfo(tempDir), null)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }

  const winSpawn = createFakeSpawn(({ child }) => child.emit('close', 0))
  const winPlay = await playNativeSound('C:\\temp\\ding.wav', { platform: 'win32', spawnImpl: winSpawn.spawnImpl })
  assert.equal(winPlay.played, true)
  assert.equal(winSpawn.calls[0].cmd, 'powershell.exe')
  assert.equal(winSpawn.calls[0].options.env.DSH_SOUND_PATH, 'C:\\temp\\ding.wav')

  const macSpawn = createFakeSpawn(({ child }) => child.emit('close', 0))
  const macPlay = await playNativeSound('/tmp/ding.wav', { platform: 'darwin', spawnImpl: macSpawn.spawnImpl })
  assert.equal(macPlay.played, true)
  assert.equal(macSpawn.calls[0].cmd, 'afplay')
  assert.deepEqual(macSpawn.calls[0].args, ['/tmp/ding.wav'])
})

test('system-notifier: isWsl, XML escaping, silent ToastGeneric, osascript argv, and flashTaskbar', async () => {
  assert.equal(isWsl({ platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu' } }), true)
  assert.equal(isWsl({ platform: 'linux', env: {}, procVersion: 'Linux version 5.15.133.1-microsoft-standard-WSL2' }), true)
  assert.equal(isWsl({ platform: 'linux', env: {}, procVersion: 'Linux version 6.8.0-generic' }), false)
  assert.equal(isWsl({ platform: 'win32', env: { WSL_DISTRO_NAME: 'Ubuntu' } }), false)

  assert.equal(escapeXml('A&B <tag> "q" \'s\'\x00\x07'), 'A&amp;B &lt;tag&gt; &quot;q&quot; &apos;s&apos;')

  const silentToast = buildWindowsToastCommandPayload({
    title: 'Alert <&"\'>\x00',
    body: 'Line1 & "2"',
    silent: true,
  })
  assert.equal(
    silentToast,
    '<toast><visual><binding template="ToastGeneric"><text>Alert &lt;&amp;&quot;&apos;&gt;</text><text>Line1 &amp; &quot;2&quot;</text></binding></visual><audio silent="true"/></toast>',
  )
  const loudToast = buildWindowsToastCommandPayload({ title: 'Hi', body: 'There', silent: false })
  assert.equal(loudToast.includes('<audio silent="true"/>'), false)

  // Windows Toast sends DSH_TOAST_SILENT=1 when silent
  {
    const { spawnImpl, calls } = createFakeSpawn(({ child }) => {
      child.stdout.emit('data', 'WINRT_OK\n')
      child.emit('close', 0)
    })
    const res = await sendSystemNotification({
      title: 'Title <&"\'>\x00',
      body: 'Body text',
      silent: true,
      platform: 'win32',
      spawnImpl,
    })
    assert.deepEqual(res, { ok: true, channel: 'winrt' })
    assert.equal(calls[0].cmd, 'powershell.exe')
    assert.equal(calls[0].options.env.DSH_TOAST_TITLE, 'Title <&"\'>')
    assert.equal(calls[0].options.env.DSH_TOAST_SILENT, '1')
    assert.match(calls[0].args.at(-1), /<audio silent="true"\/>/)
  }

  // macOS osascript uses argv instead of interpolated AppleScript string
  {
    const { spawnImpl, calls } = createFakeSpawn(({ child }) => child.emit('close', 0))
    const trickyTitle = 'Done "quoted" $(uname) `id`'
    const trickyBody = 'Line "1"\nLine \'2\' \\path'
    const res = await sendSystemNotification({
      title: trickyTitle,
      body: trickyBody,
      platform: 'darwin',
      spawnImpl,
    })
    assert.deepEqual(res, { ok: true, channel: 'osascript' })
    assert.equal(calls[0].cmd, 'osascript')
    assert.equal(calls[0].args[0], '-e')
    assert.match(calls[0].args[1], /^on run argv\b/)
    assert.equal(calls[0].args[2], trickyTitle)
    assert.equal(calls[0].args[3], trickyBody)
  }

  // flashTaskbar finite clamping 1..20, untilFocused, and non-Windows no-op
  {
    const { spawnImpl, calls } = createFakeSpawn(({ child }) => {
      child.stdout.emit('data', 'FLASHED\n')
      child.emit('close', 0)
    })
    const finiteHigh = await flashTaskbar({ mode: 'finite', flashCount: 99, platform: 'win32', spawnImpl })
    assert.deepEqual(finiteHigh, { ok: true })
    assert.equal(calls[0].options.env.DSH_FLASH_MODE, 'finite')
    assert.equal(calls[0].options.env.DSH_FLASH_COUNT, '20')

    const finiteLow = await flashTaskbar({ mode: 'finite', flashCount: -3, platform: 'win32', spawnImpl })
    assert.deepEqual(finiteLow, { ok: true })
    assert.equal(calls[1].options.env.DSH_FLASH_COUNT, '1')

    const untilFocused = await flashTaskbar({ mode: 'untilFocused', platform: 'win32', spawnImpl })
    assert.deepEqual(untilFocused, { ok: true })
    assert.equal(calls[2].options.env.DSH_FLASH_MODE, 'untilFocused')

    const stopped = await clearTaskbarAttention({ platform: 'win32', spawnImpl })
    assert.deepEqual(stopped, { ok: true })
    assert.equal(calls[3].options.env.DSH_FLASH_MODE, 'stop')

    const nonWinSpawn = createFakeSpawn(({ child }) => child.emit('close', 0))
    const linuxFlash = await flashTaskbar({ mode: 'finite', flashCount: 5, platform: 'linux', spawnImpl: nonWinSpawn.spawnImpl })
    const macClear = await clearTaskbarAttention({ platform: 'darwin', spawnImpl: nonWinSpawn.spawnImpl })
    assert.deepEqual(linuxFlash, { ok: true, skipped: true })
    assert.deepEqual(macClear, { ok: true, skipped: true })
    assert.equal(nonWinSpawn.calls.length, 0)
  }
})

test('third-party-providers: enforces redirect block, 64 KiB response cap, timeout, and redacted error host', async () => {
  const sampleMsg = { title: 'T', body: 'B', event: 'Stop', project: 'demo' }

  const redir = await sendToProvider(
    'wecom',
    { webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=SECRET_KEY_VALUE' },
    sampleMsg,
    {
      fetchImpl: async () => makeFakeResponse(302, '', { redirected: true }),
    },
  )
  assert.equal(redir.accepted, false)
  assert.equal(redir.errorCode, 'provider/redirect')
  assert.equal(redir.message.includes('SECRET_KEY_VALUE'), false)
  assert.match(redir.message, /qyapi\.weixin\.qq\.com/)

  // 128 KiB streaming error response must cancel/cap at 64 KiB
  let canceled = false
  const bigRes = await sendToProvider(
    'custom',
    { method: 'POST', url: 'https://hooks.example.org/big' },
    sampleMsg,
    {
      fetchImpl: async () => ({
        status: 500,
        redirected: false,
        headers: new Headers(),
        body: new ReadableStream({
          pull(controller) {
            controller.enqueue(Buffer.alloc(32 * 1024, 'x'))
          },
          cancel() {
            canceled = true
          },
        }),
      }),
    },
  )
  assert.equal(bigRes.accepted, false)
  assert.equal(bigRes.errorCode, 'provider/http')
  assert.equal(canceled, true)

  const timedOut = await sendToProvider(
    'wecom',
    { webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=SECRET_TIMEOUT' },
    sampleMsg,
    {
      timeoutMs: 30,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
        }),
    },
  )
  assert.equal(timedOut.accepted, false)
  assert.equal(timedOut.errorCode, 'provider/timeout')
  assert.equal(timedOut.message.includes('SECRET_TIMEOUT'), false)
})

test('notification-dispatcher: 4-channel gating, bellEnabled, focus suppression, and custom sound silent toast', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'dsh-hooks-dispatch-'))
  try {
    await saveCustomSound(dataDir, createValidWavBuffer(16), 'ding.wav')

    const broadcasts = []
    let focused = false
    const eventHub = {
      broadcast: (ev, payload) => broadcasts.push({ ev, payload }),
      getConnectedClientCount: () => 1,
      hasFocusedVisibleClient: () => focused,
    }

    const { spawnImpl, calls } = createFakeSpawn(({ cmd, args, child }) => {
      if (cmd === 'powershell.exe' && args.at(-1).includes('ToastGeneric')) {
        child.stdout.emit('data', 'WINRT_OK\n')
      } else if (cmd === 'powershell.exe' && args.at(-1).includes('FlashWindowEx')) {
        child.stdout.emit('data', 'FLASHED\n')
      }
      child.emit('close', 0)
    })

    let bell = true
    const dispatcher = createNotificationDispatcher({
      getConfig: () => ({
        inApp: { enabled: true, autoCloseEnabled: true, autoCloseSeconds: 30 },
        systemNotifications: {
          enabled: true,
          suppressWhenFocused: true,
          taskbarAttentionEnabled: true,
          taskbarAttentionMode: 'finite',
          taskbarAttentionFlashCount: 3,
        },
        thirdParty: { enabled: false, targets: [] },
        mountPoints: { 'turn.completed': { enabled: true, bellEnabled: bell } },
      }),
      getDataDir: () => dataDir,
      eventHub,
      platform: 'win32',
      spawnImpl,
    })

    // Suppressed by script directive
    const suppressed = await dispatcher.dispatch({ hookPoint: 'turn.completed' }, { suppress: true })
    assert.deepEqual(suppressed, { dispatched: false, suppressed: true })
    assert.equal(broadcasts.length, 0)

    // Unfocused + bell ON -> plays WAV, sends silent toast (DSH_TOAST_SILENT=1), flashes taskbar, sends SSE
    const r1 = await dispatcher.dispatch({ hookPoint: 'turn.completed', summary: 'Build OK' })
    assert.equal(r1.dispatched, true)
    assert.equal(r1.customSoundPlayed, true)
    assert.equal(r1.systemNotification.ok, true)
    assert.equal(r1.taskbar.ok, true)
    assert.equal(broadcasts.length, 1)
    assert.equal(broadcasts[0].payload.playWebAudio, false)
    assert.equal(broadcasts[0].payload.hostSystemNotified, true)
    assert.equal(calls.some((c) => c.options.env.DSH_TOAST_SILENT === '1'), true)
    assert.equal(calls.some((c) => c.options.env.DSH_FLASH_COUNT === '3'), true)

    // Focused -> suppresses OS toast and taskbar flash, keeps in-app SSE
    focused = true
    const prevCalls = calls.length
    const r2 = await dispatcher.dispatch({ hookPoint: 'turn.completed', summary: 'Focused event' })
    assert.equal(r2.dispatched, true)
    assert.equal(r2.customSoundPlayed, false)
    assert.equal(r2.taskbar.skipped, true)
    assert.equal(calls.length, prevCalls)
    assert.equal(broadcasts.length, 2)

    // Unfocused + bell OFF -> suppresses OS toast and taskbar flash, keeps in-app SSE
    focused = false
    bell = false
    const r3 = await dispatcher.dispatch({ hookPoint: 'turn.completed', summary: 'Muted bell' })
    assert.equal(r3.dispatched, true)
    assert.equal(r3.customSoundPlayed, false)
    assert.equal(r3.taskbar.skipped, true)
    assert.equal(calls.length, prevCalls)
    assert.equal(broadcasts.length, 3)

    await dispatcher.dispose()
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

