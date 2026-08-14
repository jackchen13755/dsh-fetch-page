# DSH 控制与网页转发（dsh-fetch-page）

一套让 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 具备「浏览器登录态抓取」能力的工具链，由三个部分组成：

- **Chrome 扩展**（`extension/`）：控制 DSH web 服务的启动/重启/停止，并作为「带 Cookie 的 HTTP 转发」的浏览器端执行者。
- **原生消息宿主 + 转发守护进程**（`native-host/`）：扩展与 DSH 之间的桥。原生宿主负责进程生命周期；守护进程是常驻的本地 HTTP 中转，使转发不依赖 DSH 存活。
- **DSH 常驻插件**（`dsh-plugin/`）：为 Agent 提供 `fetch_page` 工具，把 HTTP 请求交给守护进程、经浏览器用当前登录 Cookie 抓取页面并绕过 CORS。

## 架构

```
DSH fetch_page 工具 ──curl POST──▶ 守护进程 127.0.0.1:9317 ──长轮询──▶ 扩展 background ──fetch(带 Cookie)──▶ 目标站点
                                        ▲                                    │
                                        └────────────── POST /result ────────┘
```

- 守护进程独立于 DSH 常驻运行，DSH 重启后转发链路不丢。
- 扩展后台持续长轮询守护进程；`fetch_page` 工具与原生宿主都会在需要时自动拉起守护进程。

## 安装

### 1. 加载 Chrome 扩展

1. 打开 `chrome://extensions`，开启右上角「开发者模式」。
2. 点「加载已解压的扩展程序」，选择本仓库的 `extension/` 目录。
3. 记住扩展 ID（或保持 `manifest.json` 里的 `key` 不变，扩展 ID 固定为 `gmhbeifoddcbdnajnhhghdfojmhlojgb`）。

### 2. 注册原生消息宿主

编辑 `native-host/com.dsh.control.json`，把 `path` 改成你机器上的 `dsh-control-host` 绝对路径：

```json
{
  "name": "com.dsh.control",
  "path": "/你的/绝对路径/native-host/dsh-control-host",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://gmhbeifoddcbdnajnhhghdfojmhlojgb/"]
}
```

然后复制到 Chrome 的原生消息宿主目录：

```bash
mkdir -p "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
cp native-host/com.dsh.control.json "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/"
```

给脚本加执行权限：

```bash
chmod +x native-host/dsh-control-host native-host/dsh-relay-daemon
```

> 原生宿主的守护进程路径按脚本所在目录自动定位（`dsh-relay-daemon` 就在
> 同一目录），无需修改；DSH checkout 目录默认取 `~/deepseek-harness`，若你的
> checkout 在别处，给宿主进程设置环境变量 `DSH_CHECKOUT` 指向它即可。

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
    daemonPath: /你的/绝对路径/native-host/dsh-relay-daemon
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
- 三个组件里，只有 DSH 插件包的 `fetch_page` 工具是会话级挂载；守护进程、原生宿主、扩展都是常驻的。
