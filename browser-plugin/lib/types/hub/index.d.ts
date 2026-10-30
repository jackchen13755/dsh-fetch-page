import { type ChromeCookie, type CookieSummary } from './server.js';
export interface HubOptions {
    /** HTTP 侧车端口，默认 9334；设为 0 表示不开侧车。 */
    port?: number;
    /** 指定 Chrome 用户数据目录（默认按平台推断）。 */
    profileDir?: string;
    /** 直接指定 CDP WebSocket 地址（优先于 profileDir）。 */
    cdpWsUrl?: string;
    /** 请求超时。 */
    requestTimeoutMs?: number;
    /** 等待 Chrome 授权的超时。 */
    readyTimeoutMs?: number;
}
export interface HubStatus {
    ready: boolean;
    /** true = 端口上已有别的 hub 在跑，本插件复用它而不是抢端口。 */
    external: boolean;
    port: number;
    baseUrl: string;
    upstream: string | null;
    source: string | null;
    profileDir: string | null;
    connects: number;
    disconnects: number;
    requests: number;
    errors: number;
    lastError: string | null;
    lastConnectedAt: string | null;
    uptimeSec: number;
}
export interface PageResult {
    ok: boolean;
    url: string;
    title: string;
    readyState: string;
    result?: unknown;
    screenshotPath?: string;
    captured: Array<{
        url: string;
        status: number;
        bodyKeys?: string[];
        bodyText?: string;
    }>;
    consoleErrors: string[];
    networkFailures: string[];
    error?: string;
}
export declare class ChromeHub {
    private upstream;
    private server;
    private startedAt;
    private externalBase;
    private ensureInflight;
    private readonly port;
    private readonly opts;
    constructor(opts?: HubOptions);
    get baseUrl(): string;
    /** 确保连接可用（必要时建立连接并开侧车）。幂等。 */
    ensure(): Promise<HubStatus>;
    private doEnsure;
    private ensureServer;
    /** 当前状态（不主动建立连接；若端口上有外部 hub 就报它的状态）。 */
    status(): Promise<HubStatus>;
    private statusFromExternal;
    stop(): Promise<void>;
    /** 发一条 CDP 命令：本进程持有上游则直连，否则走外部 hub 的 HTTP。 */
    call(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
    cookies(domains?: string): Promise<{
        summary: CookieSummary;
        cookies: ChromeCookie[];
    }>;
    /** 订阅事件（本进程持有上游时直接订阅；外部模式下退回 SSE）。 */
    onEvent(sink: (msg: Record<string, unknown>) => void): () => void;
    /**
     * 页面驱动：开标签页 → 等加载/选择器 → 求值 → 可选截图与响应体抓取 → 关标签页。
     */
    page(spec: {
        url: string;
        expr?: string;
        waitForSelector?: string;
        timeoutMs?: number;
        capture?: string;
        screenshotPath?: string;
        keep?: boolean;
        viewport?: {
            width: number;
            height: number;
        };
    }): Promise<PageResult>;
}
