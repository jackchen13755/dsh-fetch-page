/** `null` 分支：配合 `oneOf` 表达「本状态不适用」。 */
const NULL_BRANCH = { type: 'null' };
/** `string | null`。 */
export const nullableString = { oneOf: [{ type: 'string' }, NULL_BRANCH] };
/** `number | null`。 */
export const nullableNumber = { oneOf: [{ type: 'number' }, NULL_BRANCH] };
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
};
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
};
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
};
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
};
/**
 * 把 `HubStatus` 归一成工具输出：**每个字段都显式给值**（不适用就 null）。
 * 这样 `chrome_hub` 的返回形状在 ready / paused(auth|failures|idle) / connecting
 * 五种状态下完全一致，schema 也就能用同一份声明覆盖全部状态。
 */
export function hubStatusOutput(action, status, extra = {}) {
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
    };
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
};
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
};
//# sourceMappingURL=tool-schemas.js.map