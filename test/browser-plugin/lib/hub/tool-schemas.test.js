/**
 * chrome_* 工具 **输出契约** 回归（评审 P18）。
 *
 * 真实故障：`chrome_hub` 的 output.schema 把 `pausedReason` 声明成必填 string、
 * `nextRetryMs` 声明成必填 number，而 health 在「已连上」状态给的是 null →
 * 宿主校验直接抛 `tool "chrome_hub" returned invalid output`，工具在**绝大多数正常
 * 状态**下不可用。
 *
 * 本文件用**宿主的同一套校验器**（`@deepseek-ai/dsh-tools` 的
 * `valueSchemaSpecToJsonSchema` + `assertSupportedJsonSchema` + `validateJsonSchemaValue`）
 * 逐状态验证我们的 schema；状态本身来自**真实 CdpUpstream + 真实 composeHubStatus +
 * 真实 hubStatusOutput**，不是手写常量。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { ChromeHub, composeHubStatus } from '../../../../browser-plugin/lib/hub/index.js'
import { CdpUpstream } from '../../../../browser-plugin/lib/hub/upstream.js'
import {
  BROWSER_OUTPUT_SCHEMA,
  CHROME_CDP_OUTPUT_SCHEMA,
  CHROME_COOKIES_OUTPUT_SCHEMA,
  CHROME_HUB_OUTPUT_SCHEMA,
  CHROME_PAGE_OUTPUT_SCHEMA,
  VERIFY_PAGE_OUTPUT_SCHEMA,
  hubStatusOutput,
} from '../../../../browser-plugin/lib/hub/tool-schemas.js'

// 宿主的校验器就在插件的依赖里：用 createRequire 定位，避免测试与插件各装一份。
const requireFromPlugin = createRequire(new URL('../../../../browser-plugin/package.json', import.meta.url))
const dshTools = await import(pathToFileURL(requireFromPlugin.resolve('@deepseek-ai/dsh-tools')).href)
const { valueSchemaSpecToJsonSchema, assertSupportedJsonSchema, validateJsonSchemaValue } = dshTools

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now()
  for (;;) {
    if (predicate()) return
    if (Date.now() - started > timeoutMs) throw new Error(`waitFor 超时（${timeoutMs}ms）`)
    await sleep(5)
  }
}

/** 用宿主同一套规则校验：先断言 schema 属于受支持子集，再校验取值。 */
function validate(spec, value) {
  assertSupportedJsonSchema(valueSchemaSpecToJsonSchema(spec))
  return validateJsonSchemaValue(valueSchemaSpecToJsonSchema(spec), value, 'value')
}

function assertValid(spec, value, label) {
  const violations = validate(spec, value)
  assert.deepEqual(violations, [], `${label} 违反输出契约：${violations.join('; ')}\n实际值：${JSON.stringify(value)}`)
}

/** 造一个真实 CdpUpstream（注入时钟/IO，绝不碰真实 Chrome）。 */
function makeUpstream(opts = {}) {
  const hooks = { connects: 0, live: 0, peak: 0, sockets: [] }
  const upstream = new CdpUpstream({
    cdpWsUrl: 'ws://127.0.0.1:9222/devtools/browser/aaaa1111bbbb2222',
    attachSystemWake: false,
    backoffBaseMs: 20,
    backoffMaxMs: 200,
    backoffJitter: 0,
    portProbeTimeoutMs: 20,
    keepaliveMs: 120_000,
    keepaliveWatchdogMs: 20,
    flapMs: 0,
    log: () => {},
    ...opts,
    probePort: opts.probePort ?? (async () => true),
    connect: opts.connect ?? (async () => {
      hooks.connects += 1
      const socket = {
        onText: null,
        onClose: null,
        closed: false,
        get isClosed() {
          return this.closed
        },
        send() {},
        close() {
          if (this.closed) return
          this.closed = true
          hooks.live -= 1
          this.onClose?.(1000, 'client close')
        },
        remoteClose() {
          if (this.closed) return
          this.closed = true
          hooks.live -= 1
          this.onClose?.(1006, 'network')
        },
      }
      hooks.live += 1
      hooks.peak = Math.max(hooks.peak, hooks.live)
      hooks.sockets.push(socket)
      return socket
    }),
  })
  return { upstream, hooks }
}

