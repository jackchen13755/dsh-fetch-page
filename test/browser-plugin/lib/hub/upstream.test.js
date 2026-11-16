/**
 * lib/hub/upstream.js 的重连行为回归（S1–S7 + S9，以及评审 P1/P2/P3/P5/P6/P9/P10/P11）。
 *
 * 不联网、不碰真实 Chrome：WS 握手与 TCP 端口探测都由注入的 fake 实现替代，
 * 时间参数全部压缩到毫秒级；唤醒用注入式 emitter（不依赖进程级 SIGCONT 广播）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import {
  CdpUpstream,
  backoffDelayMs,
  probeTcpPort,
  parseEndpointUrl,
  sanitizeText,
  isAuthFailure,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  BACKOFF_JITTER,
  BACKOFF_MAX_JITTER,
} from '../../../../browser-plugin/lib/hub/upstream.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, timeoutMs = 2000, stepMs = 5) {
  const started = Date.now()
  for (;;) {
    if (predicate()) return
    if (Date.now() - started > timeoutMs) throw new Error(`waitFor 超时（${timeoutMs}ms）`)
    await sleep(stepMs)
  }
}

/** 最小 fake socket：满足 CdpUpstream 的 UpstreamSocket 接口，并统计活着的条数。 */
class FakeSocket {
  constructor(hooks, opts = {}) {
    this.hooks = hooks
    this.autoRespond = opts.autoRespond === true
    this.flags = { closeOnSecondCheck: opts.closeOnSecondCheck === true }
    this.checks = 0
    this.sent = []
    this.closed = false
    this.onText = null
    this.onClose = null
    hooks.live += 1
    hooks.peak = Math.max(hooks.peak, hooks.live)
  }

  /** 第二次读取时返回「已关闭」：精确模拟 adopt 窗口内被关（P3）。 */
  get isClosed() {
    this.checks += 1
    if (this.flags.closeOnSecondCheck && this.checks >= 2) {
      this.markClosed()
      return true
    }
    return this.closed
  }

  markClosed() {
    if (this.closed) return
    this.closed = true
    this.hooks.live -= 1
  }

  send(text) {
    if (this.closed) throw new Error('WebSocket 已关闭')
    const msg = JSON.parse(text)
    this.sent.push(msg)
    if (this.autoRespond) {
      queueMicrotask(() => {
        if (!this.closed) this.onText?.(JSON.stringify({ id: msg.id, result: { product: 'Chrome/mock' } }))
      })
    }
  }

  close() {
    if (this.closed) return
    this.markClosed()
    this.onClose?.(1000, 'client close')
  }

  remoteClose(code = 1006, reason = 'network') {
    if (this.closed) return
    this.markClosed()
    this.onClose?.(code, reason)
  }

  /** 模拟「旧 socket 的迟到事件」：已关闭后再次触发 onClose。 */
  lateClose() {
    this.onClose?.(1006, 'late')
  }
}

/** 授权类失败（与 MiniWebSocket 的 code 约定一致）。 */
function authError(message = 'WebSocket 握手失败（127.0.0.1:9222）：HTTP/1.1 403 Forbidden') {
  const error = new Error(message)
  error.code = 'ws-handshake'
  error.stage = 'status'
  return error
}

/** 注入式唤醒源：测试里显式 fire()，不依赖 process 级广播。 */
function makeWakeEmitter(name = 'test-wake', mode = 'wake') {
  const handlers = new Set()
  return {
    name,
    mode,
    subscribe(cb) {
      handlers.add(cb)
      return () => handlers.delete(cb)
    },
    fire() {
      for (const cb of handlers) cb()
    },
    get size() {
      return handlers.size
    },
  }
}

function makeHarness(opts = {}) {
  const {
    portListening = true,
    connectFails = false,
    connectError = null,
    autoCloseMs = -1,
    socketOpts = {},
    ...rest
  } = opts
  const hooks = { connects: 0, live: 0, peak: 0, sockets: [], probes: [] }
  const logs = []
  const upstream = new CdpUpstream({
    cdpWsUrl: 'ws://127.0.0.1:9222/devtools/browser/mock',
    backoffBaseMs: 20,
    backoffMaxMs: 200,
    backoffJitter: 0,
    maxAttempts: 5,
    portProbeTimeoutMs: 20,
    idleMs: 10_000,
    resumeCooldownMs: 30,
    authCooldownMs: 40,
    wakeGapMs: 120_000,
    wakeDemandMs: 120_000,
    heartbeatMs: 120_000,
    keepaliveMs: 120_000,
    keepaliveWatchdogMs: 20,
    flapMs: 0,
    attachSystemWake: false,
    log: (line) => logs.push(line),
    ...rest,
    probePort: async (host, port, timeoutMs) => {
      hooks.probes.push({ host, port, timeoutMs, at: Date.now() })
      return portListening
    },
    connect: async () => {
      hooks.connects += 1
      if (typeof connectError === 'function') throw connectError()
      if (connectFails) throw new Error('WebSocket 握手失败（127.0.0.1:9222）：HTTP/1.1 403 Forbidden')
      const socket = new FakeSocket(hooks, socketOpts)
      hooks.sockets.push(socket)
      if (autoCloseMs >= 0) setTimeout(() => socket.remoteClose(1006, 'auto'), autoCloseMs)
      return socket
    },
  })
  return { upstream, hooks, logs }
}

