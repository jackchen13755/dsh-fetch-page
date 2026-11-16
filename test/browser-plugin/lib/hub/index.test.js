/**
 * lib/hub/index.js 的 /health 判定回归（S8）：
 * - 只有**别的进程**的 hub 才允许当外部 hub 复用；
 * - 同 pid 的 /health（本进程自己的侧车）不能被误认成外部 hub，否则上游死了也不会重建。
 *
 * 全部用本地 fake hub（http server）+ 一个确定关闭的端口，不碰真实 Chrome。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { ChromeHub } from '../../../../browser-plugin/lib/hub/index.js'

async function startFakeHub(health) {
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      const buf = Buffer.from(JSON.stringify(health), 'utf8')
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': buf.length })
      res.end(buf)
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"no route"}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** 拿一个「现在肯定没有监听」的端口（先 bind 再关）。 */
async function closedPort() {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

function hubHealth(overrides = {}) {
  return {
    ok: true,
    hub: true,
    pid: process.pid + 4242,
    ready: true,
    paused: false,
    pausedReason: null,
    attempts: 0,
    nextRetryMs: null,
    lastError: null,
    connects: 3,
    disconnects: 1,
    requests: 7,
    errors: 0,
    lastConnectedAt: '2026-01-01T00:00:00.000Z',
    upstream: 'ws://127.0.0.1:9222/devtools/browser/other',
    source: 'DevToolsActivePort',
    profileDir: '/tmp/other-profile',
    uptimeSec: 42,
    ...overrides,
  }
}

test('S8 别的进程的 /health → 复用为外部 hub（不发第二条 WS）', async (t) => {
  const fake = await startFakeHub(hubHealth())
  t.after(() => fake.close())
  const hub = new ChromeHub({ port: fake.port })
  t.after(() => hub.stop())

  const status = await hub.ensure()
  assert.equal(status.external, true)
  assert.equal(status.ready, true)
  assert.equal(status.connects, 3)
  assert.equal(status.upstream, 'ws://127.0.0.1:9222/devtools/browser/other')
  assert.equal(status.baseUrl, `http://127.0.0.1:${fake.port}`)

  const again = await hub.status()
  assert.equal(again.external, true)
  assert.equal(again.ready, true)
  assert.equal(again.paused, false)
  assert.equal(again.attempts, 0)
  assert.equal(again.nextRetryMs, null)
})

test('S8 外部 hub paused 时 status 透传真实状态（不假装 ready）', async (t) => {
  const fake = await startFakeHub(
    hubHealth({ ok: false, ready: false, paused: true, pausedReason: 'failures', attempts: 5 }),
  )
  t.after(() => fake.close())
  const hub = new ChromeHub({ port: fake.port })
  t.after(() => hub.stop())

  const status = await hub.ensure()
  assert.equal(status.external, true)
  assert.equal(status.ready, false)
  assert.equal(status.paused, true)
  assert.equal(status.pausedReason, 'failures')
  assert.equal(status.attempts, 5)
})

test('S8 同 pid 的 /health（本进程自己的侧车）不得被当成外部 hub', async (t) => {
  const fake = await startFakeHub(hubHealth({ pid: process.pid }))
  t.after(() => fake.close())
  const dead = await closedPort()
  // 明确给一个死端点：确保这次失败不会碰到真实 Chrome
  const hub = new ChromeHub({ port: fake.port, cdpWsUrl: `ws://127.0.0.1:${dead}/devtools/browser/mock` })
  t.after(() => hub.stop())

  await assert.rejects(hub.ensure(), /未在监听|没有找到 Chrome 的远程调试端点/)
  const status = await hub.status()
  assert.equal(status.external, false, '同 pid 不能被当成外部 hub（否则上游死掉也不会重建）')
})

test('S8 没有任何上游时 status() 形状稳定（新增字段有默认值）', async (t) => {
  const hub = new ChromeHub({ port: 0 })
  t.after(() => hub.stop())
  const status = await hub.status()
  assert.equal(status.ready, false)
  assert.equal(status.external, false)
  assert.equal(status.paused, false)
  assert.equal(status.pausedReason, null)
  assert.equal(status.attempts, 0)
  assert.equal(status.nextRetryMs, null)
  assert.equal(status.connects, 0)
})
