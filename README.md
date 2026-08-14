# DSH 控制与网页转发（dsh-fetch-page）

一套让 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 具备「浏览器登录态抓取」能力的工具链，由三部分组成：

- **Chrome 扩展**（`extension/`）：控制 DSH web 服务的启动/重启/停止，并作为「带 Cookie 的 HTTP 转发」的浏览器端执行者。
- **转发守护进程**（`daemon/`）：常驻本地 HTTP 服务，既是转发中转，也负责 DSH 进程的生命周期控制（status / start / stop / restart）。
- **DSH 常驻插件**（`dsh-plugin/`）：为 Agent 提供 `fetch_page` 工具，把 HTTP 请求交给守护进程、经浏览器用当前登录 Cookie 抓取页面并绕过 CORS。

不再使用 Chrome 原生消息宿主（native messaging host）：控制与转发统一走守护进程的 HTTP 接口。

## 架构

```
                    ┌─────────────── 控制(status/start/stop/restart) ───────────────┐
                    ▼                                                               │
DSH fetch_page 工具 ──POST /forward──▶ 守护进程 127.0.0.1:9317 ──长轮询 /pending──▶ 扩展 background ──fetch(带 Cookie)──▶ 目标站点
                                          ▲                                             │
                                          └────────────────── POST /result ──────────────┘
```

- 守护进程独立于 DSH 常驻运行（launchd 保活），DSH 重启后转发链路不丢。
- 扩展后台持续长轮询守护进程；扩展 popup 通过 `fetch` 调守护进程的控制端点。

## 安装

### 1. 加载 Chrome 扩展

1. 打开 `chrome://extensions`，开启右上角「开发者模式」。
2. 点「加载已解压的扩展程序」，选择本仓库的 `extension/` 目录。
3. 记住扩展 ID（或保持 `manifest.json` 里的 `key` 不变，扩展 ID 固定为 `gmhbeifoddcbdnajnhhghdfojmhlojgb`）。

### 2. 启动守护进程（launchd 常驻）

编辑 `daemon/com.dsh.relay.plist`，把程序参数里的守护进程路径改成你机器上的绝对路径：

```xml
<string>/绝对/路径/daemon/dsh-relay-daemon</string>
```

然后安装并加载（macOS）：

```bash
chmod +x daemon/dsh-relay-daemon
cp daemon/com.dsh.relay.plist "$HOME/Library/LaunchAgents/com.dsh.relay.plist"
launchctl unload "$HOME/Library/LaunchAgents/com.dsh.relay.plist" 2>/dev/null || true
launchctl load -w "$HOME/Library/LaunchAgents/com.dsh.relay.plist"
```

验证：

```bash
curl http://127.0.0.1:9317/status
# => {"ok":true,"running":false,"pid":null}   （DSH 未启动时）
```

守护进程相关环境变量（可选，设置给 launchd 或手动启动时）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DSH_CHECKOUT` | `~/deepseek-harness` | DSH checkout 目录 |
| `DSH_PORT` | `3080` | DSH web 端口 |
| `DSH_DAEMON_PORT` | `9317` | 守护进程监听端口 |
| `DSH_START_CMD` | `node apps/cli/lib/bin.js web --port 3080` | DSH 启动命令（整条覆盖） |

> 开发模式用户可把 `DSH_START_CMD` 设为
> `node --import tsx/esm apps/cli/src/bin.ts web --port 3080`。

### 3. 安装 DSH 常驻插件

`dsh-plugin/` 是一个标准的 DSH workspace 插件包（`@deepseek-ai/dsh-tool-fetch-page`）。

1. 把 `dsh-plugin/` 放进 DSH checkout 的 `packages/web/tool-fetch-page/`（或作为依赖接入）。
2. 重新安装链接并构建：

```bash
cd /path/to/deepseek-harness
pnpm install
./node_modules/.bin/tsc -b packages/web/tool-fetch-page/tsconfig.json
```

3. 接入组合：把该包加进一个 Agent preset 的工具行（例如复制 `standard` 为 `standard-fetch`，追加）：

```yaml
- id: tool-fetch-page
  name: '@deepseek-ai/dsh-tool-fetch-page'
  config:
    daemonUrl: http://127.0.0.1:9317
    daemonPath: /你的/绝对路径/daemon/dsh-relay-daemon
    workspaceRoot: /你的/工作目录
```

4. 把该 preset 设为默认（`~/.dsh/profiles/web/cordis.patch.yml`）：

```yaml
- id: agent-presets
  config:
    default: standard-fetch
```

5. 重启 DSH。

## 使用方式

### 控制 DSH 服务

点击浏览器工具栏的「DSH 控制」图标：

- **未启动**：自动启动 DSH 服务并打开 `http://127.0.0.1:3080`。
- **已启动**：展开「重启 / 停止」按钮。

控制请求由 popup 直接 `fetch` 守护进程的 `/status`、`/start`、`/stop`、`/restart` 端点完成。

### 抓取登录态页面

在 DSH 会话里直接调用 `fetch_page` 工具：

```
fetch_page url=https://example.com/private/page
```

可选参数：

- `method`：HTTP 方法（GET/POST/PUT/DELETE/PATCH，默认 GET）
- `headers`：额外请求头（扩展自动附带浏览器 Cookie）
- `body`：请求体（字符串）

返回：HTTP 状态码、响应头、正文（HTML 自动提取为纯文本）。

## 说明

- 扩展后台通过 `chrome.alarms` 兜底恢复轮询；守护进程长轮询 25s，转发请求超时 30s。
- 扩展必须登录目标站点，转发才会带上对应 Cookie。
- 控制与转发都走守护进程 9317；扩展 `background.js` 只做转发，`popup.js` 只做控制。
- 三个组件里，只有 DSH 插件包的 `fetch_page` 工具是会话级挂载；守护进程（launchd）、扩展都是常驻的。
