import { prettyPath, type ResolvedEndpoint } from './platform.js';
export interface UpstreamStats {
    connects: number;
    disconnects: number;
    requests: number;
    /** keepalive 单独计数：健康探测不该把 `requests` 的语义搅浑。 */
    keepalives: number;
    errors: number;
    lastError: string | null;
    lastConnectedAt: string | null;
}
/** WebSocket 的最小接口：MiniWebSocket 与测试里的 fake socket 都满足。 */
export interface UpstreamSocket {
    onText: ((text: string) => void) | null;
    onClose: ((code?: number, reason?: string) => void) | null;
    send(text: string): void;
    close(): void;
    /** 已关闭为 true：adopt 前用它兜住「握手 resolve 后立刻被关」的窗口（P3）。 */
    readonly isClosed?: boolean;
}
export type PausedReason = 'failures' | 'idle' | 'auth';
/** /health 用的真实上游状态（不再恒 ok:true）。 */
export interface UpstreamHealth {
    ready: boolean;
    paused: boolean;
    pausedReason: PausedReason | null;
    /** 连续失败次数（握手成功即清零）。 */
    attempts: number;
    lastError: string | null;
    /** 距离下一次自动重试还有多久（ms）；无排期时为 null。 */
    nextRetryMs: number | null;
    lastAttemptAt: string | null;
    /** 距最后一次客户端需求过了多久（ms）；从未有过需求时为 null。 */
    idleForMs: number | null;
    /** 授权暂停后端点（端口/uuid）是否已经变化（变了就允许再试一次）。 */
    endpointChanged: boolean;
}
export interface BackoffOptions {
    baseMs?: number;
    maxMs?: number;
    jitter?: number;
}
/** 唤醒源注入点（宿主自定义 / 测试用，避免依赖进程级广播）。 */
export interface WakeEmitter {
    name: string;
    subscribe: (cb: () => void) => () => void;
    /** 'wake' = 直接当唤醒处理；'hint' = 只有时间差证明真的睡过才算（默认 wake）。 */
    mode?: 'wake' | 'hint';
}
export interface UpstreamOptions {
    profileDir?: string;
    cdpWsUrl?: string;
    requestTimeoutMs?: number;
    readyTimeoutMs?: number;
    keepaliveMs?: number;
    /** keepalive 看门狗：发出后多久无回包判定半开（默认 10000ms）。 */
    keepaliveWatchdogMs?: number;
    /** 退避基数（默认 1500ms）。 */
    backoffBaseMs?: number;
    /** 退避上限（默认 60000ms）。 */
    backoffMaxMs?: number;
    /** 抖动比例，0~1/3（默认 0.2 = ±20%）。 */
    backoffJitter?: number;
    /** 网络类失败连续多少次进入 paused（默认 5）。 */
    maxAttempts?: number;
    /** 端口预探测超时（默认 500ms）。 */
    portProbeTimeoutMs?: number;
    /** 空闲多久无客户端需求就主动断开（默认 600000ms = 10 分钟）。 */
    idleMs?: number;
    /** paused(failures) 后客户端重试的冷却（默认 3000ms）。 */
    resumeCooldownMs?: number;
    /** paused(auth) 后客户端重试的冷却（默认 30000ms，明显更严，避免轮询脚本每轮一弹窗）。 */
    authCooldownMs?: number;
    /** 唤醒时「需求」还算新鲜的时间窗（默认 120000ms）。 */
    wakeDemandMs?: number;
    /** 时间差超过多少视为系统睡过（默认 120000ms）。 */
    wakeGapMs?: number;
    /** 唤醒兜底检查的节拍（默认 5000ms）。 */
    heartbeatMs?: number;
    /** 连接活过多久算「健康」；短于它就当一次失败计入退避（默认 10000ms）。 */
    flapMs?: number;
    /** 是否订阅宿主级唤醒事件（powerMonitor.resume / SIGCONT）。测试可关掉（默认 true）。 */
    attachSystemWake?: boolean;
    /** 额外的唤醒源（注入式，测试/自定义宿主用）。 */
    wakeEmitters?: WakeEmitter[];
    /** 结构化日志出口（默认写 stderr，保持 stdout 可被脚本解析）。 */
    log?: (line: string) => void;
    /** 测试钩子：替换 WS 握手。 */
    connect?: (wsUrl: string, opts: {
        timeoutMs?: number;
    }) => Promise<UpstreamSocket>;
    /** 测试钩子：替换 TCP 端口探测。 */
    probePort?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
    /** 测试钩子：替换端点解析。 */
    resolveEndpointFn?: (opts: {
        profileDir?: string;
        cdpWsUrl?: string;
    }) => ResolvedEndpoint;
    /** 测试钩子：替换时钟。 */
    now?: () => number;
}
type EventSink = (msg: Record<string, unknown>) => void;
export declare const BACKOFF_BASE_MS = 1500;
export declare const BACKOFF_MAX_MS = 60000;
export declare const BACKOFF_JITTER = 0.2;
/** 抖动硬上限：超过 1/3 就无法保证相邻延迟单调递增（(1-j)·2 > (1+j) ⇔ j < 1/3）。 */
export declare const BACKOFF_MAX_JITTER: number;
export declare const MAX_ATTEMPTS = 5;
export declare const RESUME_COOLDOWN_MS = 3000;
export declare const AUTH_COOLDOWN_MS = 30000;
export declare const IDLE_MS = 600000;
export declare const WAKE_GAP_MS = 120000;
export declare const WAKE_DEMAND_MS = 120000;
export declare const PORT_PROBE_TIMEOUT_MS = 500;
export declare const KEEPALIVE_WATCHDOG_MS = 10000;
/**
 * 第 attempt 次失败后的等待时长（attempt 从 1 开始）：1500 → 3000 → … → 上限，
 * 再叠抖动。抖动被 clamp 到 1/3 以内，保证相邻延迟严格递增。
 */