/** 真实 ChromeHub 的 base 状态（未建上游时 status() 的返回）。 */
async function baseStatus() {
  const hub = new ChromeHub({ port: 0 })
  try {
    return await hub.status()
  } finally {
    await hub.stop()
  }
}

// ── schema 自身合法性 ──────────────────────────────────────────────────────

test('P18 六个工具的 output schema 都属于宿主支持的子集', () => {
  for (const [name, spec] of [
    ['chrome_hub', CHROME_HUB_OUTPUT_SCHEMA],
    ['chrome_cookies', CHROME_COOKIES_OUTPUT_SCHEMA],
    ['chrome_page', CHROME_PAGE_OUTPUT_SCHEMA],
    ['chrome_cdp', CHROME_CDP_OUTPUT_SCHEMA],
    ['browser', BROWSER_OUTPUT_SCHEMA],
    ['verify_page', VERIFY_PAGE_OUTPUT_SCHEMA],
  ]) {
    assert.doesNotThrow(() => assertSupportedJsonSchema(valueSchemaSpecToJsonSchema(spec)), `${name} schema 不受支持`)
  }
})

// ── 五种健康状态：形状必须一致且全部通过 ───────────────────────────────────

test('P18 chrome_hub：ready 状态（pausedReason/nextRetryMs 为 null）必须通过', async (t) => {
  const base = await baseStatus()
  const { upstream } = makeUpstream()
  t.after(() => upstream.stop())

  await upstream.ensureConnected()
  const status = composeHubStatus({ ...base, port: 9334, baseUrl: 'http://127.0.0.1:9334' }, upstream)
  assert.equal(status.ready, true)

  const out = hubStatusOutput('status', status)
  assert.equal(out.pausedReason, null, 'ready 状态下 pausedReason 就是 null（这正是旧 schema 崩掉的值）')
  assert.equal(out.nextRetryMs, null)
  assertValid(CHROME_HUB_OUTPUT_SCHEMA, out, 'ready')
})

test('P18 chrome_hub：paused(auth) 状态必须通过', async (t) => {
  const base = await baseStatus()
  const authError = new Error('WebSocket 握手失败（127.0.0.1:9222）：HTTP/1.1 403 Forbidden')
  authError.code = 'ws-handshake'
  authError.stage = 'status'
  const { upstream } = makeUpstream({
    connect: async () => {
      throw authError
    },
  })
  t.after(() => upstream.stop())

  await assert.rejects(upstream.ensureConnected())
  const status = composeHubStatus(base, upstream)
  assert.equal(status.paused, true)
  assert.equal(status.pausedReason, 'auth')

  const out = hubStatusOutput('status', status)
  assertValid(CHROME_HUB_OUTPUT_SCHEMA, out, 'paused(auth)')
  assert.equal(out.nextRetryMs, null)
})

test('P18 chrome_hub：paused(failures) 状态必须通过', async (t) => {
  const base = await baseStatus()
  const { upstream } = makeUpstream({ probePort: async () => false, maxAttempts: 3 })
  t.after(() => upstream.stop())

  await assert.rejects(upstream.ensureConnected())
  await waitFor(() => upstream.health.paused)
  const status = composeHubStatus(base, upstream)
  assert.equal(status.pausedReason, 'failures')
  assert.ok(status.attempts > 0)

  const out = hubStatusOutput('status', status)
  assertValid(CHROME_HUB_OUTPUT_SCHEMA, out, 'paused(failures)')
  assert.equal(out.nextRetryMs, null)
})