/**
 * 生产默认参数 harness（P13）：只注入 I/O 钩子（connect/probePort/log/now），
 * 其余全部用真实默认值——wakeGapMs=120000、heartbeatMs=5000、maxAttempts=5 …
 */
function makeProdHarness(opts = {}) {
  const hooks = { connects: 0, live: 0, peak: 0, sockets: [], probes: [] }
  const logs = []
  const upstream = new CdpUpstream({
    cdpWsUrl: 'ws://127.0.0.1:9222/devtools/browser/mock',
    attachSystemWake: false,
    log: (line) => logs.push(line),
    ...opts,
    probePort: async (host, port, timeoutMs) => {
      hooks.probes.push({ host, port, timeoutMs, at: Date.now() })
      return true
    },
    connect: async () => {
      hooks.connects += 1
      const socket = new FakeSocket(hooks, { autoRespond: true })
      hooks.sockets.push(socket)
      return socket
    },
  })
  return { upstream, hooks, logs }
}

/** 从结构化日志里取出每次尝试等待了多久。 */
function loggedDelays(logs) {
  return logs
    .filter((line) => line.includes('upstream attempt attempt='))
    .map((line) => Number(/delayMs=(\d+)/.exec(line)?.[1] ?? -1))
}


// ── P8 probeTcpPort 直接覆盖（真实 net.connect，但只连本机临时端口） ─────────

