/**
 * lib/hub/server.js 的 HTTP 契约回归：/health 真实状态（S8）+ 其它路由形状不变。
 *
 * 用 fake upstream（不走真实 Chrome、不联网），只验路径、方法转发与返回结构。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHubServer } from '../../../../browser-plugin/lib/hub/server.js'

function makeFakeUpstream(overrides = {}) {
  const calls = []
  const demands = []
  const base = {
    endpoint: {
      wsUrl: 'ws://127.0.0.1:9222/devtools/browser/mock',
      source: 'DevToolsActivePort',
      profileDir: '/tmp/chrome-profile',
    },
    stats: {
      connects: 1,
      disconnects: 0,
      requests: 2,
      keepalives: 3,
      errors: 0,
      lastError: null,
      lastConnectedAt: '2026-01-01T00:00:00.000Z',
    },
    isReady: true,
    health: {
      ready: true,
      paused: false,
      pausedReason: null,
      attempts: 0,
      lastError: null,
      nextRetryMs: null,
      lastAttemptAt: '2026-01-01T00:00:00.000Z',
      idleForMs: 12,
      endpointChanged: false,
    },
    noteDemand: () => demands.push(Date.now()),
    onEvent: () => () => {},
    async send(method, params, sessionId) {
      calls.push(sessionId === undefined ? { method, params } : { method, params, sessionId })
      if (method === 'Storage.getCookies') {
        return {
          cookies: [
            { name: 'sid', value: 'v1', domain: '.example.com', path: '/' },
            { name: 'tmp', value: 'v2', domain: '.other.com', path: '/' },
          ],
        }
      }
      if (method === 'Target.getTargets') {
        return {
          targetInfos: [
            { targetId: 't-page', type: 'page', title: 'Example', url: 'https://example.com/' },
            { targetId: 't-worker', type: 'service_worker', title: 'sw', url: 'https://example.com/sw' },
          ],
        }
      }
      if (method === 'Browser.getVersion') {
        return { product: 'Chrome/141', protocolVersion: '1.3' }
      }
      if (method === 'Target.attachToTarget') return { sessionId: 'session-1' }
      return { echoed: method }
    },
  }
  return { upstream: { ...base, ...overrides }, calls, demands }
}

async function withServer(fake, fn) {
  const server = createHubServer(fake, () => ({ startedAt: Date.now() - 5000 }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  try {
    await fn(baseUrl)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('S8 /health：ok 就是上游真实就绪状态，并带 pid/paused/attempts/nextRetryMs', async () => {
  const { upstream } = makeFakeUpstream()
  await withServer(upstream, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/health`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.hub, true)
    assert.equal(body.pid, process.pid)
    assert.equal(body.ready, true)
    assert.equal(body.paused, false)
    assert.equal(body.pausedReason, null)
    assert.equal(body.attempts, 0)
    assert.equal(body.nextRetryMs, null)
    // 旧字段保持：形状不变，只是 ok 变真了
    assert.equal(body.connects, 1)
    assert.equal(body.disconnects, 0)
    assert.equal(body.requests, 2)
    assert.equal(body.errors, 0)
    assert.equal(body.upstream, 'ws://127.0.0.1:9222/devtools/browser/mock')
    assert.equal(body.source, 'DevToolsActivePort')
    assert.equal(body.profileDir, '/tmp/chrome-profile')
    assert.equal(typeof body.uptimeSec, 'number')
  })
})

test('S8 /health：上游 paused 时 ok=false，错误与重试排期透传', async () => {
  const { upstream } = makeFakeUpstream({
    isReady: false,
    health: {
      ready: false,
      paused: true,
      pausedReason: 'failures',
      attempts: 5,
      lastError: 'Chrome 调试端口 9222 未在监听',
      nextRetryMs: null,
      lastAttemptAt: '2026-01-01T00:00:00.000Z',
      idleForMs: 42,
    },
  })
  await withServer(upstream, async (baseUrl) => {
    const body = await (await fetch(`${baseUrl}/health`)).json()
    assert.equal(body.ok, false)
    assert.equal(body.ready, false)
    assert.equal(body.paused, true)
    assert.equal(body.pausedReason, 'failures')
    assert.equal(body.attempts, 5)
    assert.equal(body.nextRetryMs, null)
    assert.equal(body.lastError, 'Chrome 调试端口 9222 未在监听')
  })
})

test('S8 /health：退避排期中带 nextRetryMs（脚本可判断多久后重试）', async () => {
  const { upstream } = makeFakeUpstream({
    isReady: false,
    health: {
      ready: false,
      paused: false,
      pausedReason: null,
      attempts: 2,
      lastError: 'WebSocket 握手失败',
      nextRetryMs: 1234,
      lastAttemptAt: '2026-01-01T00:00:00.000Z',
      idleForMs: 42,
    },
  })
  await withServer(upstream, async (baseUrl) => {
    const body = await (await fetch(`${baseUrl}/health`)).json()
    assert.equal(body.ok, false)
    assert.equal(body.paused, false)
    assert.equal(body.nextRetryMs, 1234)
    assert.equal(body.lastError, 'WebSocket 握手失败')
  })
})

test('回归 /cookies：路径、domains 过滤与返回结构不变', async () => {
  const { upstream, calls } = makeFakeUpstream()
  await withServer(upstream, async (baseUrl) => {
    const body = await (await fetch(`${baseUrl}/cookies?domains=example.com`)).json()
    assert.equal(calls[0].method, 'Storage.getCookies')
    assert.deepEqual(Object.keys(body).sort(), ['byDomain', 'cookies', 'domains', 'total'])
    assert.equal(body.total, 1)
    assert.equal(body.domains, 1)
    assert.deepEqual(body.byDomain, { '.example.com': 1 })
    assert.equal(body.cookies[0].name, 'sid')
  })
})

test('回归 /targets：直接透传 Target.getTargets 的结果', async () => {
  const { upstream, calls } = makeFakeUpstream()
  await withServer(upstream, async (baseUrl) => {
    const body = await (await fetch(`${baseUrl}/targets`)).json()
    assert.equal(calls[0].method, 'Target.getTargets')
    assert.equal(body.targetInfos.length, 2)
    assert.equal(body.targetInfos[0].targetId, 't-page')
  })
})

test('回归 /json/version：兼容字段不变', async () => {
  const { upstream } = makeFakeUpstream()
  await withServer(upstream, async (baseUrl) => {
    const body = await (await fetch(`${baseUrl}/json/version`)).json()
    assert.deepEqual(Object.keys(body).sort(), ['Browser', 'Protocol-Version', 'webSocketDebuggerUrl'])
    assert.equal(body.Browser, 'Chrome/141')
    assert.equal(body['Protocol-Version'], '1.3')
    assert.equal(body.webSocketDebuggerUrl, 'ws://127.0.0.1:9222/devtools/browser/mock')
  })
})

test('回归 /json/list：只保留 page 且字段不变', async () => {
  const { upstream } = makeFakeUpstream()
  await withServer(upstream, async (baseUrl) => {
    const body = await (await fetch(`${baseUrl}/json/list`)).json()
    assert.ok(Array.isArray(body))
    assert.equal(body.length, 1)
    assert.deepEqual(Object.keys(body[0]).sort(), ['id', 'title', 'type', 'url'])
    assert.equal(body[0].id, 't-page')
  })
})

test('回归 /cdp：方法/参数/sessionId 透传，返回 { result }', async () => {
  const { upstream, calls } = makeFakeUpstream()
  await withServer(upstream, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/cdp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'Runtime.evaluate', params: { expression: '1' }, sessionId: 'session-1' }),
    })
    const body = await res.json()
    assert.equal(res.status, 200)
    assert.deepEqual(Object.keys(body), ['result'])
    assert.equal(body.result.echoed, 'Runtime.evaluate')
    assert.deepEqual(calls.at(-1), {
      method: 'Runtime.evaluate',
      params: { expression: '1' },
      sessionId: 'session-1',
    })
  })
})

test('回归 /cdp：缺 method 时仍是 400 + { error }', async () => {
  const { upstream } = makeFakeUpstream()
  await withServer(upstream, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/cdp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ params: {} }),
    })
    assert.equal(res.status, 400)
    assert.match((await res.json()).error, /method/)
  })
})

test('回归 /attach：targetId 必填，默认 flatten=true', async () => {
  const { upstream, calls } = makeFakeUpstream()
  await withServer(upstream, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/attach`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetId: 't-page' }),
    })
    const body = await res.json()
    assert.equal(res.status, 200)
    // /attach 直接返回 Target.attachToTarget 的结果（形状不变）
    assert.deepEqual(body, { sessionId: 'session-1' })
    assert.deepEqual(calls.at(-1), { method: 'Target.attachToTarget', params: { targetId: 't-page', flatten: true } })

    const missing = await fetch(`${baseUrl}/attach`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(missing.status, 400)
    assert.match((await missing.json()).error, /targetId/)
  })
})

test('回归 未知路由：404 + { error }', async () => {
  const { upstream } = makeFakeUpstream()
  await withServer(upstream, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/nope`)
    assert.equal(res.status, 404)
    assert.match((await res.json()).error, /no route/)
  })
})

test('P7 /events：活跃订阅者会续期客户端需求（不靠 /cdp 也不会被 idle 饿死）', async (t) => {
  const { upstream, demands } = makeFakeUpstream()
  // P17：SSE 是长连接，abort 必须保证执行——否则断言失败时 server.close() 永不回调，
  // 整个 runner 会挂死（既不打印 not ok 也不退出）。
  const ac = new AbortController()
  t.after(() => ac.abort())
  await withServer(upstream, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/events`, { signal: ac.signal, headers: { accept: 'text/event-stream' } })
    try {
      assert.equal(res.status, 200)
      assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)
      assert.ok(demands.length >= 1, '订阅时未调用 noteDemand')
    } finally {
      ac.abort()
      await res.body?.cancel().catch(() => undefined)
    }
  })
})

test('P15 /health 必须真的返回 endpointChanged（README/JSDoc 承诺的字段）', async () => {
  const { upstream } = makeFakeUpstream()
  await withServer(upstream, async (baseUrl) => {
    const body = await (await fetch(`${baseUrl}/health`)).json()
    assert.ok('endpointChanged' in body, `缺少 endpointChanged，实际字段：${Object.keys(body).join(',')}`)
    assert.equal(body.endpointChanged, false)
  })
})

test('P15 /health 字段清单与 README 一致（契约快照）', async () => {
  const { upstream } = makeFakeUpstream()
  await withServer(upstream, async (baseUrl) => {
    const body = await (await fetch(`${baseUrl}/health`)).json()
    const documented = [
      'ok', 'hub', 'pid', 'ready', 'paused', 'pausedReason', 'attempts',
      'nextRetryMs', 'endpointChanged', 'lastError', 'connects', 'disconnects',
      'requests', 'keepalives', 'errors', 'upstream', 'source', 'profileDir', 'uptimeSec',
    ]
    const missing = documented.filter((key) => !(key in body))
    assert.deepEqual(missing, [], `README 承诺但未返回：${missing.join(',')}`)
    // lastAttemptAt / idleForMs 是额外排障字段，不写死在 README 清单里
    for (const extra of ['lastAttemptAt', 'idleForMs']) {
      assert.ok(extra in body, `额外字段丢失：${extra}`)
    }
  })
})