export declare function backoffDelayMs(attempt: number, opts?: BackoffOptions, random?: () => number): number;
/** TCP 探活：端口有监听返回 true（超时内连不上按未监听处理）。 */
export declare function probeTcpPort(host: string, port: number, timeoutMs?: number): Promise<boolean>;
/** 脱敏：`<uuid>` 只留前 8 位，home 目录缩成 `~`。 */
export declare function sanitizeText(text: string, homeDir?: string): string;
/** 授权类失败：TCP 通了但 WS 握手没成功（Chrome 在等/拒绝「允许远程调试吗」）。 */
export declare function isAuthFailure(error: unknown): boolean;
/**
 * 严格解析 ws:// 端点：显式端口必须是 1..65535 的整数，非法就报错，
 * **绝不静默回落**（开发机上 9222 常另有 Chrome，回落 = 连错浏览器）。
 */
export declare function parseEndpointUrl(wsUrl: string): {
    ok: true;
    host: string;
    port: number;
} | {
    ok: false;
    reason: string;
};
export declare class CdpUpstream {
    private readonly opts;
    private ws;
    private countedSocket;
    private connecting;
    /** P13：attemptConnect 正在跑（同步段也算），用于挡住任何重入。 */
    private connectInFlight;
    private ready;
    private nextId;
    private pending;
    private keepaliveTimer;
    private heartbeatTimer;
    private reconnectTimer;
    private stopping;
    private sinks;
    /** 连续失败次数（握手成功清零）。 */
    private attempts;
    private paused;
    private pausedReason;
    private nextRetryAt;
    /** 本次 attempt 之前等待了多久（只用于日志）。 */
    private scheduledDelayMs;
    private lastAttemptAt;
    private lastNeedAt;
    private connectedAt;
    /** 连续「握手成功但立刻被断」的次数（活过 flapMs 才清零）。 */
    private shortLived;
    private lastTick;
    /** true = 这次尝试是 paused 后被客户端显式放行的那一次；失败要立刻回 paused。 */
    private resumedFromPause;
    private resumeReason;
    /** 授权失败时用的端点，用于判断「端点是否已经变了」。 */
    private authFailedEndpoint;
    private malformedFrames;
    private detachWakeHooks;
    readonly stats: UpstreamStats;
    endpoint: ResolvedEndpoint | null;
    private readonly backoffBaseMs;
    private readonly backoffMaxMs;
    private readonly backoffJitter;
    private readonly maxAttempts;
    private readonly portProbeTimeoutMs;
    private readonly idleMs;
    private readonly resumeCooldownMs;
    private readonly authCooldownMs;
    private readonly wakeDemandMs;
    private readonly wakeGapMs;
    private readonly heartbeatMs;
    private readonly flapMs;
    private readonly onLog;
    constructor(opts?: UpstreamOptions);
    get isReady(): boolean;
    get isPaused(): boolean;
    /** /health 用：上游真实状态。 */
    get health(): UpstreamHealth;
    private now;
    /**
     * 记录一次客户端需求（对外公开：`/events` 的订阅者/心跳也要续期，见 P7）。
     */
    noteDemand(): void;
    /**
     * 建立连接（幂等 + 单飞）：并发调用共用同一条在途连接，任意时刻最多一条 socket。
     * paused 时只有客户端显式请求（或端点已变化）才放行一次新尝试：
     * - failures / idle：冷却 resumeCooldownMs；
     * - auth：冷却 authCooldownMs，更严（避免轮询脚本每轮一次弹窗）。
     */
    ensureConnected(): Promise<void>;
    /**
     * 单飞槽的唯一入口：任何时刻最多一条在途尝试。
     * 已有一条在途时直接复用它的 promise（不新开 socket）。
     */
    private startAttempt;
    /** 订阅上游事件（不含响应帧）。 */
    onEvent(sink: EventSink): () => void;
    send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
    stop(): void;
    /**
     * 单次连接尝试：严格解析端点 → 端口预探测 → WS 握手 → adopt 前 liveness 校验。
     * 失败按类别记账：授权类首次即 paused(auth)，其它按指数退避。
     */
    private attemptConnect;
    private runAttempt;
    /** 接管一条握手成功的 socket（唯一入口，确保 handlers 都带身份校验）。 */
    private adoptSocket;
    /** 统一关闭路径：先置空 this.ws（让旧 socket 的后续事件被身份校验挡掉）。 */
    private closeCurrent;
    private handleClose;
    private scheduleReconnect;
    private retryTick;
    /** 网络类/端点类失败：按指数退避重试，到上限后 paused(failures)。 */
    private recordFailure;
    /**
     * 授权类失败（P2）：TCP 可达但握手没成功，第 1 次就暂停。
     * 这类失败「等一会儿」不会自己好——用户没点允许、或 uuid 已过期——重试只会多弹一次窗。
     */
    private recordAuthFailure;
    private pause;
    /** paused 时客户端显式请求的唯一放行口。 */
    private resumeIfPaused;
    private pausedError;
    private hasDemand;
    private backoffOptions;
    private probePort;
    private connectSocket;
    private resolveCurrentEndpoint;
    /** 授权暂停后端点是否已经变化（端口/uuid 变了说明用户重新开了远程调试）。 */
    private endpointSignatureChanged;
    private sanitize;
    private logAttempt;
    private request;
    private handleText;
    private dropMalformedFrame;
    private startKeepalive;
    /** S6：Browser.getVersion 看门狗——10s 无回包/报错就判定半开并走统一重连。 */
    private keepaliveTick;
    private startHeartbeat;
    /**
     * S5 + S7 兜底：检测系统睡眠（时间差）并处理空闲断开。
     * 取不到 powerMonitor/SIGCONT 时，只有这里能让 hub 在唤醒后自愈。
     */
    private heartbeatTick;
    /** 时间差兜底的睡眠检测：睡过就按唤醒处理（重置退避 + 单次重建）。 */
    private detectWake;
    /**
     * 系统唤醒（P1）：重置退避计数，**最多**发起一次重建，且必须先满足
     * 「有新鲜需求」或「唤醒前处于 ready」；授权暂停永不被唤醒解除。
     */
    private handleWake;
    /** SIGCONT 等「进程级广播」只当提示：必须由时间差证明真的睡过，才升级为唤醒。 */
    private onWakeHint;
    private attachWakeHooks;
    private detachWake;
    private clearTimer;
    private failAllPending;
}
export { prettyPath };
