import type { HubStatus } from './index.js';
/** `string | null`。 */
export declare const nullableString: {
    readonly oneOf: readonly [{
        readonly type: "string";
    }, {
        readonly type: "null";
    }];
};
/** `number | null`。 */
export declare const nullableNumber: {
    readonly oneOf: readonly [{
        readonly type: "number";
    }, {
        readonly type: "null";
    }];
};
/**
 * `chrome_hub` 的输出：`status` / `start` / `stop` / 错误路径共用一张 schema。
 * 未声明的字段宿主不校验但会原样透出；这里把**实际会出现的字段**全声明，
 * 且可空字段一律可空，避免「某个状态就崩」。
 */
export declare const CHROME_HUB_OUTPUT_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: true;
    readonly properties: {
        readonly ok: {
            readonly type: "boolean";
        };
        readonly action: {
            readonly type: "string";
        };
        readonly ready: {
            readonly type: "boolean";
        };
        readonly external: {
            readonly type: "boolean";
        };
        readonly port: {
            readonly type: "number";
        };
        readonly baseUrl: {
            readonly type: "string";
        };
        readonly upstream: {
            readonly oneOf: readonly [{
                readonly type: "string";
            }, {
                readonly type: "null";
            }];
        };
        readonly source: {
            readonly oneOf: readonly [{
                readonly type: "string";
            }, {
                readonly type: "null";
            }];
        };
        readonly profileDir: {
            readonly oneOf: readonly [{
                readonly type: "string";
            }, {
                readonly type: "null";
            }];
        };
        readonly connects: {
            readonly type: "number";
        };
        readonly disconnects: {
            readonly type: "number";
        };
        readonly requests: {
            readonly type: "number";
        };
        readonly keepalives: {
            readonly type: "number";
        };
        readonly errors: {
            readonly type: "number";
        };
        readonly lastError: {
            readonly oneOf: readonly [{
                readonly type: "string";
            }, {
                readonly type: "null";
            }];
        };
        readonly lastConnectedAt: {
            readonly oneOf: readonly [{
                readonly type: "string";
            }, {
                readonly type: "null";
            }];
        };
        readonly uptimeSec: {
            readonly type: "number";
        };
        readonly paused: {
            readonly type: "boolean";
        };
        readonly pausedReason: {
            readonly oneOf: readonly [{
                readonly type: "string";
            }, {
                readonly type: "null";
            }];
        };
        readonly attempts: {
            readonly type: "number";
        };
        readonly nextRetryMs: {
            readonly oneOf: readonly [{
                readonly type: "number";
            }, {
                readonly type: "null";
            }];
        };
        readonly hint: {
            readonly type: "string";
        };
        readonly error: {
            readonly type: "string";
        };
    };
};
/** `chrome_cookies`：成功路径带统计 + samples；错误路径只有 ok/error。 */
export declare const CHROME_COOKIES_OUTPUT_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: true;
    readonly properties: {
        readonly ok: {
            readonly type: "boolean";
        };
        readonly total: {
            readonly type: "number";
        };
        readonly domains: {
            readonly type: "number";
        };
        readonly byDomain: {
            readonly type: "object";
            readonly additionalProperties: true;
        };
        readonly samples: {
            readonly type: "array";
        };
        readonly error: {
            readonly type: "string";
        };
    };
};
/**
 * `chrome_page`：`result` / `screenshotPath` / `error` 都是**可选**的（不设置时键缺省，
 * 宿主跳过缺失属性）；但 `result` 的取值由页面表达式决定，只能声明成任意 JSON。
 */
export declare const CHROME_PAGE_OUTPUT_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: true;
    readonly properties: {
        readonly ok: {
            readonly type: "boolean";
        };
        readonly url: {
            readonly type: "string";
        };
        readonly title: {
            readonly type: "string";
        };
        readonly readyState: {
            readonly type: "string";
        };
        readonly result: {
            readonly type: "json";
        };
        readonly screenshotPath: {
            readonly type: "string";
        };
        readonly captured: {
            readonly type: "array";
        };
        readonly consoleErrors: {
            readonly type: "array";
        };
        readonly networkFailures: {
            readonly type: "array";
        };
        readonly error: {
            readonly type: "string";
        };
    };
};
/**
 * `chrome_cdp`：`result` 是任意 CDP 返回值（可能是 null / 数组 / 标量），
 * 因此不能声明具体类型；错误路径只有 ok/method/error。
 */
export declare const CHROME_CDP_OUTPUT_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: true;
    readonly properties: {
        readonly ok: {
            readonly type: "boolean";
        };
        readonly method: {
            readonly type: "string";
        };
        readonly result: {
            readonly type: "json";
        };
        readonly error: {
            readonly type: "string";
        };
    };
};
/**
 * 把 `HubStatus` 归一成工具输出：**每个字段都显式给值**（不适用就 null）。
 * 这样 `chrome_hub` 的返回形状在 ready / paused(auth|failures|idle) / connecting
 * 五种状态下完全一致，schema 也就能用同一份声明覆盖全部状态。
 */
export declare function hubStatusOutput(action: string, status: HubStatus, extra?: Record<string, unknown>): Record<string, unknown>;
/** `browser`：跑一段 Python 的 stdout/stderr/exitCode。 */
export declare const BROWSER_OUTPUT_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: true;
    readonly properties: {
        readonly stdout: {
            readonly type: "string";
        };
        readonly stderr: {
            readonly type: "string";
        };
        readonly exitCode: {
            readonly type: "number";
        };
        readonly error: {
            readonly type: "string";
        };
    };
};
/** `verify_page`：断言报告；`screenshot` 在没截图时是 null。 */
export declare const VERIFY_PAGE_OUTPUT_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: true;
    readonly properties: {
        readonly ok: {
            readonly type: "boolean";
        };
        readonly url: {
            readonly oneOf: readonly [{
                readonly type: "string";
            }, {
                readonly type: "null";
            }];
        };
        readonly title: {
            readonly oneOf: readonly [{
                readonly type: "string";
            }, {
                readonly type: "null";
            }];
        };
        readonly assertions: {
            readonly type: "array";
        };
        readonly consoleErrors: {
            readonly type: "array";
        };
        readonly networkErrors: {
            readonly type: "array";
        };
        readonly screenshot: {
            readonly oneOf: readonly [{
                readonly type: "string";
            }, {
                readonly type: "null";
            }];
        };
        readonly error: {
            readonly type: "string";
        };
        readonly stdout: {
            readonly type: "string";
        };
        readonly stderr: {
            readonly type: "string";
        };
    };
};