test('P18 chrome_hub：退避排期中（nextRetryMs 有值）必须通过', async (t) => {
  const base = await baseStatus()
  const { upstream } = makeUpstream({
    probePort: async () => false,
    backoffBaseMs: 500,
    maxAttempts: 5,
  })
  t.after(() => upstream.stop())

  // 第一次就失败：此时未 paused，正在等第一段退避 → nextRetryMs > 0
  await assert.rejects(upstream.ensureConnected())
  const status = composeHubStatus(base, upstream)
  assert.equal(status.paused, false)
  assert.ok(typeof status.nextRetryMs === 'number' && status.nextRetryMs > 0, `nextRetryMs=${status.nextRetryMs}`)

  const out = hubStatusOutput('status', status)
  assertValid(CHROME_HUB_OUTPUT_SCHEMA, out, 'retrying')
  assert.equal(out.pausedReason, null)
})

test('P18 chrome_hub：paused(idle) 状态必须通过', async (t) => {
  const base = await baseStatus()
  const { upstream } = makeUpstream({ idleMs: 60, heartbeatMs: 10 })
  t.after(() => upstream.stop())

  await upstream.ensureConnected()
  await waitFor(() => upstream.health.paused)
  const status = composeHubStatus(base, upstream)
  assert.equal(status.pausedReason, 'idle')

  const out = hubStatusOutput('status', status)
  assertValid(CHROME_HUB_OUTPUT_SCHEMA, out, 'paused(idle)')
  assert.equal(out.nextRetryMs, null)
})

test('P18 chrome_hub：connecting / 无上游状态必须通过', async (t) => {
  const base = await baseStatus()
  const { upstream } = makeUpstream()
  t.after(() => upstream.stop())

  // 从未连过：ready=false、paused=false、upstream/source/profileDir 全 null
  const status = composeHubStatus({ ...base, port: 9334, baseUrl: 'http://127.0.0.1:9334' }, upstream)
  assert.equal(status.ready, false)
  assert.equal(status.paused, false)
  assert.equal(status.upstream, null)

  const out = hubStatusOutput('status', status)
  assertValid(CHROME_HUB_OUTPUT_SCHEMA, out, 'connecting')
  assert.equal(out.upstream, null)
  assert.equal(out.source, null)
  assert.equal(out.profileDir, null)
  assert.equal(out.lastError, null)
  assert.equal(out.lastConnectedAt, null)

  // 完全没有上游（stop 之后）也要能过
  assertValid(CHROME_HUB_OUTPUT_SCHEMA, hubStatusOutput('status', base), 'no-upstream')
})

test('P18 chrome_hub：五种状态的字段集合必须完全一致（不给脚本留 undefined 陷阱）', async (t) => {
  const base = await baseStatus()
  const ok = makeUpstream()
  const authErr = new Error('403')
  authErr.code = 'ws-handshake'
  const auth = makeUpstream({ connect: async () => { throw authErr } })
  const dead = makeUpstream({ probePort: async () => false, maxAttempts: 3 })
  const idle = makeUpstream({ idleMs: 60, heartbeatMs: 10 })
  t.after(() => {
    ok.upstream.stop(); auth.upstream.stop(); dead.upstream.stop(); idle.upstream.stop()
  })

  await ok.upstream.ensureConnected()
  await assert.rejects(auth.upstream.ensureConnected())
  await assert.rejects(dead.upstream.ensureConnected())
  await waitFor(() => dead.upstream.health.paused)
  await idle.upstream.ensureConnected()
  await waitFor(() => idle.upstream.health.paused)

  const outputs = [
    hubStatusOutput('status', composeHubStatus(base, ok.upstream)),
    hubStatusOutput('status', composeHubStatus(base, auth.upstream)),
    hubStatusOutput('status', composeHubStatus(base, dead.upstream)),
    hubStatusOutput('status', composeHubStatus(base, idle.upstream)),
    hubStatusOutput('status', base),
  ]
  const keys = outputs.map((value) => Object.keys(value).sort().join(','))
  for (const key of keys) assert.equal(key, keys[0], `字段集合不一致：\n${keys.join('\n')}`)
  for (const value of outputs) {
    for (const [field, fieldValue] of Object.entries(value)) {
      assert.notEqual(fieldValue, undefined, `字段 ${field} 是 undefined（应该是 null）`)
    }
  }
  for (const value of outputs) assertValid(CHROME_HUB_OUTPUT_SCHEMA, value, 'shape-stability')
})

