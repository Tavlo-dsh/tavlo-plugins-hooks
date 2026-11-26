# Tavlo Hook 与通知插件（`@tavlo-dsh/dsh-plugin-hooks`）

DeepSeek Harness（DSH）`0.2.2-rc.1` 插件：监听 DSH 审批、用户提问、回合生命周期、工具执行、子 Agent、后台任务、工作流、上下文压缩、目标与账号提醒等 **19 个原生 Hook 挂载点**，提供应用内弹窗、跨平台系统通知、Windows 任务栏闪烁、自定义 `.wav` 铃声、本地 Hook 脚本管理与 **11 种三方通知渠道**。

## 安装与构建

需要 Node.js >= 24、DSH `0.2.2-rc.1` 与 npm/pnpm。

```bash
npm install
npm run build
npm test
```

本地打包与安装到当前 DSH profile：

```bash
npm pack
dsh plugin --profile web add --prod ./tavlo-dsh-dsh-plugin-hooks-0.1.3.tgz
```

## 核心能力

- **DSH 设置页一级入口**：在「设置 → Hook」集中管理通知策略、自定义声音、三方通知目标与 19 个 Hook 挂载点。
- **四通道通知调度**：
  1. **DSH 应用内弹窗**：通过 SSE 实时推送，支持自动关闭时间配置与审批消散联动。
  2. **OS 原生系统通知**：Windows WinRT / WSL、macOS `osascript`、Linux `notify-send`，支持窗口聚焦抑制与每挂载点独立铃铛开关。
  3. **Windows 任务栏闪烁**：独立于系统通知开关，支持指定闪烁次数（1–20）或持续到窗口聚焦。
  4. **11 种三方异步通知渠道**：Bark、钉钉、飞书、Telegram、企业微信、PushPlus、WxPusher、Server 酱、ntfy、Gotify、自定义 HTTP，凭证存放在 DSH 本地凭证库（`~/.dsh/.credentials.yaml`），外发仅包含脱敏摘要与项目目录 basename。
- **跨平台 Hook 脚本**：预置 8 个默认 `.mjs` 脚本（含工具审计示例），支持上传 `.mjs`/`.js`/`.cjs`/`.ps1`/`.sh`/`.py`/`.cmd`/`.bat` 脚本、工具正则 matcher、超时限制、源码查看、单脚本测试运行与最近 50 条执行日志。