test('P8 probeTcpPort：本机有监听 → true', async () => {
  const server = createServer(() => undefined)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    assert.equal(await probeTcpPort('127.0.0.1', port, 500), true)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('P8 probeTcpPort：端口没开 → false（且不抛错）', async () => {
  const server = createServer(() => undefined)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  assert.equal(await probeTcpPort('127.0.0.1', port, 300), false)
})

test('P8 probeTcpPort：连不上时受 timeoutMs 约束（不会挂住）', async () => {
  const started = Date.now()
  // TEST-NET-1（192.0.2.0/24）：文档保留地址，不会真的通
  const ok = await probeTcpPort('192.0.2.1', 9, 60)
  const elapsed = Date.now() - started
  assert.equal(ok, false)
  assert.ok(elapsed < 600, `必须在超时附近返回，实际 ${elapsed}ms`)
})

test('P8 默认会订阅并解绑宿主级 SIGCONT（attachSystemWake 默认 true）', async () => {
  const before = process.listenerCount('SIGCONT')
  const { upstream } = makeHarness({ attachSystemWake: true })
  try {
    assert.ok(process.listenerCount('SIGCONT') > before, '默认应订阅 SIGCONT（只作提示）')
  } finally {
    upstream.stop()
  }
  assert.equal(process.listenerCount('SIGCONT'), before, 'stop() 必须解绑，避免 listener 泄漏')
})

// ── S2/P5 退避策略（纯函数，用生产参数） ────────────────────────────────────

test('S2 退避序列：1500→3000→6000→12000（默认 5 次上限），上限 60000', () => {
  assert.equal(BACKOFF_BASE_MS, 1500)
  assert.equal(BACKOFF_MAX_MS, 60000)
  const noJitter = (n) => backoffDelayMs(n, { jitter: 0 })
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(noJitter), [1500, 3000, 6000, 12000, 24000, 48000, 60000])
})

test('P5 抖动上限 clamp 到 1/3：即使配置 jitter=1，相邻延迟也不倒退', () => {
  assert.ok(BACKOFF_MAX_JITTER <= 1 / 3 + 1e-9)
  assert.equal(BACKOFF_JITTER, 0.2)
  for (let i = 0; i < 2000; i += 1) {
    const a = backoffDelayMs(1, { jitter: 1 })
    const b = backoffDelayMs(2, { jitter: 1 })
    const c = backoffDelayMs(3, { jitter: 1 })
    assert.ok(b > a, `jitter=1 时也必须单调：${a} < ${b}`)
    assert.ok(c > b, `jitter=1 时也必须单调：${b} < ${c}`)
  }
  for (let i = 0; i < 300; i += 1) {
    const d = backoffDelayMs(1)
    assert.ok(d >= 1200 && d <= 1800, `默认抖动应落在 1200..1800，实际 ${d}`)
  }
})

// ── S3 端口预探测 ──────────────────────────────────────────────────────────

test('S3 端口未监听：只做 TCP 探测，一次 WS 握手都不发，5 次后 paused', async (t) => {
  const { upstream, hooks, logs } = makeHarness({ portListening: false })
  t.after(() => upstream.stop())

  await assert.rejects(upstream.ensureConnected(), /未在监听/)
  await waitFor(() => upstream.health.paused)
  assert.equal(hooks.connects, 0, '端口未监听时不允许发 WS 握手（那是授权弹窗的唯一触发器）')
  assert.equal(hooks.probes.length, 5, '每次尝试都重新做一次 TCP 探测')
  assert.equal(upstream.health.attempts, 5)
  assert.equal(upstream.health.pausedReason, 'failures')
  assert.equal(upstream.health.nextRetryMs, null)

  const delays = loggedDelays(logs)
  assert.equal(delays.length, 5)
  assert.equal(delays[0], 0, '第一次尝试前没有等待')
  assert.deepEqual(delays.slice(1), [20, 40, 80, 160])
  assert.ok(logs.some((l) => l.includes('attempt=1') && l.includes('portListening=false')))
})

test('S3/P8 重连排期来自实现本身（删掉 scheduleReconnect 这条必红）', async (t) => {
  const { upstream, hooks } = makeHarness({ portListening: false })
  t.after(() => upstream.stop())

  await assert.rejects(upstream.ensureConnected())
  await waitFor(() => upstream.health.paused)

  // 断言的输入是「实现真正发起探测的时间点」，不是测试自己算的数组。
  assert.equal(hooks.probes.length, 5)
  const gaps = hooks.probes.slice(1).map((p, i) => p.at - hooks.probes[i].at)
  assert.equal(gaps.length, 4)
  for (let i = 1; i < gaps.length; i += 1) {
    assert.ok(gaps[i] > gaps[i - 1], `相邻尝试的真实间隔必须递增：${gaps.join(',')}`)
  }
  const expected = [20, 40, 80, 160]
  for (let i = 0; i < gaps.length; i += 1) {
    assert.ok(
      gaps[i] >= expected[i] * 0.5 && gaps[i] <= expected[i] * 3,
      `第 ${i + 1} 段间隔应≈${expected[i]}ms，实际 ${gaps[i]}ms`,
    )
  }
  // 60s 窗口内的尝试次数：400ms 缩放版 = 生产 1500/3000/6000/12000 的等比缩放；
  // 生产参数下 5 次尝试发生在 0/1.5/4.5/10.5/22.5s，≤6 次。
  assert.ok(hooks.probes.length <= 6)
})

test('S3 端口在监听但 WS 握手失败（网络类）：退避递增，≤ maxAttempts 次后 paused', async (t) => {
  const { upstream, hooks, logs } = makeHarness({ portListening: true, connectFails: true })
  t.after(() => upstream.stop())

  await assert.rejects(upstream.ensureConnected(), /握手失败/)
  await waitFor(() => upstream.health.paused)

  assert.equal(hooks.connects, 5)
  assert.equal(upstream.health.attempts, 5)
  assert.equal(upstream.health.pausedReason, 'failures')
  assert.deepEqual(loggedDelays(logs).slice(1), [20, 40, 80, 160])
})

// ── P2 授权失败单独成类 ────────────────────────────────────────────────────

test('P2 授权类失败：第 1 次就 paused(auth)，不再自动握手', async (t) => {
  const { upstream, hooks } = makeHarness({ connectError: () => authError() })
  t.after(() => upstream.stop())

  await assert.rejects(upstream.ensureConnected(), /握手失败/)
  assert.equal(hooks.connects, 1, '授权类失败不允许连续重试（每次重试 = 一次授权弹窗机会）')
  assert.equal(upstream.health.paused, true)
  assert.equal(upstream.health.pausedReason, 'auth')
  assert.equal(upstream.health.nextRetryMs, null, '授权暂停不排自动重试')

  await sleep(120) // 远超普通退避基数
  assert.equal(hooks.connects, 1, 'paused(auth) 后没有任何自动重连')
})

test('P2 授权类失败：轮询式 3 次客户端请求只放行 1 次尝试（auth 冷却 30s 语义）', async (t) => {
  const { upstream, hooks } = makeHarness({ connectError: () => authError(), authCooldownMs: 60 })
  t.after(() => upstream.stop())

  await assert.rejects(upstream.ensureConnected(), /握手失败/)
  assert.equal(hooks.connects, 1)

  // 冷却内：三次请求全部只拿到可操作错误，0 次新握手
  for (let i = 0; i < 3; i += 1) await assert.rejects(upstream.ensureConnected(), /暂停|冷却/)
  assert.equal(hooks.connects, 1, '冷却内不得每轮一弹窗')

  // 冷却后：连续三次请求也只放行一次（失败立即回 paused(auth)）
  await sleep(80)
  const before = hooks.connects
  const results = await Promise.allSettled([
    upstream.ensureConnected(),
    upstream.ensureConnected(),
    upstream.ensureConnected(),
  ])
  assert.ok(results.every((r) => r.status === 'rejected'))
  assert.equal(hooks.connects, before + 1, '冷却结束后无论是几次请求，只允许一次尝试')
  assert.equal(upstream.health.pausedReason, 'auth')
})

test('P2 授权暂停 + 端点变化（uuid/端口变了）：允许再试一次', async (t) => {
  let wsUrl = 'ws://127.0.0.1:9222/devtools/browser/aaaa1111bbbb2222'
  const { upstream, hooks } = makeHarness({
    connectError: () => authError(),
    authCooldownMs: 60_000,
    resolveEndpointFn: () => ({ wsUrl, source: 'config' }),
    cdpWsUrl: undefined,
  })
  t.after(() => upstream.stop())

  await assert.rejects(upstream.ensureConnected(), /握手失败/)
  assert.equal(upstream.health.pausedReason, 'auth')
  assert.equal(upstream.health.endpointChanged, false)

  // 冷却还没过，但端点没变 → 拒绝且不握手
  await assert.rejects(upstream.ensureConnected(), /暂停|冷却/)
  assert.equal(hooks.connects, 1)

  // 用户重新开了远程调试：uuid 变了 → 允许一次尝试
  wsUrl = 'ws://127.0.0.1:9222/devtools/browser/cccc3333dddd4444'
  assert.equal(upstream.health.endpointChanged, true)
  await assert.rejects(upstream.ensureConnected(), /握手失败/)
  assert.equal(hooks.connects, 2)
})

// ── P3 adopt 窗口 ──────────────────────────────────────────────────────────

test('P3 握手 resolve 后立刻被关：不许 ready=true，pending 立刻失败并重连', async (t) => {
  const { upstream, hooks, logs } = makeHarness({ socketOpts: { closeOnSecondCheck: true } })
  t.after(() => upstream.stop())

  await assert.rejects(upstream.ensureConnected(), /立刻被关闭/)

  assert.equal(upstream.isReady, false, 'adopt 窗口内被关掉时绝不能报 ready')
  assert.equal(hooks.sockets[0].closed, true)
  assert.equal(upstream.health.ready, false)
  assert.ok(logs.some((l) => l.includes('adopt')), `缺少 adopt 失败日志：${logs.join('\n')}`)
  // 失败已进入退避路径：要么有排期，要么已经重新连上
  await waitFor(() => hooks.connects >= 2, 1000)
  assert.equal(hooks.peak, 1)
})

test('P3 握手成功后正常 socket 才能 ready，且 pending 能收到回包', async (t) => {
  const { upstream, hooks } = makeHarness({ socketOpts: { autoRespond: true } })
  t.after(() => upstream.stop())

  await upstream.ensureConnected()
  assert.equal(upstream.isReady, true)
  const result = await upstream.send('Browser.getVersion')
  assert.deepEqual(result, { product: 'Chrome/mock' })
})

// ── S1 单飞 + 代际守卫 ─────────────────────────────────────────────────────

test('S1 单飞：并发 ensure 只握手一次，socket 峰值 = 1', async (t) => {
  const { upstream, hooks } = makeHarness()
  t.after(() => upstream.stop())

  await Promise.all([upstream.ensureConnected(), upstream.ensureConnected(), upstream.ensureConnected()])
  assert.equal(hooks.connects, 1, '并发 ensure 必须共用同一条在途连接')
  assert.equal(hooks.peak, 1)
  assert.equal(upstream.isReady, true)
  assert.equal(upstream.stats.connects, 1)
})

test('S1 迟到 close / 迟到报文：旧 socket 的事件被身份校验丢弃，峰值仍为 1', async (t) => {
  const { upstream, hooks } = makeHarness()
  t.after(() => upstream.stop())

  await upstream.ensureConnected()
  const first = hooks.sockets[0]
  first.remoteClose(1006, 'drop')
  assert.equal(upstream.isReady, false)

  await waitFor(() => hooks.connects === 2)
  const second = hooks.sockets[1]
  assert.equal(hooks.peak, 1, '任意时刻最多一条上游 socket')

  const disconnects = upstream.stats.disconnects
  const connects = upstream.stats.connects
  first.lateClose()
  first.onText?.('{"method":"Target.targetCreated","params":{}}')
  assert.equal(upstream.stats.disconnects, disconnects, '迟到 close 不得再记一次断开')
  assert.equal(upstream.stats.connects, connects, '迟到 close 不得触发新的连接')
  assert.equal(upstream.isReady, true, '迟到事件不得把新连接标成未就绪')
  assert.equal(second.closed, false)
  assert.equal(hooks.peak, 1)
})

// ── S4 失败上限 + 客户端放行 ───────────────────────────────────────────────

test('S4 paused 后无客户端请求不再握手；请求放行一次、失败立刻回 paused', async (t) => {
  const { upstream, hooks } = makeHarness({ portListening: false })
  t.after(() => upstream.stop())

  await assert.rejects(upstream.ensureConnected(), /未在监听/)
  await waitFor(() => upstream.health.paused)
  const probesAtPause = hooks.probes.length

  await assert.rejects(upstream.ensureConnected(), /暂停/)
  assert.equal(hooks.probes.length, probesAtPause)

  await sleep(120)
  assert.equal(hooks.probes.length, probesAtPause, 'paused 后不得自动发起新尝试')

  const before = hooks.probes.length
  await assert.rejects(upstream.ensureConnected(), /未在监听/)
  assert.equal(hooks.probes.length, before + 1, '一次显式请求只放行一次尝试')
  assert.equal(upstream.health.paused, true)
  assert.equal(upstream.health.attempts, 1, '客户端放行的那次失败后计数归到 1 并立即暂停')
})

test('S2/S4 握手成功却被立刻断开：仍按退避累加，不会退回固定 1.5s 风暴', async (t) => {
  // flapMs 2000 + autoClose 0ms：livedMs 一定小于阈值，不会因为机器卡顿串到「健康断开」分支
  const { upstream, hooks, logs } = makeHarness({ autoCloseMs: 0, flapMs: 2000 })
  t.after(() => upstream.stop())

  await upstream.ensureConnected()
  await waitFor(() => upstream.health.paused, 3000)
  assert.ok(hooks.connects <= 5, `短命连接也必须有上限，实际 ${hooks.connects} 次`)
  const delays = loggedDelays(logs)
  for (let i = 1; i < delays.length; i += 1) {
    assert.ok(delays[i] > delays[i - 1], `短命连接下退避仍应递增：${delays.join(',')}`)
  }
  assert.equal(upstream.health.pausedReason, 'failures')
})

// ── S5 空闲断开 ───────────────────────────────────────────────────────────

test('S5 空闲超时：主动断开并停在 paused(idle)，不再自动重连', async (t) => {
  const { upstream, hooks } = makeHarness({ idleMs: 60, heartbeatMs: 10 })
  t.after(() => upstream.stop())

  await upstream.ensureConnected()
  const socket = hooks.sockets[0]
  assert.equal(socket.closed, false)

  await waitFor(() => upstream.health.paused)
  assert.equal(upstream.health.pausedReason, 'idle')
  assert.equal(socket.closed, true, '空闲应主动关掉 socket')
  assert.equal(upstream.isReady, false)
  assert.equal(hooks.live, 0)

  const connects = hooks.connects
  await sleep(80)
  assert.equal(hooks.connects, connects, 'idle 暂停后不得自动重连')
})

test('P7 noteDemand() 续期：/events 这类「只订阅不发请求」的客户端不会把连接饿死', async (t) => {
  const { upstream, hooks } = makeHarness({ idleMs: 80, heartbeatMs: 10 })
  t.after(() => upstream.stop())

  await upstream.ensureConnected()
  const socket = hooks.sockets[0]
  // 模拟 SSE 客户端：只要有 noteDemand() 续期，就不该 idle 断开
  for (let i = 0; i < 6; i += 1) {
    await sleep(30)
    upstream.noteDemand()
  }
  assert.equal(socket.closed, false, '有活跃订阅者续期时不得 idle 断开')
  assert.equal(upstream.health.paused, false)
})

// ── S6 keepalive 看门狗 ───────────────────────────────────────────────────

test('S6 keepalive 无回包：判半开并走统一重连路径（不吞错）', async (t) => {
  const { upstream, hooks } = makeHarness({ keepaliveMs: 10, keepaliveWatchdogMs: 20, backoffBaseMs: 1000 })
  t.after(() => upstream.stop())

  await upstream.ensureConnected()
  const socket = hooks.sockets[0]
  await waitFor(() => socket.closed, 1000)

  assert.equal(upstream.isReady, false)
  assert.match(upstream.stats.lastError ?? '', /keepalive/)
  assert.equal(upstream.health.paused, false, '看门狗断开后应进入退避重连，而不是停摆')
})

test('S6/P11 健康的 keepalive：有回包不误杀，且 keepalive 不计入 requests', async (t) => {
  const { upstream, hooks } = makeHarness({
    keepaliveMs: 10,
    keepaliveWatchdogMs: 40,
    socketOpts: { autoRespond: true },
  })
  t.after(() => upstream.stop())

  await upstream.ensureConnected()
  const socket = hooks.sockets[0]
  await sleep(120)
  assert.equal(socket.closed, false)
  assert.equal(upstream.isReady, true)
  assert.ok(socket.sent.some((m) => m.method === 'Browser.getVersion'))
  assert.ok(upstream.stats.keepalives > 0)
  assert.equal(upstream.stats.requests, 0, 'keepalive 不能把 requests 的语义搅浑')
})

// ── S7/P1 唤醒处理 ─────────────────────────────────────────────────────────

test('P1 无新鲜需求时唤醒不得握手（哪怕 paused 是 failures）', async (t) => {
  const emitter = makeWakeEmitter()
  const { upstream, hooks } = makeHarness({
    portListening: false,
    wakeEmitters: [emitter],
    wakeDemandMs: 40,
    maxAttempts: 1,
    backoffBaseMs: 1000,
  })
  t.after(() => upstream.stop())

  await assert.rejects(upstream.ensureConnected(), /未在监听/)
  assert.equal(upstream.health.paused, true)
  assert.equal(upstream.health.pausedReason, 'failures')

  await sleep(80) // 需求已过期（> wakeDemandMs）
  const before = hooks.probes.length
  emitter.fire()
  await sleep(40)
  assert.equal(hooks.probes.length, before, '需求过期时唤醒不得为了探测去握手')
  assert.equal(upstream.health.paused, true, '没有新鲜需求时保持 paused')
})

test('P1 有新鲜需求时唤醒：重置退避并只重建一次', async (t) => {
  const emitter = makeWakeEmitter()
  const { upstream, hooks, logs } = makeHarness({
    portListening: false,
    wakeEmitters: [emitter],
    backoffBaseMs: 5000,
    maxAttempts: 5,
  })
  t.after(() => upstream.stop())

  await assert.rejects(upstream.ensureConnected(), /未在监听/)
  await waitFor(() => upstream.health.paused) // 5 次失败（base=5000 时只在第一次）

  const before = hooks.probes.length
  emitter.fire()
  await waitFor(() => hooks.probes.length > before, 1000)
  await sleep(20)
  assert.equal(hooks.probes.length, before + 1, '一次唤醒最多一次重建')
  assert.equal(upstream.health.attempts, 1, '唤醒应重置退避计数')
  assert.ok(logs.some((l) => l.includes('wake source=test-wake') && l.includes('freshDemand=true')))
  await sleep(30)
  assert.equal(hooks.probes.length, before + 1, '重建失败后回到退避，不得连发')
})

test('P1 授权暂停不得被唤醒解除（那只会多弹一次窗）', async (t) => {
  const emitter = makeWakeEmitter()
  const { upstream, hooks } = makeHarness({ connectError: () => authError(), wakeEmitters: [emitter] })
  t.after(() => upstream.stop())

  await assert.rejects(upstream.ensureConnected(), /握手失败/)
  assert.equal(upstream.health.pausedReason, 'auth')
  const before = hooks.connects
  emitter.fire()
  await sleep(40)
  assert.equal(hooks.connects, before, '授权暂停时唤醒不得握手')
  assert.equal(upstream.health.pausedReason, 'auth')
})

test('P1 SIGCONT 这类进程级广播只当提示：时间差不够就不算唤醒', async (t) => {
  const hint = makeWakeEmitter('sigcont', 'hint')
  const { upstream, hooks, logs } = makeHarness({ wakeEmitters: [hint] })
  t.after(() => upstream.stop())

  await upstream.ensureConnected()
  hint.fire() // 没有真实时间差
  await sleep(20)
  assert.ok(logs.some((l) => l.includes('wake-hint ignored source=sigcont')))
  assert.equal(hooks.connects, 1, '普通 fg/bg 的 SIGCONT 不该重建连接')
})

test('S7 睡眠兜底（时间差 > wakeGap）：重置退避并只重建一次', async (t) => {
  let fakeNow = 1_000_000
  const { upstream, hooks, logs } = makeHarness({
    now: () => fakeNow,
    portListening: false,
    backoffBaseMs: 1000,
    maxAttempts: 2,
    wakeGapMs: 100,
    wakeDemandMs: 120_000,
    heartbeatMs: 5,
  })
  t.after(() => upstream.stop())

  await assert.rejects(upstream.ensureConnected(), /未在监听/)
  await waitFor(() => upstream.health.paused)
  const before = hooks.probes.length

  fakeNow += 10_000 // 模拟睡了一觉；需求仍在 wakeDemandMs 内
  await waitFor(() => hooks.probes.length > before, 1000)
  await sleep(10)
  assert.equal(hooks.probes.length, before + 1, '时间差兜底也只发起一次重建')
  assert.ok(logs.some((l) => l.includes('wake source=time-gap')), `唤醒日志缺失：${logs.join('\n')}`)
})

test('S7 睡眠很久（需求也过期）：醒来不自动握手', async (t) => {
  let fakeNow = 1_000_000
  const { upstream, hooks } = makeHarness({
    now: () => fakeNow,
    portListening: false,
    backoffBaseMs: 1000,
    maxAttempts: 2,
    wakeGapMs: 100,
    wakeDemandMs: 1000,
    heartbeatMs: 5,
  })
  t.after(() => upstream.stop())

  await assert.rejects(upstream.ensureConnected(), /未在监听/)
  await waitFor(() => upstream.health.paused)
  const before = hooks.probes.length

  fakeNow += 3 * 3600_000 // 睡 3 小时：需求早已过期
  await sleep(60)
  assert.equal(hooks.probes.length, before, '睡 3 小时后不得自动握手（评审探针 Q1-b）')
  assert.equal(upstream.health.paused, true)
})


// ── P13 唤醒必须走 ensureConnected 入口也不能双开 ─────────────────────────

test('P13 断线 + 睡 3h 后经 ensureConnected 唤醒：只允许 1 次握手 / connects 增量 1 / 峰值 socket 1', async (t) => {
  // 真实默认参数（wakeGapMs=120000 / heartbeatMs=5000 / maxAttempts=5），只注入时钟与 I/O。
  // 复现评审那条路径：ready=false 时 ensureConnected 会真的去连，旧实现让 detectWake 落在
  // attemptConnect 的同步段里 → handleWake 看到 connecting===null → 再开一条 attempt。
  let fakeNow = 1_000_000
  const { upstream, hooks, logs } = makeProdHarness({ now: () => fakeNow })
  t.after(() => upstream.stop())

  await upstream.ensureConnected()
  assert.equal(hooks.connects, 1)
  const first = hooks.sockets[0]
  first.remoteClose() // 睡眠期间断网/Chrome 关闭连接的常见形态
  await waitFor(() => !upstream.isReady)

  const before = { handshakes: hooks.connects, connects: upstream.stats.connects }
  fakeNow += 3 * 3600_000
  await upstream.ensureConnected().catch(() => undefined)
  await sleep(150) // 给任何「第二条 attempt」跑出来的机会

  const handshakeDelta = hooks.connects - before.handshakes
  const connectsDelta = upstream.stats.connects - before.connects
  assert.equal(handshakeDelta, 1, `唤醒后只允许 1 次握手，实际 ${handshakeDelta}（旧实现 2）`)
  assert.equal(connectsDelta, 1, `connects 增量只允许 1，实际 ${connectsDelta}（旧实现 2）`)
  assert.equal(hooks.peak, 1, `任意时刻最多 1 条 socket，峰值 ${hooks.peak}（旧实现 2）`)
  assert.equal(upstream.isReady, true)
  assert.equal(hooks.live, 1)
  assert.ok(logs.some((l) => l.includes('wake source=time-gap')), logs.join('\n'))
})

test('P13 已就绪时唤醒经 ensureConnected：重建一次（旧 socket 收掉），峰值仍为 1', async (t) => {
  let fakeNow = 1_000_000
  const { upstream, hooks } = makeProdHarness({ now: () => fakeNow })
  t.after(() => upstream.stop())

  await upstream.ensureConnected()
  const first = hooks.sockets[0]
  fakeNow += 3 * 3600_000
  await upstream.ensureConnected()
  assert.equal(hooks.peak, 1)
  assert.equal(hooks.connects, 2)
  assert.equal(first.closed, true, '唤醒时应先收掉旧 socket')
  assert.equal(hooks.live, 1)
  assert.equal(upstream.isReady, true)
})

test('P13 三个入口并发（ensure + retryTick 语义）+ 唤醒：峰值 socket 恒为 1', async (t) => {
  let fakeNow = 1_000_000
  const { upstream, hooks } = makeProdHarness({ now: () => fakeNow })
  t.after(() => upstream.stop())

  await upstream.ensureConnected()
  fakeNow += 3 * 3600_000
  await Promise.all([upstream.ensureConnected(), upstream.ensureConnected(), upstream.ensureConnected()])
  assert.equal(hooks.peak, 1, `并发 ensure + 唤醒后仍只能 1 条 socket，实际峰值 ${hooks.peak}`)
  assert.equal(hooks.connects, 2, `只允许一次重建，实际 ${hooks.connects} 次握手`)
  assert.equal(upstream.stats.connects, 2)
})

// ── P16 paused 状态的 attempts/pausedReason 必须自洽 ──────────────────────

test('P16 paused(failures) 被唤醒忽略时不得出现 attempts=0 的自相矛盾', async (t) => {
  const emitter = makeWakeEmitter()
  let fakeNow = 1_000_000
  const { upstream } = makeHarness({
    now: () => fakeNow,
    portListening: false,
    wakeEmitters: [emitter],
    wakeDemandMs: 1000,
    wakeGapMs: 120_000,
    maxAttempts: 3,
    backoffBaseMs: 20,
  })
  t.after(() => upstream.stop())

  await assert.rejects(upstream.ensureConnected(), /未在监听/)
  await waitFor(() => upstream.health.paused)
  const paused = upstream.health
  assert.equal(paused.pausedReason, 'failures')
  assert.equal(paused.attempts, 3)

  // 需求过期后唤醒：保持 paused，且状态必须自洽
  fakeNow += 60_000
  emitter.fire()
  await sleep(20)
  const after = upstream.health
  assert.equal(after.paused, true)
  assert.equal(after.pausedReason, 'failures', '唤醒不得把 failures 悄悄改成 idle')
  assert.ok(
    after.attempts > 0,
    `paused(failures) 时 attempts 不能是 0（实际 ${after.attempts}）——这正是评审 P16 的矛盾状态`,
  )
})

test('P16 paused(idle) 时 attempts 一定是 0（不出现 failures+attempts=0 的镜像错误）', async (t) => {
  const { upstream, hooks } = makeHarness({ idleMs: 50, heartbeatMs: 10 })
  t.after(() => upstream.stop())
  await upstream.ensureConnected()
  await waitFor(() => upstream.health.paused)
  const health = upstream.health
  assert.equal(health.pausedReason, 'idle')
  assert.equal(health.attempts, 0)
  assert.equal(hooks.live, 0)
})

// ── P6 / P9 端点与脱敏 ─────────────────────────────────────────────────────

test('P6 端点端口必须 1..65535：非法即报错，不静默回落 9222', async (t) => {
  assert.equal(parseEndpointUrl('ws://127.0.0.1:9222/devtools/browser/x').ok, true)
  for (const bad of ['ws://127.0.0.1:0/devtools/browser/x', 'ws://127.0.0.1:99999/devtools/browser/x']) {
    const parsed = parseEndpointUrl(bad)
    assert.equal(parsed.ok, false, `${bad} 不该被接受`)
    assert.match(parsed.reason, /端口|无法解析/)
  }

  const { upstream, hooks } = makeHarness({
    cdpWsUrl: 'ws://127.0.0.1:0/devtools/browser/x',
    portListening: true,
  })
  t.after(() => upstream.stop())
  await assert.rejects(upstream.ensureConnected(), /端点端口非法|无法解析/)
  assert.equal(hooks.connects, 0)
  assert.match(upstream.stats.lastError ?? '', /0/)
  assert.ok(!(upstream.stats.lastError ?? '').includes('9222'), '错误信息不得谎报成 9222')
})

test('P9 脱敏：uuid 只留前 8 位，home 目录缩成 ~', () => {
  const uuid = 'aaaa1111-bbbb-2222-cccc-333344445555'
  const text = `连接失败 ws://127.0.0.1:9222/devtools/browser/${uuid} 目录 ${homedir()}/Library/Application Support/Google/Chrome`
  const out = sanitizeText(text)
  assert.ok(out.includes('/devtools/browser/aaaa1111…'), out)
  assert.ok(!out.includes(uuid), '完整 uuid 不得出现在日志/health.lastError')
  assert.ok(!out.includes(homedir()), 'home 目录不得原样出现')
  assert.ok(out.includes('~/Library'), out)
})

test('P9 授权失败写进 health.lastError 时已脱敏', async (t) => {
  const uuid = 'eeee5555-ffff-6666-7777-888899990000'
  const { upstream } = makeHarness({
    connectError: () => authError(`WebSocket 握手失败（127.0.0.1:9222/devtools/browser/${uuid}）：HTTP/1.1 403`),
  })
  t.after(() => upstream.stop())
  await assert.rejects(upstream.ensureConnected())
  assert.ok(upstream.stats.lastError !== null)
  assert.ok(!(upstream.stats.lastError ?? '').includes(uuid), upstream.stats.lastError ?? '')
})

// ── P10 畸形帧 ────────────────────────────────────────────────────────────

test('P10 畸形帧（null / 数组 / 非法 JSON）不得掀翻宿主', async (t) => {
  const { upstream, hooks, logs } = makeHarness()
  t.after(() => upstream.stop())
  await upstream.ensureConnected()
  const socket = hooks.sockets[0]

  assert.doesNotThrow(() => socket.onText('null'))
  assert.doesNotThrow(() => socket.onText('[1,2,3]'))
  assert.doesNotThrow(() => socket.onText('{bad json'))
  assert.ok(logs.filter((l) => l.includes('dropped malformed frame')).length >= 3)
  assert.equal(upstream.isReady, true, '畸形帧不该影响连接状态')
})

// ── 其它契约 ──────────────────────────────────────────────────────────────

test('stop() 之后不再连接，且 ensureConnected 给出可操作的错误', async () => {
  const { upstream, hooks } = makeHarness()
  await upstream.ensureConnected()
  upstream.stop()
  assert.equal(upstream.isReady, false)
  await assert.rejects(upstream.ensureConnected(), /上游已停止/)
  const connects = hooks.connects
  await sleep(40)
  assert.equal(hooks.connects, connects)
})

test('health 反映真实上游状态（ready/paused/attempts/lastError/nextRetryMs）', async (t) => {
  const { upstream } = makeHarness()
  t.after(() => upstream.stop())
  await upstream.ensureConnected()
  let health = upstream.health
  assert.equal(health.ready, true)
  assert.equal(health.paused, false)
  assert.equal(health.attempts, 0)
  assert.equal(health.nextRetryMs, null)

  const failing = makeHarness({ portListening: false })
  t.after(() => failing.upstream.stop())
  await assert.rejects(failing.upstream.ensureConnected())
  await waitFor(() => failing.upstream.health.paused)
  health = failing.upstream.health
  assert.equal(health.ready, false)
  assert.equal(health.paused, true)
  assert.equal(health.pausedReason, 'failures')
  assert.equal(health.attempts, 5)
  assert.match(health.lastError ?? '', /未在监听/)
})

test('isAuthFailure 只认握手类错误（网络类不误判）', () => {
  assert.equal(isAuthFailure(authError()), true)
  const tcp = new Error('连接 127.0.0.1:9222 失败：ECONNREFUSED')
  tcp.code = 'ws-tcp'
  assert.equal(isAuthFailure(tcp), false)
  assert.equal(isAuthFailure(new Error('随便一个错误')), false)
  assert.equal(isAuthFailure(null), false)
})

test('事件帧广播给订阅者，响应帧只喂给对应 pending 请求', async (t) => {
  const { upstream, hooks } = makeHarness()
  t.after(() => upstream.stop())
  await upstream.ensureConnected()
  const socket = hooks.sockets[0]

  const events = []
  const off = upstream.onEvent((msg) => events.push(msg))
  socket.onText('{"method":"Target.targetCreated","params":{"targetId":"t1"}}')
  assert.equal(events.length, 1)
  off()
  socket.onText('{"method":"Target.targetDestroyed","params":{"targetId":"t1"}}')
  assert.equal(events.length, 1)

  const pending = upstream.send('Browser.getVersion', {})
  await waitFor(() => socket.sent.some((m) => typeof m.id === 'number'))
  const sent = socket.sent.at(-1)
  socket.onText(JSON.stringify({ id: sent.id, result: { product: 'Chrome/mock' } }))
  assert.deepEqual(await pending, { product: 'Chrome/mock' })
})
