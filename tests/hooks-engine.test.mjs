import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as hooksPlugin from '../index.js'
import { createConfigStore, SECRET_CREDENTIAL_KEY } from '../src/config-store.js'
import { DEFAULT_SCRIPTS, getDefaultScriptsDir } from '../src/default-scripts.js'
import { HOOK_MOUNT_POINTS } from '../src/hook-catalog.js'
import {
  createScriptRunner,
  getCustomScriptsDir,
  getExecutionLogPath,
  readScriptSource,
  resolveScriptFilePath,
  saveUploadedScript,
} from '../src/script-runner.js'

const ALL_EXPECTED_MOUNT_IDS = [
  'approval.request',
  'user.question',
  'turn.completed',
  'turn.failed',
  'turn.attention',
  'session.start',
  'turn.start',
  'session.end',
  'tool.pre',
  'tool.post',
  'tool.failure',
  'subagent.start',
  'subagent.end',
  'job.settled',
  'workflow.start',
  'workflow.end',
  'compaction.end',
  'goal.changed',
  'account.attention',
]

async function mountTestRuntime(t, opts = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-hooks-engine-'))
  const ctx = new Context()
  const fibers = []
  const credentialRecords = new Map()
  let settingsConfigured = null

  t.after(async () => {
    for (const f of [...fibers].reverse()) {
      await f.dispose().catch(() => {})
    }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  await fibers.push(ctx.plugin(Storage))
  await fibers.at(-1).await()
  await fibers.push(ctx.plugin(StorageJson, { root }))
  await fibers.at(-1).await()
  await fibers.push(ctx.plugin(StorageDomain, { backend: 'json' }))
  await fibers.at(-1).await()

  ctx.provide('dshHomePath', (...parts) => path.join(root, ...parts))
  ctx.provide('credentials', {
    readRecord: async (key) => credentialRecords.get(key),
    modifyRecord: async (key, mutate) => {
      const next = await mutate(credentialRecords.get(key))
      if (next !== undefined) credentialRecords.set(key, next)
      return next
    },
    deleteRecord: async (key) => {
      credentialRecords.delete(key)
    },
  })
  ctx.provide('settings', {
    configure(cfg) {
      settingsConfigured = cfg
    },
  })
  ctx.provide('connection', {
    fetch: {
      register: () => () => {},
    },
  })

  if (opts.useRealApply) {
    const pluginFiber = ctx.plugin(hooksPlugin)
    fibers.push(pluginFiber)
    await pluginFiber.await()
    return { ctx, root, credentialRecords, getSettingsConfigured: () => settingsConfigured }
  }

  const runtime = await hooksPlugin.createHooksPluginRuntime(ctx, {
    dataDir: root,
    platform: opts.platform ?? 'linux',
    spawnImpl: opts.spawnImpl,
    fetchImpl: opts.fetchImpl,
    turnCompleteDebounceMs: opts.turnCompleteDebounceMs,
  })
  t.after(() => runtime.dispose())
  return { ctx, root, runtime, credentialRecords }
}

async function waitFor(predicate, timeoutMs = 4000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const val = await predicate()
    if (val) return val
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`)
}

test('hooks-engine: mounts all 19 points on real Cordis Context, suppresses auto settings form, and materializes 8 default .mjs scripts', async (t) => {
  const { ctx, root, getSettingsConfigured } = await mountTestRuntime(t, { useRealApply: true })
  await waitFor(() => getSettingsConfigured() !== null, 2000)
  assert.deepEqual(getSettingsConfigured(), { auto: false })

  assert.deepEqual(
    HOOK_MOUNT_POINTS.map((m) => m.id),
    ALL_EXPECTED_MOUNT_IDS,
  )

  const defaultDir = getDefaultScriptsDir(root)
  assert.equal(DEFAULT_SCRIPTS.length, 8)
  for (const script of DEFAULT_SCRIPTS) {
    const info = await stat(path.join(defaultDir, script.filename))
    assert.equal(info.isFile(), true)
  }
})

test('hooks-engine: all 19 mount points receive real Cordis events', async (t) => {
  const { ctx, runtime } = await mountTestRuntime(t)
  const dispatched = []
  const dismissed = []
  const origDispatch = runtime.dispatcher.dispatch.bind(runtime.dispatcher)
  t.mock.method(runtime.dispatcher, 'dispatch', async (ev, directive) => {
    dispatched.push({ hookPoint: ev.hookPoint, category: ev.category, summary: ev.summary, toolName: ev.toolName })
    return origDispatch(ev, directive)
  })
  t.mock.method(runtime.dispatcher, 'dismissApproval', (id) => {
    dismissed.push(id)
  })

  // Enable all 19 mount points
  for (const id of ALL_EXPECTED_MOUNT_IDS) {
    await runtime.configStore.toggleMountPoint({ mountPointId: id, enabled: true })
  }

  const session = { id: 'sess-all-19', header: { cwd: 'C:\\work\\alpha' } }
  const agent = { session }

  await ctx.waterfall('approval/request', { agent, callId: 'call-1', toolName: 'Bash', reason: 'Run tests' }, () => 'ok')
  await ctx.waterfall('user-questions/request', { agent, wait: { callId: 'q-1' }, questions: [{ header: 'Proceed?' }] }, () => 'ok')
  await ctx.waterfall('tools/pre-execute', { agent, name: 'Read' }, () => 'ok')
  ctx.emit('tools/result', { agent, name: 'Read' }, { isError: false })
  ctx.emit('tools/result', { agent, name: 'Bash' }, { isError: true, error: { info: { code: 'E_FAIL' } } })
  ctx.emit('session/created', { id: 'sess-created-only', header: { cwd: 'C:\\work\\alpha' } })
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
  ctx.emit('session/event', { id: 'sess-all-19-completed', header: { cwd: 'C:\\work\\alpha' } }, {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'completed' } },
  })
  ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { code: 'E_TURN' } } } })
  ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'blocked' } } })
  ctx.emit('session/event', session, { type: 'approval/asked', data: { id: 'appr-9', callId: 'call-9', toolName: 'Write' } })
  ctx.emit('session/event', session, { type: 'approval/decided', data: { id: 'appr-9' } })
  ctx.emit('session/event', session, { type: 'job/settled', data: { status: 'completed', label: 'Index' } })
  ctx.emit('session/event', session, { type: 'compaction/end', data: {} })
  ctx.emit('subagent/start', { parentSessionId: session.id })
  ctx.emit('subagent/end', { parentSessionId: session.id, stopReason: 'done' })
  ctx.emit('workflow/start', { meta: { name: 'wf-1' } })
  ctx.emit('workflow/end', { meta: { name: 'wf-1' } }, { stopReason: 'completed' })
  ctx.emit('goal/changed', { agent })
  ctx.emit('deepseek-account/session-expired')
  ctx.emit('session/disposed', { id: 'sess-created-only', header: { cwd: 'C:\\work\\alpha' } })

  await waitFor(() => {
    const seen = new Set(dispatched.map((d) => d.hookPoint))
    return ALL_EXPECTED_MOUNT_IDS.every((id) => seen.has(id))
  }, 6000)

  const seenSet = new Set(dispatched.map((d) => d.hookPoint))
  for (const id of ALL_EXPECTED_MOUNT_IDS) {
    assert.equal(seenSet.has(id), true, `Missing dispatch for mount point ${id}`)
  }
  assert.equal(dismissed.includes('appr-9'), true)
  assert.equal(dismissed.includes('call-9'), true)
})

test('hooks-engine: waterfall hooks NEVER block next() even when custom scripts sleep or fail', async (t) => {
  const { ctx, root, runtime } = await mountTestRuntime(t)

  const slowScript = await saveUploadedScript(root, {
    filename: 'slow.mjs',
    buffer: Buffer.from('setTimeout(() => { process.stdout.write(JSON.stringify({ notify: true }) + "\\n") }, 3500)\n'),
    timeoutSeconds: 6,
  })
  const crashScript = await saveUploadedScript(root, {
    filename: 'crash.mjs',
    buffer: Buffer.from('throw new Error("boom");\n'),
    timeoutSeconds: 5,
  })

  for (const mpId of ['approval.request', 'user.question', 'tool.pre']) {
    await runtime.configStore.toggleMountPoint({ mountPointId: mpId, enabled: true })
    await runtime.configStore.addCustomScript({ mountPointId: mpId, scriptEntry: { ...slowScript, id: `slow-${mpId}` } })
    await runtime.configStore.addCustomScript({ mountPointId: mpId, scriptEntry: { ...crashScript, id: `crash-${mpId}` } })
  }

  const session = { id: 's-waterfall', header: { cwd: root } }
  const agent = { session }

  const t0 = performance.now()
  const r1 = await ctx.waterfall('approval/request', { agent, callId: 'w1', toolName: 'Bash' }, async () => 'inner-approval')
  const r2 = await ctx.waterfall('user-questions/request', { agent, wait: { callId: 'w2' }, questions: [{ header: 'Q' }] }, async () => 'inner-question')
  const r3 = await ctx.waterfall('tools/pre-execute', { agent, name: 'Bash' }, async () => 'inner-tool')
  const elapsed = performance.now() - t0
  const slowFinishedAtReturn = runtime.scriptRunner.getLogs().filter((l) => l.scriptId.startsWith('slow-')).length

  assert.equal(r1, 'inner-approval')
  assert.equal(r2, 'inner-question')
  assert.equal(r3, 'inner-tool')
  assert.equal(slowFinishedAtReturn, 0, 'Waterfall next() must return before slow scripts finish')
  assert.equal(elapsed < 3400, true, `Waterfall blocked for ${elapsed}ms (should not await 3500ms scripts)`)

  // Wait for all 8 async background script runs (3 approval + 3 question + 2 tool.pre) to finish before temp dir cleanup
  await waitFor(() => runtime.scriptRunner.getLogs().length >= 8, 10000)
  const logs = runtime.scriptRunner.getLogs()
  assert.equal(logs.filter((l) => l.scriptId.startsWith('slow-') && l.exitCode === 0).length, 3)
  assert.equal(logs.filter((l) => l.scriptId.startsWith('crash-') && l.exitCode !== 0).length, 3)
})

test('hooks-engine: deduplicates turn/end[error] and agent/error within window', async (t) => {
  const { ctx, runtime } = await mountTestRuntime(t)
  const failedCalls = []
  t.mock.method(runtime.dispatcher, 'dispatch', async (ev) => {
    if (ev.hookPoint === 'turn.failed') failedCalls.push(ev)
    return { dispatched: true }
  })

  // Disable default script so dispatch triggers fast without extra subprocess delay
  await runtime.configStore.toggleScript({
    mountPointId: 'turn.failed',
    scriptId: 'notify-task-failed',
    enabled: false,
  })

  const session = { id: 's-dedup', header: { cwd: 'C:\\repo\\demo' } }
  const agent = { session }

  // Case A: turn/end[error] followed by agent/error for turn 3 -> only 1 dispatch
  ctx.emit('session/event', session, {
    type: 'turn/end',
    data: { turn: 3, reason: { kind: 'error', error: { code: 'E_FAIL_3' } } },
  })
  ctx.emit('agent/error', { agent, turn: 3, error: { code: 'E_FAIL_3' } })

  // Case B: agent/error followed by turn/end[error] for turn 4 -> only 1 dispatch
  ctx.emit('agent/error', { agent, turn: 4, error: { code: 'E_FAIL_4' } })
  ctx.emit('session/event', session, {
    type: 'turn/end',
    data: { turn: 4, reason: { kind: 'error', error: { code: 'E_FAIL_4' } } },
  })

  await waitFor(() => failedCalls.length === 2, 3000)
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(failedCalls.length, 2)
})

test('hooks-engine: executes default .mjs scripts via real Node subprocess and records directive / audit log', async (t) => {
  const { root, runtime } = await mountTestRuntime(t)

  const doneTest = await runtime.bridge.testScript('turn.completed', 'notify-task-done')
  assert.equal(doneTest.exitCode, 0)
  assert.equal(doneTest.suppressed, false)
  assert.deepEqual(doneTest.directive, {
    notify: true,
    level: 'success',
  })
  assert.deepEqual(JSON.parse(doneTest.stdout.trim()), {
    notify: true,
    level: 'success',
    hookPoint: 'turn.completed',
  })

  const auditTest = await runtime.bridge.testScript('tool.post', 'audit-log-example')
  assert.equal(auditTest.exitCode, 0)
  assert.equal(auditTest.suppressed, true)
  assert.equal(auditTest.directive?.suppress, true)
  assert.equal(auditTest.directive?.notify, false)

  const auditFile = await readFile(path.join(root, 'hooks', 'logs', 'tool-audit.jsonl'), 'utf8')
  const parsedLine = JSON.parse(auditFile.trim().split(/\r?\n/).at(-1))
  assert.equal(parsedLine.hookPoint, 'tool.post')
  assert.equal(parsedLine.toolName, 'bash')
})

test('hooks-engine: custom script upload rejects traversal/bad ext, scrubs secret env vars, honors suppress/matcher/timeout', async (t) => {
  const { ctx, root, runtime } = await mountTestRuntime(t)

  // Path traversal & disallowed extension rejections
  await assert.rejects(
    () => saveUploadedScript(root, { filename: 'evil.exe', buffer: Buffer.from('x') }),
    (err) => err.code === 'hooks/invalid-script-type',
  )
  await assert.rejects(
    () => saveUploadedScript(root, { filename: 'noext', buffer: Buffer.from('x') }),
    (err) => err.code === 'hooks/invalid-script-type',
  )
  await assert.rejects(
    () => saveUploadedScript(root, { filename: 'bad\0name.mjs', buffer: Buffer.from('x') }),
    (err) => err.code === 'hooks/invalid-script-name',
  )
  assert.throws(
    () => resolveScriptFilePath(root, { kind: 'custom', filename: '../escape.mjs' }),
    (err) => err.code === 'hooks/invalid-script-name',
  )
  assert.throws(
    () => resolveScriptFilePath(root, { kind: 'custom', filename: 'sub\\escape.mjs' }),
    (err) => err.code === 'hooks/invalid-script-name',
  )

  // Symlink escape guard inside readScriptSource (if OS allows symlinks; otherwise verify non-existent/invalid custom filename)
  const outsideFile = path.join(root, 'outside.mjs')
  await writeFile(outsideFile, 'console.log("secret")\n', 'utf8')
  const customIdFile = '11111111-1111-4111-8111-111111111111.mjs'
  const linkPath = path.join(getCustomScriptsDir(root), customIdFile)
  let createdSymlink = false
  try {
    await symlink(outsideFile, linkPath)
    createdSymlink = true
  } catch {
    // Windows without Developer Mode may disallow symlink creation; skip symlink-specific fs setup if EPERM
  }
  if (createdSymlink) {
    await assert.rejects(
      () => readScriptSource(root, { kind: 'custom', filename: customIdFile }),
      (err) => err.code === 'hooks/script-not-found' || err.code === 'hooks/path-escape',
    )
  }

  // Inject host secrets into process.env temporarily and verify child script never receives them
  const prevOpenAi = process.env.OPENAI_API_KEY
  const prevDeepSeek = process.env.DEEPSEEK_API_KEY
  const prevSecret = process.env.HOST_SECRET_TOKEN
  const prevDshSecret = process.env.DSH_INTERNAL_PASSWORD
  process.env.OPENAI_API_KEY = 'sk-openai-do-not-leak'
  process.env.DEEPSEEK_API_KEY = 'sk-deepseek-do-not-leak'
  process.env.HOST_SECRET_TOKEN = 'tok-do-not-leak'
  process.env.DSH_INTERNAL_PASSWORD = 'pw-do-not-leak'
  t.after(() => {
    if (prevOpenAi === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = prevOpenAi
    if (prevDeepSeek === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = prevDeepSeek
    if (prevSecret === undefined) delete process.env.HOST_SECRET_TOKEN
    else process.env.HOST_SECRET_TOKEN = prevSecret
    if (prevDshSecret === undefined) delete process.env.DSH_INTERNAL_PASSWORD
    else process.env.DSH_INTERNAL_PASSWORD = prevDshSecret
  })

  const envCheckScript = await saveUploadedScript(root, {
    filename: 'inspect-env.mjs',
    name: 'Env Inspector',
    matcher: 'Bash|Write',
    timeoutSeconds: 10,
    buffer: Buffer.from(`
      import { readFileSync } from 'node:fs'
      const stdin = JSON.parse(readFileSync(0, 'utf8'))
      const out = {
        notify: true,
        summary: 'Tool ' + stdin.toolName + ' on ' + process.env.DSH_HOOK_POINT,
        leaked: Boolean(
          process.env.OPENAI_API_KEY ||
          process.env.DEEPSEEK_API_KEY ||
          process.env.HOST_SECRET_TOKEN ||
          process.env.DSH_INTERNAL_PASSWORD
        ),
        dshPoint: process.env.DSH_HOOK_POINT,
        dshCat: process.env.DSH_HOOK_CATEGORY,
      }
      process.stdout.write(JSON.stringify(out) + '\\n')
    `),
  })

  await runtime.configStore.toggleMountPoint({ mountPointId: 'tool.post', enabled: true })
  await runtime.configStore.addCustomScript({ mountPointId: 'tool.post', scriptEntry: envCheckScript })

  const envRun = await runtime.scriptRunner.executeScript(envCheckScript, {
    hookPoint: 'tool.post',
    category: 'UserPromptSubmit',
    toolName: 'Bash',
    projectName: 'my-proj',
  })
  assert.equal(envRun.exitCode, 0)
  const parsedOut = JSON.parse(envRun.stdout.trim())
  assert.equal(parsedOut.leaked, false)
  assert.equal(parsedOut.dshPoint, 'tool.post')
  assert.equal(parsedOut.dshCat, 'UserPromptSubmit')

  // Matcher filters tool names: Read does NOT trigger inspect-env, Bash DOES
  const dispatchedTools = []
  t.mock.method(runtime.dispatcher, 'dispatch', async (ev, directive) => {
    dispatchedTools.push({ toolName: ev.toolName, summary: directive?.summary })
    return { dispatched: true }
  })

  ctx.emit('tools/result', { agent: { session: { id: 's-match', header: { cwd: root } } }, name: 'Read' }, { isError: false })
  await waitFor(() => dispatchedTools.some((d) => d.toolName === 'Read'), 3000)
  assert.equal(dispatchedTools.find((d) => d.toolName === 'Read').summary, undefined)

  ctx.emit('tools/result', { agent: { session: { id: 's-match', header: { cwd: root } } }, name: 'Bash' }, { isError: false })
  await waitFor(() => dispatchedTools.some((d) => d.toolName === 'Bash'), 3000)
  assert.equal(dispatchedTools.find((d) => d.toolName === 'Bash').summary, 'Tool Bash on tool.post')

  // {"suppress":true} silences notification
  const suppressScript = await saveUploadedScript(root, {
    filename: 'suppress.mjs',
    buffer: Buffer.from('process.stdout.write(JSON.stringify({ suppress: true }) + "\\n")\n'),
  })
  await runtime.configStore.addCustomScript({ mountPointId: 'turn.completed', scriptEntry: suppressScript })
  const suppressedDispatches = []
  const prevDispatchCount = dispatchedTools.length
  const prevLogCount = runtime.scriptRunner.getLogs().length
  ctx.emit('session/event', { id: 's-sup', header: { cwd: root } }, {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'completed' } },
  })
  await waitFor(() => runtime.scriptRunner.getLogs().length > prevLogCount, 5000)
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(dispatchedTools.length, prevDispatchCount)
  assert.equal(suppressedDispatches.length, 0)
  assert.equal(runtime.scriptRunner.getLogs().some((l) => l.scriptId === suppressScript.id && l.suppressed === true), true)

  // timeoutSeconds kills runaway script
  const runawayScript = await saveUploadedScript(root, {
    filename: 'runaway.mjs',
    timeoutSeconds: 1,
    buffer: Buffer.from('setInterval(() => {}, 1000)\n'),
  })
  const tStart = performance.now()
  const timeoutRun = await runtime.scriptRunner.executeScript(runawayScript, {
    hookPoint: 'turn.start',
    category: 'UserPromptSubmit',
  })
  const elapsedTimeout = performance.now() - tStart
  assert.equal(timeoutRun.timedOut, true)
  assert.equal(elapsedTimeout < 3500, true, `Runaway script took ${elapsedTimeout}ms`)
})

test('config-store: masks third-party secrets and preserves secrets when omitted/blank on update', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-hooks-cfg-'))
  const credentialRecords = new Map()
  const store = createConfigStore({
    getDataDir: () => root,
    credentials: {
      readRecord: async (key) => credentialRecords.get(key),
      modifyRecord: async (key, mutate) => {
        const next = await mutate(credentialRecords.get(key))
        if (next !== undefined) credentialRecords.set(key, next)
        return next
      },
      deleteRecord: async (key) => {
        credentialRecords.delete(key)
      },
    },
  })
  t.after(async () => {
    await store.close()
    await rm(root, { recursive: true, force: true })
  })

  await store.init()

  const created = await store.saveThirdPartyTarget({
    expectedRevision: 0,
    target: {
      name: 'My Bark',
      provider: 'bark',
      enabled: true,
      events: { Stop: true, PermissionRequest: true },
      config: {
        serverUrl: 'https://api.day.app',
        deviceKey: 'bark-secret-key-9876',
        basicUsername: 'alice',
        basicPassword: 'pw-secret-4321',
      },
    },
  })

  const targetId = created.targetId
  const view1 = created.config.thirdParty.targets[0]
  assert.equal(view1.id, targetId)
  assert.equal(view1.config.deviceKey, undefined)
  assert.equal(view1.config.basicPassword, undefined)
  assert.equal(JSON.stringify(view1).includes('bark-secret-key-9876'), false)
  assert.equal(JSON.stringify(view1).includes('pw-secret-4321'), false)
  assert.deepEqual(view1.secretState, {
    deviceKey: { configured: true, preview: '••••9876' },
    basicPassword: { configured: true, preview: '••••4321' },
  })
  assert.deepEqual(store.getResolvedSecrets(targetId), {
    deviceKey: 'bark-secret-key-9876',
    basicPassword: 'pw-secret-4321',
  })
  assert.equal(credentialRecords.get(SECRET_CREDENTIAL_KEY)?.kind, 'grant')

  // Update name/group with blank secrets -> existing secrets preserved
  const updated = await store.saveThirdPartyTarget({
    expectedRevision: created.revision,
    target: {
      id: targetId,
      name: 'My Bark Updated',
      provider: 'bark',
      enabled: true,
      config: {
        serverUrl: 'https://api.day.app',
        group: 'team',
        deviceKey: '',
        basicUsername: 'alice',
      },
    },
  })
  assert.equal(updated.config.thirdParty.targets[0].name, 'My Bark Updated')
  assert.equal(updated.config.thirdParty.targets[0].config.group, 'team')
  assert.deepEqual(store.getResolvedSecrets(targetId), {
    deviceKey: 'bark-secret-key-9876',
    basicPassword: 'pw-secret-4321',
  })

  // Change provider -> previous provider secrets are replaced, not leaked across providers
  const switched = await store.saveThirdPartyTarget({
    expectedRevision: updated.revision,
    target: {
      id: targetId,
      name: 'Now WeCom',
      provider: 'wecom',
      enabled: true,
      config: {
        webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=wecom-new-5555',
      },
    },
  })
  assert.equal(switched.config.thirdParty.targets[0].provider, 'wecom')
  assert.deepEqual(store.getResolvedSecrets(targetId), {
    webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=wecom-new-5555',
  })
})

test('hooks-engine: subagent sessions never emit turn/session/job notifications while preserving approval.request', async (t) => {
  const { ctx, runtime } = await mountTestRuntime(t, { turnCompleteDebounceMs: 20 })
  for (const id of ['turn.completed', 'turn.failed', 'turn.start', 'session.start', 'session.end', 'job.settled', 'compaction.end', 'approval.request']) {
    await runtime.configStore.toggleMountPoint({ mountPointId: id, enabled: true })
  }

  const dispatched = []
  t.mock.method(runtime.dispatcher, 'dispatch', async (ev) => {
    dispatched.push({ hookPoint: ev.hookPoint, sessionId: ev.sessionId, approvalId: ev.approvalId })
    return { dispatched: true, channels: [] }
  })

  const subByOrigin = { id: 'sub-origin-1', header: { origin: 'subagent', cwd: 'C:\\work\\alpha' } }
  const subByDepth = { id: 'sub-depth-2', header: { delegationDepth: 1, cwd: 'C:\\work\\alpha' } }
  const subByEvent = { id: 'sub-ev-3', header: { cwd: 'C:\\work\\alpha' } }

  ctx.emit('subagent/start', { id: subByEvent.id, parentSessionId: 'main-parent', runId: 'run-sub-3' })
  ctx.emit('session/created', subByOrigin)
  ctx.emit('agent/created', { agent: { session: subByDepth }, source: 'subagent' })
  ctx.emit('session/event', subByOrigin, { type: 'turn/start', data: { turn: 1 } })
  ctx.emit('session/event', subByOrigin, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  ctx.emit('session/event', subByDepth, { type: 'turn/end', data: { turn: 2, reason: { kind: 'error', error: { code: 'E_SUB' } } } })
  ctx.emit('session/event', subByEvent, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  ctx.emit('agent/error', { agent: { session: subByOrigin }, turn: 3, error: { code: 'E_AGENT_SUB' } })
  ctx.emit('session/event', subByOrigin, { type: 'job/settled', data: { status: 'completed', label: 'Sub Job' } })
  ctx.emit('session/event', subByOrigin, { type: 'compaction/end', data: {} })
  ctx.emit('session/disposed', subByOrigin)

  // Subagent approval prompts must still notify the user
  await ctx.waterfall('approval/request', { agent: { session: subByOrigin }, callId: 'sub-call-1', toolName: 'Bash', reason: 'Approve subagent shell' }, () => 'ok')
  ctx.emit('session/event', subByDepth, {
    type: 'approval/asked',
    data: { id: 'sub-appr-2', callId: 'sub-call-2', toolName: 'Write', reason: 'Approve subagent write' },
  })

  await waitFor(() => dispatched.filter((d) => d.hookPoint === 'approval.request').length === 2, 3000)
  await new Promise((r) => setTimeout(r, 120))

  const nonSubagentHooks = dispatched.filter((d) => d.hookPoint !== 'approval.request' && d.hookPoint !== 'subagent.start')
  assert.deepEqual(nonSubagentHooks, [])
})

test('hooks-engine: turn.completed skips armed Goal rounds, pending inbox continuations, and active subagents', async (t) => {
  const { ctx, runtime } = await mountTestRuntime(t, { turnCompleteDebounceMs: 30 })
  await runtime.configStore.toggleMountPoint({ mountPointId: 'turn.completed', enabled: true })

  const mainSession = { id: 'main-goal-sess', header: { cwd: 'C:\\work\\alpha' } }
  const liveAgent = { session: mainSession, status: 'idle', inbox: { hasPending: false } }
  let currentGoal = { phase: 'active', activation: 'armed', roundsStarted: 1, maxGoalRounds: 5 }

  ctx.provide('sessions', { get: (id) => (id === mainSession.id ? mainSession : undefined) })
  ctx.provide('agents', { get: (id) => (id === mainSession.id ? liveAgent : undefined) })
  ctx.provide('goals', { get: (agent) => (agent === liveAgent ? currentGoal : undefined) })

  const dispatched = []
  t.mock.method(runtime.dispatcher, 'dispatch', async (ev) => {
    dispatched.push({ hookPoint: ev.hookPoint, reason: ev.reason, summary: ev.summary, turn: ev.turn })
    return { dispatched: true, channels: [] }
  })

  // 1. Active armed Goal round -> skipped
  ctx.emit('session/event', mainSession, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(dispatched.length, 0)

  // 2. Queued inbox continuation -> skipped
  currentGoal = null
  liveAgent.inbox.hasPending = true
  ctx.emit('session/event', mainSession, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(dispatched.length, 0)

  // 3. Active subagent still running for parent -> skipped
  liveAgent.inbox.hasPending = false
  ctx.emit('subagent/start', { id: 'child-1', runId: 'run-child-1', parentSessionId: mainSession.id })
  ctx.emit('session/event', mainSession, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(dispatched.length, 0)

  // 4. Child finished & Goal complete -> final turn.completed fires
  ctx.emit('subagent/end', { id: 'child-1', runId: 'run-child-1', parentSessionId: mainSession.id, stopReason: 'done' })
  currentGoal = { phase: 'complete', activation: 'idle', roundsStarted: 3, maxGoalRounds: 5 }
  ctx.emit('session/event', mainSession, { type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } })

  await waitFor(() => dispatched.length === 1, 3000)
  assert.equal(dispatched[0].hookPoint, 'turn.completed')
  assert.equal(dispatched[0].reason, 'goal-completed')
  assert.equal(dispatched[0].summary, '目标任务已完成')
  assert.equal(dispatched[0].turn, 4)
})

test('hooks-engine: turn.completed debounce cancels on rapid turn/start or agent running', async (t) => {
  const { ctx, runtime } = await mountTestRuntime(t, { turnCompleteDebounceMs: 120 })
  await runtime.configStore.toggleMountPoint({ mountPointId: 'turn.completed', enabled: true })

  const dispatched = []
  t.mock.method(runtime.dispatcher, 'dispatch', async (ev) => {
    dispatched.push({ hookPoint: ev.hookPoint, turn: ev.turn })
    return { dispatched: true, channels: [] }
  })

  const session = { id: 'sess-debounce', header: { cwd: 'C:\\work\\alpha' } }

  // Cancelled by next turn/start
  ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await new Promise((r) => setTimeout(r, 30))
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 2 } })
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(dispatched.length, 0)

  // Cancelled by agent/status -> running
  ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  await new Promise((r) => setTimeout(r, 30))
  ctx.emit('agent/status', { agent: { session }, status: 'running' })
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(dispatched.length, 0)

  // Uninterrupted turn/end[completed] dispatches after debounce window
  ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })
  await waitFor(() => dispatched.length === 1, 3000)
  assert.equal(dispatched[0].turn, 3)
})

test('hooks-engine: ctx.jobs.events filters awaited, teardown, and subagent settled jobs', async (t) => {
  const { ctx, runtime } = await mountTestRuntime(t, { turnCompleteDebounceMs: 20 })
  await runtime.configStore.toggleMountPoint({ mountPointId: 'job.settled', enabled: true })

  let jobsListener = null
  ctx.provide('jobs', {
    events: {
      subscribe(_filter, listener) {
        jobsListener = listener
        return () => {
          jobsListener = null
        }
      },
    },
  })
  await waitFor(() => typeof jobsListener === 'function', 2000)

  const dispatched = []
  t.mock.method(runtime.dispatcher, 'dispatch', async (ev) => {
    dispatched.push({ hookPoint: ev.hookPoint, sessionId: ev.sessionId, reason: ev.reason, summary: ev.summary })
    return { dispatched: true, channels: [] }
  })

  const subSession = { id: 'sub-job-owner', header: { origin: 'subagent', cwd: 'C:\\work\\alpha' } }
  ctx.emit('session/created', subSession)

  // Foreground command (awaited: true), teardown, subagent owner, and fallback session job/settled must not notify
  jobsListener({
    type: 'settled',
    awaited: true,
    job: { id: 'job-fg-1', owner: 'main-owner', status: 'completed', label: 'git status' },
  })
  jobsListener({
    type: 'settled',
    awaited: false,
    cause: 'teardown',
    job: { id: 'job-td-2', owner: 'main-owner', status: 'aborted', label: 'cleanup' },
  })
  jobsListener({
    type: 'settled',
    awaited: false,
    job: { id: 'job-sub-3', owner: subSession.id, status: 'completed', label: 'sub task' },
  })
  ctx.emit('session/event', { id: 'main-owner', header: { cwd: 'C:\\work\\alpha' } }, {
    type: 'job/settled',
    data: { jobId: 'job-fallback-ignore', status: 'completed', label: 'Fallback Shell' },
  })

  await new Promise((r) => setTimeout(r, 120))
  assert.equal(dispatched.length, 0)

  // Real unawaited main-session background job must notify
  jobsListener({
    type: 'settled',
    awaited: false,
    job: { id: 'job-bg-4', owner: 'main-owner', status: 'completed', label: 'Long Build' },
  })

  await waitFor(() => dispatched.length === 1, 3000)
  assert.equal(dispatched[0].hookPoint, 'job.settled')
  assert.equal(dispatched[0].sessionId, 'main-owner')
  assert.match(dispatched[0].summary, /Long Build/)
})

test('hooks-engine: default job.settled is disabled and execution.jsonl persists logs across init()', async (t) => {
  const { ctx, root, runtime } = await mountTestRuntime(t, { turnCompleteDebounceMs: 20 })
  const snap = runtime.configStore.getSnapshot()
  assert.equal(snap.config.mountPoints['job.settled'].enabled, false)
  assert.equal(snap.config.mountPoints['turn.completed'].enabled, true)
  const jobScript = snap.config.mountPoints['job.settled'].scripts.find((s) => s.id === 'notify-job-settled')
  assert.equal(jobScript?.enabled, false)

  const sess = { id: 'sess-persist-log', header: { cwd: 'C:\\work\\alpha' } }
  const liveAgent = { session: sess, status: 'idle', inbox: { hasPending: false } }
  ctx.provide('agents', { get: (id) => (id === sess.id ? liveAgent : undefined) })

  // 1. Trigger a real turn.completed execution (persists both 'default' script record and 'trigger' diagnostic)
  ctx.emit('session/event', sess, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  await waitFor(() => runtime.scriptRunner.getLogs().some((entry) => entry.mountPointId === 'turn.completed'), 4000)

  // 2. Trigger a skipped turn.completed (persists 'skip' diagnostic without polluting getLogs())
  liveAgent.inbox.hasPending = true
  ctx.emit('session/event', sess, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })
  await new Promise((r) => setTimeout(r, 80))
  await runtime.scriptRunner.flushLogs()

  const logFile = getExecutionLogPath(root)
  const raw = await readFile(logFile, 'utf8')
  const records = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))

  assert.equal(records.some((r) => r.kind === 'default' && r.mountPointId === 'turn.completed' && r.turn === 2), true)
  assert.equal(records.some((r) => r.kind === 'trigger' && r.mountPointId === 'turn.completed' && r.turn === 2), true)
  assert.equal(records.some((r) => r.kind === 'skip' && r.mountPointId === 'turn.completed' && r.reason === 'inbox-pending' && r.turn === 3), true)

  // Reload in a fresh runner instance: script runs are restored, trigger/skip diagnostics stay out of getLogs()
  const reloadedRunner = createScriptRunner({ getDataDir: () => root })
  await reloadedRunner.init()
  const reloadedLogs = reloadedRunner.getLogs()
  assert.equal(reloadedLogs.some((r) => r.kind === 'default' && r.mountPointId === 'turn.completed' && r.turn === 2), true)
  assert.equal(reloadedLogs.some((r) => r.kind === 'trigger' || r.kind === 'skip'), false)
})