test('P18 chrome_hub：错误路径 / stop 的输出也必须通过', async (base) => {
  // errJson 的形状：{ ok:false, action, error }
  assertValid(CHROME_HUB_OUTPUT_SCHEMA, { ok: false, action: 'status', error: 'boom' }, 'error')
  // stop：ok=true 但 ready=false
  const s = await baseStatus()
  const stopped = hubStatusOutput('stop', s, { ok: true, ready: false })
  assert.equal(stopped.ok, true)
  assert.equal(stopped.ready, false)
  assertValid(CHROME_HUB_OUTPUT_SCHEMA, stopped, 'stop')
})

// ── 旧 schema 的失败必须被这条用例钉住（修前会红） ─────────────────────────

test('P18 回归：旧声明（pausedReason: string 必填）在 ready 状态下确实会失败', async (t) => {
  const base = await baseStatus()
  const { upstream } = makeUpstream()
  t.after(() => upstream.stop())
  await upstream.ensureConnected()
  const out = hubStatusOutput('status', composeHubStatus(base, upstream))

  // 0.2.2 线上那版声明（导致 chrome_hub 不可用的元凶）
  const legacy = {
    type: 'object',
    additionalProperties: true,
    properties: {
      ok: { type: 'boolean' },
      action: { type: 'string' },
      ready: { type: 'boolean' },
      external: { type: 'boolean' },
      port: { type: 'number' },
      baseUrl: { type: 'string' },
      connects: { type: 'number' },
      disconnects: { type: 'number' },
      requests: { type: 'number' },
      errors: { type: 'number' },
      uptimeSec: { type: 'number' },
      paused: { type: 'boolean' },
      pausedReason: { type: 'string' },
      attempts: { type: 'number' },
      nextRetryMs: { type: 'number' },
      keepalives: { type: 'number' },
    },
  }
  const violations = validate(legacy, out)
  assert.ok(violations.length > 0, '旧声明必须在校验时失败——否则这条回归用例失效')
  assert.ok(
    violations.some((v) => v.includes('pausedReason')) && violations.some((v) => v.includes('nextRetryMs')),
    `旧声明的违规应命中 pausedReason/nextRetryMs，实际：${violations.join('; ')}`,
  )
  // 新声明对同一个值必须通过
  assertValid(CHROME_HUB_OUTPUT_SCHEMA, out, 'new-schema-same-value')
})

// ── 其它三个工具的输出契约 ────────────────────────────────────────────────

test('P18 chrome_page：成功 / 超时 / 错误三种 PageResult 都必须通过', () => {
  const ok = {
    ok: true,
    url: 'https://example.com/',
    title: 'Example',
    readyState: 'complete',
    result: { a: 1, list: [1, 2] },
    captured: [{ url: 'https://example.com/api', status: 200, bodyKeys: ['x'] }],
    consoleErrors: [],
    networkFailures: [],
  }
  assertValid(CHROME_PAGE_OUTPUT_SCHEMA, ok, 'page-ok')

  const failed = { ...ok, ok: false, error: '页面加载超时（60000ms，readyState 未 complete）' }
  assertValid(CHROME_PAGE_OUTPUT_SCHEMA, failed, 'page-timeout')

  // 表达式返回 null / 未截图：result=null 必须能过（旧 schema 没声明 result，靠 additionalProperties 兜）
  const minimal = {
    ok: true,
    url: 'about:blank',
    title: '',
    readyState: 'complete',
    result: null,
    captured: [],
    consoleErrors: [],
    networkFailures: [],
  }
  assertValid(CHROME_PAGE_OUTPUT_SCHEMA, minimal, 'page-result-null')
  // 错误路径
  assertValid(CHROME_PAGE_OUTPUT_SCHEMA, { ok: false, error: 'url 必填' }, 'page-error')
})

