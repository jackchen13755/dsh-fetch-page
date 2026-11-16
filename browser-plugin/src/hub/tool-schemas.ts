/**
 * chrome_* 工具的 **输出契约**（output.schema + 状态归一化）。
 *
 * 为什么单独成模块：宿主的 schema 校验是「声明了就一定校验」的——`pausedReason`
 * 一旦声明成 `{type:'string'}` 而实现给出 `null`，`chrome_hub` 在**正常已连接**状态下
 * 都会抛 `returned invalid output`，工具直接不可用（真实踩过）。
 * 把 schema 与「怎么把 HubStatus 归一成输出」放在一起并导出，测试才能用宿主同一套
 * 校验器（`validateJsonSchemaValue`）覆盖**每一个**健康状态。
 *
 * 设计选择（三选一，选 B）：
 *   A. 省略为 null 的字段 → 脚本侧变成 `undefined`，JSON 形状随状态漂移；
 *   B. 显式声明可空（`oneOf: [{type:'string'},{type:'null'}]`）→ 字段**恒定存在**，
 *      `null` 明确表示「本状态不适用」，TS/Py SDK 分别渲染成 `string | null` /
 *      `Union[str, None]`（已核对 dsh-tools 的 renderer），宿主 DSL/校验器原生支持 oneOf；
 *   C. 用哨兵值（'' / -1）→ 与真实取值混淆，脚本还得自己记哨兵表。
 * 取 B：形状在所有状态下恒定、没有 undefined 陷阱、也不引入假值。
 *
 * 注意 `as const satisfies ValueSchemaSpec`：`const` 保住字面量类型（defineTool 靠它
 * 推导输出类型），`satisfies` 保证形状仍受宿主 DSL 约束。
 *
 * 本模块同时收录两个**非 hub** 工具的 output 契约（`browser` / `verify_page`）：
 * 它们是同一类缺陷的受害者（`verify_page` 的 Python 报告在没有截图时
 * `screenshot: None` → JSON null，而 schema 声明成必填 string），一并收口，别再各写一份。
 *
 * @module @deepseek-ai/dsh-tool-browser/hub/tool-schemas
 */
import type { ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { HubStatus } from './index.js'

/** `null` 分支：配合 `oneOf` 表达「本状态不适用」。 */
const NULL_BRANCH = { type: 'null' } as const

/** `string | null`。 */
export const nullableString = { oneOf: [{ type: 'string' } as const, NULL_BRANCH] } as const
/** `number | null`。 */
export const nullableNumber = { oneOf: [{ type: 'number' } as const, NULL_BRANCH] } as const

/**
 * `chrome_hub` 的输出：`status` / `start` / `stop` / 错误路径共用一张 schema。
 * 未声明的字段宿主不校验但会原样透出；这里把**实际会出现的字段**全声明，
 * 且可空字段一律可空，避免「某个状态就崩」。
 */
export const CHROME_HUB_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    action: { type: 'string' },
    // —— HubStatus（ChromeHub.status() 的全量字段）——
    ready: { type: 'boolean' },
    external: { type: 'boolean' },
    port: { type: 'number' },
    baseUrl: { type: 'string' },
    upstream: nullableString,
    source: nullableString,
    profileDir: nullableString,
    connects: { type: 'number' },
    disconnects: { type: 'number' },
    requests: { type: 'number' },
    keepalives: { type: 'number' },
    errors: { type: 'number' },
    lastError: nullableString,
    lastConnectedAt: nullableString,
    uptimeSec: { type: 'number' },
    paused: { type: 'boolean' },
    pausedReason: nullableString,
    attempts: { type: 'number' },
    nextRetryMs: nullableNumber,
    // —— 错误路径 / start 的补充字段 ——
    hint: { type: 'string' },
    error: { type: 'string' },
  },
} as const satisfies ValueSchemaSpec

/** `chrome_cookies`：成功路径带统计 + samples；错误路径只有 ok/error。 */
export const CHROME_COOKIES_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    total: { type: 'number' },
    domains: { type: 'number' },
    byDomain: { type: 'object', additionalProperties: true },
    samples: { type: 'array' },
    error: { type: 'string' },
  },
} as const satisfies ValueSchemaSpec

/**
 * `chrome_page`：`result` / `screenshotPath` / `error` 都是**可选**的（不设置时键缺省，
 * 宿主跳过缺失属性）；但 `result` 的取值由页面表达式决定，只能声明成任意 JSON。
 */
export const CHROME_PAGE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    url: { type: 'string' },
    title: { type: 'string' },
    readyState: { type: 'string' },
    result: { type: 'json' },
    screenshotPath: { type: 'string' },
    captured: { type: 'array' },
    consoleErrors: { type: 'array' },
    networkFailures: { type: 'array' },
    error: { type: 'string' },
  },
} as const satisfies ValueSchemaSpec

/**
 * `chrome_cdp`：`result` 是任意 CDP 返回值（可能是 null / 数组 / 标量），
 * 因此不能声明具体类型；错误路径只有 ok/method/error。
 */
export const CHROME_CDP_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    method: { type: 'string' },
    result: { type: 'json' },
    error: { type: 'string' },
  },
} as const satisfies ValueSchemaSpec

/**
 * 把 `HubStatus` 归一成工具输出：**每个字段都显式给值**（不适用就 null）。
 * 这样 `chrome_hub` 的返回形状在 ready / paused(auth|failures|idle) / connecting
 * 五种状态下完全一致，schema 也就能用同一份声明覆盖全部状态。
 */
export function hubStatusOutput(
  action: string,
  status: HubStatus,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ok: true,
    action,
    ready: status.ready,
    external: status.external,
    port: status.port,
    baseUrl: status.baseUrl,
    upstream: status.upstream ?? null,
    source: status.source ?? null,
    profileDir: status.profileDir ?? null,
    connects: status.connects,
    disconnects: status.disconnects,
    requests: status.requests,
    keepalives: status.keepalives ?? 0,
    errors: status.errors,
    lastError: status.lastError ?? null,
    lastConnectedAt: status.lastConnectedAt ?? null,
    uptimeSec: status.uptimeSec,
    paused: status.paused,
    pausedReason: status.pausedReason ?? null,
    attempts: status.attempts,
    nextRetryMs: status.nextRetryMs ?? null,
    ...extra,
  }
}

// ── 非 hub 工具（browser-harness）的输出契约 ────────────────────────────────
// 同一类缺陷：`verify_page` 的 Python 报告里 `screenshot` 在「没截图」时是 None，
// `url`/`title` 取决于页面求值，也可能为 None —— 原来都声明成必填 string，会炸。

/** `browser`：跑一段 Python 的 stdout/stderr/exitCode。 */
export const BROWSER_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    stdout: { type: 'string' },
    stderr: { type: 'string' },
    exitCode: { type: 'number' },
    error: { type: 'string' },
  },
} as const satisfies ValueSchemaSpec

/** `verify_page`：断言报告；`screenshot` 在没截图时是 null。 */
export const VERIFY_PAGE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    url: nullableString,
    title: nullableString,
    assertions: { type: 'array' },
    consoleErrors: { type: 'array' },
    networkErrors: { type: 'array' },
    screenshot: nullableString,
    error: { type: 'string' },
    stdout: { type: 'string' },
    stderr: { type: 'string' },
  },
} as const satisfies ValueSchemaSpec
