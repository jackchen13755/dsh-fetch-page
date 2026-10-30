/**
 * 平台适配：定位 Chrome 的用户数据目录，并从 `DevToolsActivePort` 解出 CDP 端点。
 *
 * 背景：主 Chrome 走 `chrome://inspect` 的「远程调试」开关时，`/json/version` 返回 404，
 * 唯一可靠来源就是用户数据目录下的 `DevToolsActivePort`（第 1 行端口、第 2 行
 * `/devtools/browser/<uuid>`）。各平台目录不同，这里做统一解析，避免把 macOS 路径写死。
 *
 * @module @deepseek-ai/dsh-tool-browser/hub/platform
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

export interface ResolvedEndpoint {
  /** WebSocket 地址，形如 ws://127.0.0.1:9222/devtools/browser/<uuid>。 */
  wsUrl: string
  /** 解析来源，便于排障：env / config / DevToolsActivePort / probe。 */
  source: string
  /** 命中的用户数据目录（env/config 直连时为空）。 */
  profileDir?: string
}

/** 各平台 Chrome 用户数据目录候选（按优先级）。 */
export function chromeProfileCandidates(): string[] {
  const home = homedir()
  const os = platform()
  if (os === 'darwin') {
    return [join(home, 'Library', 'Application Support', 'Google', 'Chrome')]
  }
  if (os === 'win32') {
    const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    return [join(local, 'Google', 'Chrome', 'User Data')]
  }
  return [
    join(home, '.config', 'google-chrome'),
    join(home, '.config', 'chromium'),
    join(home, 'snap', 'chromium', 'common', 'chromium'),
  ]
}

/** 读 DevToolsActivePort；文件缺失或内容不完整时返回 undefined。 */
export function readDevToolsActivePort(profileDir: string): { port: number; path: string } | undefined {
  const file = join(profileDir, 'DevToolsActivePort')
  if (!existsSync(file)) return undefined
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  const lines = raw
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  const port = Number(lines[0])
  const wsPath = lines[1]
  if (!Number.isFinite(port) || port <= 0 || !wsPath || !wsPath.startsWith('/')) return undefined
  return { port, path: wsPath }
}

/**
 * 解析 CDP 端点。优先级：
 * 1. 显式 ws 地址（config.cdpWsUrl / 环境变量 DSH_CHROME_WS）
 * 2. 指定或默认的 profile 目录里的 DevToolsActivePort
 * 3. 常见端口探测（仅当 DevToolsActivePort 缺失时）
 */
export function resolveEndpoint(opts: { profileDir?: string; cdpWsUrl?: string } = {}): ResolvedEndpoint {
  const explicit = opts.cdpWsUrl ?? process.env.DSH_CHROME_WS
  if (explicit) return { wsUrl: explicit, source: 'explicit' }

  const configured = opts.profileDir ?? process.env.CDP_PROFILE_DIR
  const dirs = configured ? [configured] : chromeProfileCandidates()
  for (const dir of dirs) {
    const parsed = readDevToolsActivePort(dir)
    if (parsed) {
      return {
        wsUrl: `ws://127.0.0.1:${parsed.port}${parsed.path}`,
        source: configured ? 'config' : 'DevToolsActivePort',
        profileDir: dir,
      }
    }
  }

  throw new Error(
    '没有找到 Chrome 的远程调试端点。' +
      '请在 Chrome 打开 chrome://inspect/#remote-debugging 并开启远程调试（或给插件配置 profileDir / 设置环境变量 DSH_CHROME_WS）。' +
      `已查找的目录：${dirs.join(', ')}`,
  )
}
