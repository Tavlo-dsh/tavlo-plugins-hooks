import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { HOOK_MOUNT_POINTS, CATEGORY_META } from '../src/hook-catalog.js'
import { PROVIDER_DEFINITIONS, getSecretFieldKeys } from '../src/third-party-providers.js'
import { buildDefaultConfig, maskSecretPreview } from '../src/config-store.js'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../', import.meta.url))
const DEFAULT_SCREENSHOT_DIR = 'C:\\Users\\1\\.gemini\\antigravity\\brain\\0ede8bef-4629-444c-ba34-a5132d13df1a\\scratch'

function resolvePlaywrightPath() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    (() => {
      try {
        return require.resolve('playwright')
      } catch {
        return null
      }
    })(),
    (() => {
      try {
        return require.resolve('playwright-core')
      } catch {
        return null
      }
    })(),
    'C:/Users/1/AppData/Local/Programs/Python/Python310/lib/site-packages/playwright/driver/package/index.mjs',
    'F:/python/codex-manager-v3/.venv/Lib/site-packages/playwright/driver/package/index.mjs',
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (existsSync(candidate)) return resolve(candidate)
  }
  throw new Error('Could not locate playwright / playwright-core module')
}

function resolveBrowserExecutable() {
  const candidates = [
    process.env.BROWSER_EXECUTABLE,
    process.env.BROWSER_EXE,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

function createValidWavBytes() {
  const buf = Buffer.alloc(60)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(52, 4)
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
  buf.writeUInt32LE(16, 40)
  buf.fill(0x80, 44)
  return buf
}

async function prepareSmokePage(tempDir) {
  const initialState = {
    revision: 1,
    isWindows: true,
    platform: 'win32',
    isWsl: false,
    config: buildDefaultConfig(),
    customSound: null,
    mountPoints: HOOK_MOUNT_POINTS,
    categories: CATEGORY_META,
    providers: PROVIDER_DEFINITIONS,
    logs: [],
  }

  const secretFieldsByProvider = Object.fromEntries(
    PROVIDER_DEFINITIONS.map((def) => [def.id, getSecretFieldKeys(def.id)]),
  )

  const bootstrapSource = String.raw`
    import React, { useState } from 'react';
    import * as JSX from 'react/jsx-runtime';
    import * as ReactDOM from 'react-dom';
    import { createRoot } from 'react-dom/client';

    const modules = {
      'react': React,
      'react/jsx-runtime': JSX,
      'react-dom': ReactDOM,
      'react-dom/client': { createRoot },
      '@deepseek-ai/dsh-client-ui-primitives': {},
    };

    const SECRET_FIELDS = ${JSON.stringify(secretFieldsByProvider)};
    const state = structuredClone(${JSON.stringify(initialState)});
    const storedSecrets = new Map();
    const scriptSources = new Map([
      ['notify-approval', '// DSH Default Hook: Approval Request\nprocess.stdout.write(JSON.stringify({ notify: true, level: "approval" }) + "\\n");\n'],
      ['notify-attention', '// DSH Default Hook: Needs Attention\nprocess.stdout.write(JSON.stringify({ notify: true, level: "attention" }) + "\\n");\n'],
      ['notify-task-done', '// DSH Default Hook: Task Completed\nprocess.stdout.write(JSON.stringify({ notify: true, level: "success" }) + "\\n");\n'],
      ['notify-task-failed', '// DSH Default Hook: Task Failed\nprocess.stdout.write(JSON.stringify({ notify: true, level: "error" }) + "\\n");\n'],
      ['notify-job-settled', '// DSH Default Hook: Job Settled\nprocess.stdout.write(JSON.stringify({ notify: true, level: "info" }) + "\\n");\n'],
      ['notify-session-start', '// DSH Default Hook: Session Start\nprocess.stdout.write(JSON.stringify({ notify: true, level: "info" }) + "\\n");\n'],
      ['notify-subagent-end', '// DSH Default Hook: Subagent Finished\nprocess.stdout.write(JSON.stringify({ notify: true, level: "success" }) + "\\n");\n'],
      ['audit-log-example', '// DSH Hook Tool Audit Example\nprocess.stdout.write(JSON.stringify({ notify: false, suppress: true, audited: true }) + "\\n");\n'],
    ]);
    let savedWavBytes = null;

    window.smokeMetrics = {
      rpcCalls: [],
      clientStates: [],
      audioPlays: [],
      openedSessions: [],
      soundFetches: 0,
    };

    function maskPreview(val) {
      if (!val) return '';
      return val.length <= 4 ? '••••' : '••••' + val.slice(-4);
    }

    function publicView() {
      const cloned = structuredClone(state);
      cloned.config.thirdParty.targets = cloned.config.thirdParty.targets.map((target) => {
        const keys = SECRET_FIELDS[target.provider] || [];
        const bag = storedSecrets.get(target.id) || {};
        const secretState = {};
        for (const key of keys) {
          const v = bag[key];
          secretState[key] = {
            configured: Boolean(v),
            ...(v ? { preview: maskPreview(v) } : {}),
          };
        }
        return { ...target, secretState };
      });
      return cloned;
    }

    const sseControllers = new Set();
    window.smokePushSse = (eventName, payload) => {
      const text = 'event: ' + eventName + '\ndata: ' + JSON.stringify(payload) + '\n\n';
      const bytes = new TextEncoder().encode(text);
      for (const ctrl of sseControllers) {
        try { ctrl.enqueue(bytes); } catch {}
      }
    };

    window.Audio = class MockAudio {
      constructor(src) {
        this.src = src;
      }
      pause() {}
      async play() {
        window.smokeMetrics.audioPlays.push(this.src);
        const res = await window.fetch(this.src);
        if (!res.ok) throw new Error('Audio fetch failed: ' + res.status);
      }
    };

    window.Notification = Object.assign(
      function MockNotification(title, opts) {
        this.title = title;
        this.opts = opts;
        this.close = () => {};
      },
      { permission: 'granted', requestPermission: async () => 'granted' }
    );

    const origFetch = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
      const urlStr = typeof input === 'string' ? input : input.url;
      if (urlStr.includes('api/tavlo-hooks/events')) {
        let controller;
        const body = new ReadableStream({
          start(ctrl) {
            controller = ctrl;
            sseControllers.add(ctrl);
            ctrl.enqueue(new TextEncoder().encode(': connected\n\n'));
          },
          cancel() {
            sseControllers.delete(controller);
          },
        });
        init.signal?.addEventListener('abort', () => {
          sseControllers.delete(controller);
          try { controller.close(); } catch {}
        }, { once: true });
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        });
      }

      if (urlStr.includes('api/tavlo-hooks/client-state')) {
        const parsed = JSON.parse(init.body || '{}');
        window.smokeMetrics.clientStates.push(parsed);
        return Response.json({ ok: true, value: { focusedClients: parsed.focused ? 1 : 0, connectedClients: 1 } });
      }

      if (urlStr.includes('api/tavlo-hooks/sound/upload')) {
        const u = new URL(urlStr, 'http://smoke.local/');
        const filename = u.searchParams.get('filename') || 'custom.wav';
        const ab = await init.body.arrayBuffer();
        const bytes = new Uint8Array(ab);
        const hdr = String.fromCharCode(...bytes.slice(0, 4)) + ':' + String.fromCharCode(...bytes.slice(8, 12));
        if (bytes.byteLength < 12 || hdr !== 'RIFF:WAVE') {
          return Response.json({ ok: false, error: { code: 'sound/invalid-wav', message: 'Invalid WAV' } }, { status: 400 });
        }
        savedWavBytes = bytes;
        state.revision++;
        state.customSound = { filename, bytes: bytes.byteLength, updatedAt: new Date().toISOString() };
        state.config.systemNotifications.customSoundFilename = filename;
        return Response.json({ ok: true, value: publicView() });
      }

      if (urlStr.includes('api/tavlo-hooks/sound/current')) {
        window.smokeMetrics.soundFetches++;
        if (!savedWavBytes) {
          return Response.json({ ok: false, error: { code: 'hooks/sound-not-found', message: 'None' } }, { status: 404 });
        }
        return new Response(savedWavBytes, { status: 200, headers: { 'content-type': 'audio/wav' } });
      }

      if (urlStr.includes('api/tavlo-hooks/scripts/upload')) {
        const u = new URL(urlStr, 'http://smoke.local/');
        const mountPointId = u.searchParams.get('mountPointId');
        const filename = u.searchParams.get('filename') || 'custom.mjs';
        const name = u.searchParams.get('name') || filename;
        const content = await init.body.text();
        const scriptId = 'custom-' + (state.revision + 1);
        const storedFilename = '00000000-0000-4000-8000-' + String(state.revision + 1).padStart(12, '0') + '.mjs';
        scriptSources.set(scriptId, content);
        const entry = {
          id: scriptId,
          kind: 'custom',
          name,
          filename: storedFilename,
          originalFilename: filename,
          enabled: true,
          matcher: u.searchParams.get('matcher') || '',
          timeoutSeconds: Number(u.searchParams.get('timeoutSeconds') || 10),
        };
        state.config.mountPoints[mountPointId].scripts.push(entry);
        state.revision++;
        return Response.json({ ok: true, value: { ...publicView(), script: entry } });
      }

      if (urlStr.includes('api/tavlo-hooks/scripts/source')) {
        const u = new URL(urlStr, 'http://smoke.local/');
        const mountPointId = u.searchParams.get('mountPointId') || '';
        const scriptId = u.searchParams.get('scriptId') || '';
        const entry = state.config.mountPoints[mountPointId]?.scripts.find((s) => s.id === scriptId);
        if (!entry) {
          return Response.json({ ok: false, error: { code: 'hooks/not-found', message: 'Script not found' } }, { status: 404 });
        }
        return Response.json({
          ok: true,
          value: {
            scriptId,
            mountPointId,
            filename: entry.filename,
            kind: entry.kind,
            content: scriptSources.get(scriptId) || '// empty\n',
          },
        });
      }

      return origFetch(input, init);
    };

    const rpc = async (_prefix, _method, { operation, input = {} }) => {
      window.smokeMetrics.rpcCalls.push({ operation, input });
      switch (operation) {
        case 'getState':
          return { ok: true, value: publicView() };
        case 'saveSettings': {
          if (input.expectedRevision !== undefined && input.expectedRevision !== state.revision) {
            return { ok: false, error: { code: 'hooks/revision-conflict', message: 'Revision conflict' } };
          }
          if (input.inApp) Object.assign(state.config.inApp, input.inApp);
          if (input.systemNotifications) Object.assign(state.config.systemNotifications, input.systemNotifications);
          if (input.thirdParty) Object.assign(state.config.thirdParty, input.thirdParty);
          state.revision++;
          return { ok: true, value: publicView() };
        }
        case 'toggleMountPoint': {
          state.config.mountPoints[input.mountPointId].enabled = Boolean(input.enabled);
          state.revision++;
          return { ok: true, value: publicView() };
        }
        case 'toggleMountPointBell': {
          state.config.mountPoints[input.mountPointId].bellEnabled = Boolean(input.bellEnabled);
          state.revision++;
          return { ok: true, value: publicView() };
        }
        case 'toggleScript': {
          const s = state.config.mountPoints[input.mountPointId].scripts.find((x) => x.id === input.scriptId);
          if (s) s.enabled = Boolean(input.enabled);
          state.revision++;
          return { ok: true, value: publicView() };
        }
        case 'updateScriptMeta': {
          const s = state.config.mountPoints[input.mountPointId].scripts.find((x) => x.id === input.scriptId);
          if (s) {
            if (input.matcher !== undefined) s.matcher = input.matcher;
            if (input.timeoutSeconds !== undefined) s.timeoutSeconds = input.timeoutSeconds;
          }
          state.revision++;
          return { ok: true, value: publicView() };
        }
        case 'deleteScript': {
          const list = state.config.mountPoints[input.mountPointId].scripts;
          state.config.mountPoints[input.mountPointId].scripts = list.filter((x) => x.id !== input.scriptId);
          state.revision++;
          return { ok: true, value: publicView() };
        }
        case 'resetDefaultScripts': {
          state.revision++;
          return { ok: true, value: publicView() };
        }
        case 'clearCustomSound': {
          savedWavBytes = null;
          state.customSound = null;
          state.config.systemNotifications.customSoundFilename = null;
          state.revision++;
          return { ok: true, value: publicView() };
        }
        case 'testSystemNotification':
          return { ok: true, value: { ok: true, channel: 'winrt' } };
        case 'testTaskbarFlash':
          return { ok: true, value: { ok: true } };
        case 'saveThirdPartyTarget': {
          const t = input.target || {};
          const id = t.id || 'tp_' + (state.revision + 1);
          const keys = SECRET_FIELDS[t.provider] || [];
          const prevBag = storedSecrets.get(id) || {};
          const nextBag = {};
          const cleanCfg = {};
          for (const [k, v] of Object.entries(t.config || {})) {
            if (keys.includes(k)) {
              if (typeof v === 'string' && v.trim()) nextBag[k] = v.trim();
            } else {
              cleanCfg[k] = v;
            }
          }
          for (const k of keys) {
            if (!nextBag[k] && prevBag[k]) nextBag[k] = prevBag[k];
          }
          storedSecrets.set(id, nextBag);
          const record = {
            id,
            name: t.name,
            provider: t.provider,
            enabled: t.enabled !== false,
            events: t.events || {},
            config: cleanCfg,
          };
          const idx = state.config.thirdParty.targets.findIndex((x) => x.id === id);
          if (idx >= 0) state.config.thirdParty.targets[idx] = record;
          else state.config.thirdParty.targets.push(record);
          state.revision++;
          return { ok: true, value: publicView() };
        }
        case 'toggleThirdPartyTarget': {
          const item = state.config.thirdParty.targets.find((x) => x.id === input.targetId);
          if (item) item.enabled = Boolean(input.enabled);
          state.revision++;
          return { ok: true, value: publicView() };
        }
        case 'deleteThirdPartyTarget': {
          state.config.thirdParty.targets = state.config.thirdParty.targets.filter((x) => x.id !== input.targetId);
          storedSecrets.delete(input.targetId);
          state.revision++;
          return { ok: true, value: publicView() };
        }
        case 'testThirdPartyTarget':
          return { ok: true, value: { accepted: true, elapsedMs: 18, provider: input.target?.provider } };
        case 'testScript': {
          const s = state.config.mountPoints[input.mountPointId]?.scripts.find((x) => x.id === input.scriptId);
          const log = {
            id: 'log-' + Date.now(),
            timestamp: new Date().toISOString(),
            mountPointId: input.mountPointId,
            scriptId: input.scriptId,
            scriptName: s?.name || input.scriptId,
            exitCode: 0,
            elapsedMs: 12,
            dryRun: true,
            stdout: '{"notify":true}',
          };
          state.logs.unshift(log);
          return { ok: true, value: { ...log, logs: state.logs } };
        }
        case 'testMountPoint': {
          const log = {
            id: 'log-' + Date.now(),
            timestamp: new Date().toISOString(),
            mountPointId: input.mountPointId,
            scriptName: 'Mount Trigger',
            exitCode: 0,
            elapsedMs: 15,
            dryRun: true,
          };
          state.logs.unshift(log);
          return { ok: true, value: { ok: true, elapsedMs: 15, logs: state.logs, state: publicView() } };
        }
        case 'getExecutionLogs':
          return { ok: true, value: { logs: state.logs } };
        default:
          return { ok: false, error: { code: 'hooks/not-found', message: 'Unknown ' + operation } };
      }
    };

    const dicts = {};
    const slots = [];

    window.__ModuleLoader__ = {
      load({ id, factory }) {
        window.smokeLoadedPluginId = id;
        const plugin = factory((name) => {
          if (!Object.hasOwn(modules, name)) throw new Error('Unexpected module: ' + name);
          return modules[name];
        });
        plugin.apply({
          effect: (fn) => fn(),
          get: (name) => name === 'uiWorkspace' ? { openSession: (sid) => window.smokeMetrics.openedSessions.push(sid) } : undefined,
          locale: {
            register(ns, lang, dict) {
              dicts[ns + ':' + lang] = dict;
              return () => {};
            },
            bind: (ns) => (key, params) => {
              const lang = document.documentElement.lang === 'en' ? 'en' : 'zh';
              const str = dicts[ns + ':' + lang]?.[key] ?? key;
              if (!params) return str;
              return str.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? ''));
            },
          },
          slots: {
            inject: (_name, fn) => fn(),
            register(descriptor, component) {
              slots.push({ descriptor, component });
              return () => {};
            },
          },
          connection: { rpc: { call: rpc } },
        });

        window.smokeSlots = slots.map((s) => ({ name: s.descriptor.name, id: s.descriptor.id, key: s.descriptor.key }));

        const section = slots.find((s) => s.descriptor.name === 'settings.section');
        const iconSlot = slots.find((s) => s.descriptor.name === 'settings.section.icon');
        const overlaySlot = slots.find((s) => s.descriptor.name === 'shell.overlay');
        const SettingsComp = section.component;
        const IconComp = iconSlot?.component;
        const OverlayComp = overlaySlot.component;

        function SmokeApp() {
          const [activeTab, setActiveTab] = useState('general');
          return React.createElement(
            'div',
            { className: 'smoke-shell' },
            React.createElement(
              'aside',
              { className: 'smoke-sidebar', role: 'tablist', 'aria-label': '设置导航' },
              React.createElement(
                'button',
                {
                  type: 'button',
                  role: 'tab',
                  'aria-selected': activeTab === 'general',
                  className: 'smoke-nav-btn' + (activeTab === 'general' ? ' is-active' : ''),
                  onClick: () => setActiveTab('general'),
                },
                '通用设置'
              ),
              React.createElement(
                'button',
                {
                  type: 'button',
                  role: 'tab',
                  'aria-selected': activeTab === 'hooks',
                  className: 'smoke-nav-btn' + (activeTab === 'hooks' ? ' is-active' : ''),
                  onClick: () => setActiveTab('hooks'),
                },
                IconComp ? React.createElement(IconComp, { size: 16, active: activeTab === 'hooks' }) : null,
                React.createElement('span', null, section.descriptor.label())
              )
            ),
            React.createElement(
              'main',
              { className: 'smoke-main' },
              activeTab === 'general'
                ? React.createElement('div', { className: 'smoke-general' }, 'DSH Settings Shell')
                : React.createElement(SettingsComp, section.descriptor.inject())
            ),
            React.createElement(OverlayComp, overlaySlot.descriptor.inject())
          );
        }

        createRoot(document.getElementById('root')).render(React.createElement(SmokeApp));
      },
    };
  `

  await build({
    stdin: { contents: bootstrapSource, resolveDir: root },
    outfile: join(tempDir, 'bootstrap.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    define: { 'process.env.NODE_ENV': '"production"' },
    minify: true,
  })
  await copyFile(join(root, 'lib/client.js'), join(tempDir, 'client.js'))

  const htmlPath = join(tempDir, 'index.html')
  await writeFile(
    htmlPath,
    `<!doctype html>
<html lang="zh">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Tavlo Hooks UI Smoke</title>
  <style>
    :root {
      --dsw-alias-bg-base: #f5f7fb;
      --dsw-alias-bg-layer-1: #ffffff;
      --dsw-alias-bg-layer-2: #f4f6fa;
      --dsw-alias-bg-layer-3: #e8edf5;
      --dsw-alias-label-primary: #152032;
      --dsw-alias-label-secondary: #526277;
      --dsw-alias-label-tertiary: #6d7d92;
      --dsw-alias-label-primary-foreground: #ffffff;
      --dsw-alias-border-l2: #e1e7ef;
      --dsw-alias-border-l3: #cbd5e1;
      --dsw-alias-brand-primary: #2563eb;
      --dsw-alias-state-business-tertiary: #ebf3ff;
      --dsw-alias-state-success-primary: #15803d;
      --dsw-alias-state-success-tertiary: #eafaf0;
      --dsw-alias-state-warn-primary: #b45309;
      --dsw-alias-state-warn-tertiary: #fff7e6;
      --dsw-alias-state-error-primary: #dc2626;
      --dsw-alias-interactive-bg-hover: rgba(15, 23, 42, 0.045);
      --dsw-radius-sm: 8px;
      --dsw-radius-md: 12px;
      --dsw-radius-lg: 16px;
    }
    body[data-ds-dark-theme] {
      --dsw-alias-bg-base: #14171d;
      --dsw-alias-bg-layer-1: #1e222b;
      --dsw-alias-bg-layer-2: #262b36;
      --dsw-alias-bg-layer-3: #171a21;
      --dsw-alias-label-primary: #eef2f8;
      --dsw-alias-label-secondary: #a8b4c7;
      --dsw-alias-label-tertiary: #8693a7;
      --dsw-alias-border-l2: #353c49;
      --dsw-alias-border-l3: #495264;
      --dsw-alias-brand-primary: #60a5fa;
      --dsw-alias-state-business-tertiary: #1f3352;
      --dsw-alias-state-success-primary: #4ade80;
      --dsw-alias-state-success-tertiary: #163324;
      --dsw-alias-state-warn-primary: #fbbf24;
      --dsw-alias-state-warn-tertiary: #3b2d15;
      --dsw-alias-state-error-primary: #f87171;
      --dsw-alias-interactive-bg-hover: rgba(255, 255, 255, 0.06);
      color-scheme: dark;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--dsw-alias-bg-base);
      color: var(--dsw-alias-label-primary);
      font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .smoke-shell {
      display: flex;
      min-height: 100vh;
      max-width: 1120px;
      margin: 0 auto;
    }
    .smoke-sidebar {
      width: 180px;
      flex: none;
      padding: 16px 12px;
      border-right: 1px solid var(--dsw-alias-border-l2);
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .smoke-nav-btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border: 0;
      border-radius: 8px;
      background: transparent;
      color: var(--dsw-alias-label-secondary);
      cursor: pointer;
      font: inherit;
      text-align: left;
    }
    .smoke-nav-btn.is-active {
      background: var(--dsw-alias-state-business-tertiary);
      color: var(--dsw-alias-brand-primary);
      font-weight: 600;
    }
    .smoke-main {
      flex: 1 1 auto;
      min-width: 0;
      padding: 18px 20px 64px;
    }
    @media (max-width: 640px) {
      .smoke-shell { flex-direction: column; }
      .smoke-sidebar {
        width: 100%;
        flex-direction: row;
        border-right: 0;
        border-bottom: 1px solid var(--dsw-alias-border-l2);
        padding: 10px 12px;
      }
      .smoke-main { padding: 14px 12px 64px; }
    }
  </style>
</head>
<body>
  <div id="root"></div>
  <script src="bootstrap.js"></script>
  <script src="client.js"></script>
</body>
</html>`,
    'utf8',
  )
  return pathToFileURL(htmlPath).href
}

const tempDir = await mkdtemp(join(tmpdir(), 'tavlo-hooks-smoke-'))
const screenshotDir = resolve(process.env.HOOKS_SCREENSHOT_DIR || DEFAULT_SCREENSHOT_DIR)
let browser

try {
  await mkdir(screenshotDir, { recursive: true })
  const pageUrl = await prepareSmokePage(tempDir)
  const playwrightPath = resolvePlaywrightPath()
  const { chromium } = await import(pathToFileURL(playwrightPath).href)
  browser = await chromium.launch({
    executablePath: resolveBrowserExecutable(),
    headless: true,
  })

  // 1. Desktop (1200x860) light + full functional workflow + dark mode + SSE toast
  {
    const context = await browser.newContext({
      viewport: { width: 1200, height: 860 },
      locale: 'zh-CN',
      reducedMotion: 'reduce',
    })
    await context.route(/^https?:/, (route) => route.abort())
    const page = await context.newPage()
    page.setDefaultTimeout(12000)

    const pageErrors = []
    const consoleErrors = []
    page.on('pageerror', (err) => {
      pageErrors.push(err.message)
      console.error('[pageerror]', err.message)
    })
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text())
        console.error('[console.error]', msg.text())
      }
    })

    await page.goto(pageUrl, { waitUntil: 'domcontentloaded' })

    // Verify all 4 slots registered and plugin ID matches
    const loadedInfo = await page.evaluate(() => ({
      id: window.smokeLoadedPluginId,
      slots: window.smokeSlots,
    }))
    assert.equal(loadedInfo.id, '@tavlo-dsh/dsh-plugin-hooks')
    assert.deepEqual(
      loadedInfo.slots.map((s) => s.name),
      ['settings.section', 'settings.section.icon', 'plugins.bundle.config', 'shell.overlay'],
    )

    // Open Hook settings tab
    await page.getByRole('tab', { name: 'Hook', exact: true }).click()
    await page.getByRole('heading', { name: 'Hook 与通知设置', exact: true }).waitFor()

    // Test Hook 通知 controls: toggles, taskbar segmented mode/count, focus suppress
    const inAppSwitch = page.getByRole('switch', { name: '启用应用内 Hook 通知弹框', exact: true })
    assert.equal(await inAppSwitch.getAttribute('aria-checked'), 'true')
    await inAppSwitch.click()
    assert.equal(await inAppSwitch.getAttribute('aria-checked'), 'false')
    await inAppSwitch.click()
    assert.equal(await inAppSwitch.getAttribute('aria-checked'), 'true')

    const untilFocusedRadio = page.getByRole('radio', { name: '持续到窗口聚焦', exact: true })
    await untilFocusedRadio.click()
    assert.equal(await untilFocusedRadio.getAttribute('aria-checked'), 'true')
    const finiteRadio = page.getByRole('radio', { name: '闪烁指定次数', exact: true })
    await finiteRadio.click()
    assert.equal(await finiteRadio.getAttribute('aria-checked'), 'true')

    const flashCountInput = page.locator('#tavlo-hooks-flash-count')
    assert.equal(await flashCountInput.inputValue(), '5')
    await page.locator('.tavlo-hooks-stepper button', { hasText: '+' }).click()
    assert.equal(await flashCountInput.inputValue(), '6')

    const focusSuppressSwitch = page.getByRole('switch', { name: '窗口聚焦时不发送系统通知', exact: true })
    assert.equal(await focusSuppressSwitch.getAttribute('aria-checked'), 'true')
    await focusSuppressSwitch.click()
    assert.equal(await focusSuppressSwitch.getAttribute('aria-checked'), 'false')
    await focusSuppressSwitch.click()
    assert.equal(await focusSuppressSwitch.getAttribute('aria-checked'), 'true')

    // Upload .wav, preview, and clear
    const wavInput = page.locator('input[type="file"][accept=".wav,audio/wav"]')
    await wavInput.setInputFiles({
      name: 'alert.wav',
      mimeType: 'audio/wav',
      buffer: createValidWavBytes(),
    })
    await page.locator('.tavlo-hooks-sound-meta code', { hasText: 'alert.wav' }).waitFor()
    await page.getByRole('button', { name: '试听', exact: true }).click()
    await page.waitForFunction(() => window.smokeMetrics.audioPlays.length === 1)
    assert.equal(await page.evaluate(() => window.smokeMetrics.soundFetches), 1)
    await page.getByRole('button', { name: '清除', exact: true }).click()
    await page.getByText('未设置自定义声音，将使用系统默认声音。', { exact: true }).waitFor()

    // Add & test third-party target with masked secret & preserve-on-blank
    await page.getByRole('combobox', { name: '通知平台', exact: true }).selectOption('bark')
    await page.getByRole('button', { name: '新增通知目标', exact: true }).click()
    const newCard = page.locator('.tavlo-hooks-target-card').first()
    await newCard.getByPlaceholder('例如：我的手机 Bark / 研发群飞书').fill('我的测试 Bark')
    const secretInputs = newCard.locator('input[type="password"]')
    await secretInputs.first().fill('bark_secret_key_9988')
    await newCard.getByRole('button', { name: '保存', exact: true }).click()
    await newCard.locator('.tavlo-hooks-target-name', { hasText: '我的测试 Bark' }).waitFor()

    // Expand saved target and verify secret is masked + preserved on blank re-save
    await newCard.getByRole('button', { name: '展开配置', exact: true }).click()
    await newCard.locator('.tavlo-hooks-secret-preview', { hasText: '••••9988' }).waitFor()
    assert.equal(await newCard.getByPlaceholder('已配置（留空保留原值）').first().inputValue(), '')
    await newCard.getByPlaceholder('例如：我的手机 Bark / 研发群飞书').fill('我的测试 Bark v2')
    await newCard.getByRole('button', { name: '保存', exact: true }).click()
    await newCard.locator('.tavlo-hooks-target-name', { hasText: '我的测试 Bark v2' }).waitFor()
    await newCard.getByRole('button', { name: '测试', exact: true }).click()
    await newCard.getByText(/发送成功/).waitFor()

    // Mount point card: bell button toggles independently without expanding/collapsing drawer
    const approvalCard = page.locator('.tavlo-hooks-mount-card', { hasText: '待审批权限请求' })
    const bellBtn = approvalCard.locator('.tavlo-hooks-bell-btn')
    assert.equal(await approvalCard.getAttribute('data-selected'), 'false')
    assert.equal(await bellBtn.getAttribute('aria-pressed'), 'true')
    await bellBtn.click()
    assert.equal(await bellBtn.getAttribute('aria-pressed'), 'false')
    assert.equal(await approvalCard.getAttribute('data-selected'), 'false')
    assert.equal(await page.locator('.tavlo-hooks-drawer').count(), 0)
    await bellBtn.click()
    assert.equal(await bellBtn.getAttribute('aria-pressed'), 'true')

    // Open script drawer, upload custom script, open source modal
    await approvalCard.getByRole('button', { name: '管理脚本', exact: true }).click()
    await page.locator('.tavlo-hooks-drawer').waitFor()
    assert.equal(await approvalCard.getAttribute('data-selected'), 'true')

    const [scriptChooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.locator('.tavlo-hooks-drawer').getByRole('button', { name: '上传脚本', exact: true }).click(),
    ])
    await scriptChooser.setFiles({
      name: 'smoke-custom.mjs',
      mimeType: 'text/javascript',
      buffer: Buffer.from('process.stdout.write(JSON.stringify({ notify: true, summary: "Smoke OK" }) + "\\n");\n', 'utf8'),
    })
    await page.locator('.tavlo-hooks-script-name', { hasText: 'smoke-custom.mjs' }).waitFor()

    const customRow = page.locator('.tavlo-hooks-script-row', { hasText: 'smoke-custom.mjs' })
    await customRow.getByRole('button', { name: '查看源码', exact: true }).click()
    const sourceModal = page.getByRole('dialog', { name: '脚本源码', exact: true })
    await sourceModal.waitFor()
    await sourceModal.getByText(/Smoke OK/).waitFor()
    await sourceModal.getByRole('button', { name: '关闭', exact: true }).click()
    await sourceModal.waitFor({ state: 'detached' })

    // Verify no horizontal overflow on desktop light mode and capture screenshot 1
    const lightDesktopOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    )
    assert.equal(lightDesktopOverflow, false, 'Unexpected horizontal overflow on light desktop')
    await page.screenshot({ path: join(screenshotDir, 'hooks-light-desktop.png'), fullPage: false })

    // Switch to dark mode (`body[data-ds-dark-theme]`) and push SSE notifications to shell.overlay
    await page.evaluate(() => {
      document.body.setAttribute('data-ds-dark-theme', 'true')
      window.smokePushSse('notification', {
        id: 'toast-smoke-1',
        event: 'PermissionRequest',
        eventLabel: '待审批',
        icon: '🛡️',
        title: 'DSH 🛡️ 待审批',
        summary: 'Bash: 运行构建脚本',
        project: 'demo-repo',
        hookPoint: 'approval.request',
        approvalId: 'appr-smoke-1',
        sessionId: 'sess-smoke-1',
        variant: 'approval',
        autoCloseEnabled: false,
      })
    })

    const toastRegion = page.getByRole('region', { name: 'DSH 内部通知', exact: true })
    await toastRegion.waitFor()
    await toastRegion.getByText('Bash: 运行构建脚本', { exact: true }).waitFor()
    await page.waitForFunction(() => {
      const card = document.querySelector('.tavlo-hooks-mount-card[data-selected="false"]')
      return card && getComputedStyle(card).backgroundColor === 'rgb(38, 43, 54)'
    })

    // Capture screenshot 2: dark desktop settings + live toast overlay
    await page.screenshot({ path: join(screenshotDir, 'hooks-dark-desktop-toast.png'), fullPage: false })

    // Manual dismiss button removes toast-smoke-1
    await toastRegion.getByRole('button', { name: '关闭', exact: true }).click()
    await toastRegion.waitFor({ state: 'detached' })

    // Push toast-smoke-2 and verify SSE dismiss clears it, plus toast-smoke-3 with 5s autoClose
    await page.evaluate(() => {
      window.smokePushSse('notification', {
        id: 'toast-smoke-2',
        event: 'PermissionRequest',
        eventLabel: '待审批',
        icon: '🛡️',
        title: 'DSH 🛡️ 待审批',
        summary: 'Write: 更新配置',
        approvalId: 'appr-smoke-2',
        variant: 'approval',
        autoCloseEnabled: false,
      })
    })
    await toastRegion.getByText('Write: 更新配置', { exact: true }).waitFor()
    await page.evaluate(() => {
      window.smokePushSse('dismiss', { approvalId: 'appr-smoke-2' })
    })
    await toastRegion.waitFor({ state: 'detached' })

    await page.evaluate(() => {
      window.smokePushSse('notification', {
        id: 'toast-smoke-3',
        event: 'Stop',
        eventLabel: '任务完成',
        icon: '✅',
        title: 'DSH ✅ 任务完成',
        summary: '自动关闭倒计时验证',
        variant: 'success',
        autoCloseEnabled: true,
        autoCloseSeconds: 5,
      })
    })
    await toastRegion.getByText('自动关闭倒计时验证', { exact: true }).waitFor()
    await toastRegion.waitFor({ state: 'detached', timeout: 7000 })

    // Ensure client-state focus events were posted
    assert.equal((await page.evaluate(() => window.smokeMetrics.clientStates.length)) >= 1, true)
    assert.deepEqual(pageErrors, [])
    assert.deepEqual(consoleErrors, [])
    await context.close()
  }

  // 2. Mobile (390x844) dark/light responsive layout check
  {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: 'zh-CN',
      reducedMotion: 'reduce',
    })
    await context.route(/^https?:/, (route) => route.abort())
    const page = await context.newPage()
    page.setDefaultTimeout(12000)

    const pageErrors = []
    const consoleErrors = []
    page.on('pageerror', (err) => {
      pageErrors.push(err.message)
      console.error('[pageerror]', err.message)
    })
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text())
        console.error('[console.error]', msg.text())
      }
    })

    await page.goto(pageUrl, { waitUntil: 'domcontentloaded' })
    await page.getByRole('tab', { name: 'Hook', exact: true }).click()
    await page.getByRole('heading', { name: 'Hook 与通知设置', exact: true }).waitFor()

    const mobileOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    )
    assert.equal(mobileOverflow, false, 'Unexpected horizontal overflow on 390x844 mobile viewport')
    await page.screenshot({ path: join(screenshotDir, 'hooks-mobile-light.png'), fullPage: false })

    assert.deepEqual(pageErrors, [])
    assert.deepEqual(consoleErrors, [])
    await context.close()
  }
} finally {
  if (browser) await browser.close()
  await rm(tempDir, { recursive: true, force: true })
}

console.log(`UI smoke verification passed (0 console errors, 0 page errors). Screenshots saved in ${screenshotDir}`)
