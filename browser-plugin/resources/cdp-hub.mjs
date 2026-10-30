#!/usr/bin/env node
/**
 * 独立 CLI：在没有装 DSH 插件、只能用 bash 的机器上，也能起同一个 CDP 中枢。
 *
 * 与插件里的 chrome_* 工具共用同一份实现（`../lib/hub`，纯 Node 内置依赖），
 * 因此 HTTP 契约完全一致：/health /cookies /targets /cdp /attach /events。
 *
 * 用法：
 *   node cdp-hub.mjs                       # 连本机 Chrome（默认端口 9334）
 *   node cdp-hub.mjs --port 9335           # 换端口
 *   node cdp-hub.mjs --profile <Chrome 用户数据目录>
 *   node cdp-hub.mjs --ws ws://127.0.0.1:9222/devtools/browser/<uuid>
 *   node cdp-hub.mjs --check               # 只打印状态后退出
 */
import { ChromeHub } from '../lib/hub/index.js'

function parseArgs(argv) {
  const args = { port: undefined, profileDir: undefined, cdpWsUrl: undefined, check: false }
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i]
    if (key === '--check') {
      args.check = true
      continue
    }
    const value = argv[i + 1]
    if (key === '--port') {
      args.port = Number(value)
      i += 1
    } else if (key === '--profile') {
      args.profileDir = value
      i += 1
    } else if (key === '--ws') {
      args.cdpWsUrl = value
      i += 1
    } else if (key === '--help' || key === '-h') {
      console.log('用法: node cdp-hub.mjs [--port N] [--profile <dir>] [--ws <url>] [--check]')
      process.exit(0)
    }
  }
  return args
}

const args = parseArgs(process.argv)
const hub = new ChromeHub({
  ...(args.port !== undefined && Number.isFinite(args.port) ? { port: args.port } : {}),
  ...(args.profileDir !== undefined ? { profileDir: args.profileDir } : {}),
  ...(args.cdpWsUrl !== undefined ? { cdpWsUrl: args.cdpWsUrl } : {}),
})

if (args.check) {
  const status = await hub.status()
  console.log(JSON.stringify(status, null, 2))
  await hub.stop()
  process.exit(0)
}

console.error('[cdp-hub] 启动中…（首次连接时 Chrome 会弹「要允许远程调试吗」，点允许）')
try {
  const status = await hub.ensure()
  console.log(JSON.stringify(status, null, 2))
  if (!status.ready) {
    console.error('[cdp-hub] 尚未就绪，检查 Chrome 是否已点允许 / chrome://inspect 是否开启')
  } else {
    console.error(`[cdp-hub] 就绪：${status.baseUrl}（connects=${status.connects}）`)
  }
} catch (error) {
  console.error('[cdp-hub] 启动失败：' + (error instanceof Error ? error.message : String(error)))
  await hub.stop()
  process.exit(1)
}

const shutdown = () => {
  void hub.stop().finally(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
setInterval(() => undefined, 1 << 30)