test('P18 chrome_cookies：有值 / includeValues 关闭 / 错误路径都必须通过', () => {
  assertValid(
    CHROME_COOKIES_OUTPUT_SCHEMA,
    { ok: true, total: 2, domains: 1, byDomain: { '.example.com': 2 }, samples: [{ name: 'sid', domain: '.example.com' }] },
    'cookies-ok',
  )
  assertValid(CHROME_COOKIES_OUTPUT_SCHEMA, { ok: true, total: 0, domains: 0, byDomain: {}, samples: [] }, 'cookies-empty')
  assertValid(CHROME_COOKIES_OUTPUT_SCHEMA, { ok: false, error: '上游未连接' }, 'cookies-error')
})

test('P18 chrome_cdp：result 为对象 / null / 标量 / 数组，以及错误路径都必须通过', () => {
  for (const result of [{ targetInfos: [] }, null, 0, 'text', [1, 2], true]) {
    assertValid(CHROME_CDP_OUTPUT_SCHEMA, { ok: true, method: 'Target.getTargets', result }, `cdp-result-${JSON.stringify(result)}`)
  }
  assertValid(CHROME_CDP_OUTPUT_SCHEMA, { ok: false, method: '', error: 'method 必填' }, 'cdp-error')
})

test('P18 verify_page：没截图时 screenshot=null、url/title 可能为 null 也必须通过', () => {
  // Python 报告原样返回：screenshot_path 为 None → JSON null（默认不截图时就是这种）
  const report = {
    ok: true,
    url: 'https://example.com/',
    title: 'Example',
    assertions: [{ index: 0, type: 'selector_visible', pass: true }],
    consoleErrors: [],
    networkErrors: [],
    screenshot: null,
  }
  assertValid(VERIFY_PAGE_OUTPUT_SCHEMA, report, 'verify-page-no-screenshot')

  // 页面求值拿不到 title/url 的边界
  assertValid(
    VERIFY_PAGE_OUTPUT_SCHEMA,
    { ok: false, url: null, title: null, assertions: [], consoleErrors: [], networkErrors: [], screenshot: null, error: '页面加载超时' },
    'verify-page-null-url',
  )
  // 无法解析报告 / 抛错两条错误路径
  assertValid(VERIFY_PAGE_OUTPUT_SCHEMA, { error: '无法解析验证报告', stdout: '', stderr: '' }, 'verify-page-unparsable')
  assertValid(VERIFY_PAGE_OUTPUT_SCHEMA, { error: 'browser-harness 缺失' }, 'verify-page-throw')

  // 旧声明（screenshot 必填 string）必须复现同类故障
  const legacy = {
    type: 'object',
    additionalProperties: true,
    properties: { ok: { type: 'boolean' }, url: { type: 'string' }, title: { type: 'string' }, screenshot: { type: 'string' } },
  }
  const violations = validate(legacy, { ok: true, url: 'https://example.com/', title: 'Example', screenshot: null })
  assert.ok(
    violations.some((v) => v.includes('screenshot')),
    `旧声明必须因 screenshot=null 失败，实际：${violations.join('; ')}`,
  )
})

test('P18 browser：成功 / 非零退出 / 错误路径都必须通过', () => {
  assertValid(BROWSER_OUTPUT_SCHEMA, { stdout: 'ok', stderr: '', exitCode: 0 }, 'browser-ok')
  assertValid(BROWSER_OUTPUT_SCHEMA, { stdout: '', stderr: 'boom', exitCode: 1 }, 'browser-fail')
  assertValid(BROWSER_OUTPUT_SCHEMA, { error: 'shell 不可用' }, 'browser-error')
})
