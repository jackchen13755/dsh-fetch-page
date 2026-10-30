/**
 * CDP 上游连接：一条常驻 WebSocket 到用户主 Chrome，负责请求/响应关联、
 * 事件广播、保活与断线重连。
 *
 * 「一条连接」是关键：Chrome 的授权粒度是每条 WebSocket 一次，复用同一条
 * 连接才能把「要允许远程调试吗」压到每个 Chrome 会话一次。
 *
 * @module @deepseek-ai/dsh-tool-browser/hub/upstream
 */
import { type ResolvedEndpoint } from './platform.js';
export interface UpstreamStats {
    connects: number;
    disconnects: number;
    requests: number;
    errors: number;
    lastError: string | null;
    lastConnectedAt: string | null;
}
type EventSink = (msg: Record<string, unknown>) => void;
export declare class CdpUpstream {
    private readonly opts;
    private ws;
    private ready;
    private nextId;
    private pending;
    private readyWaiters;
    private keepaliveTimer;
    private reconnectTimer;
    private stopping;
    private sinks;
    readonly stats: UpstreamStats;
    endpoint: ResolvedEndpoint | null;
    constructor(opts?: {
        profileDir?: string;
        cdpWsUrl?: string;
        requestTimeoutMs?: number;
        readyTimeoutMs?: number;
        keepaliveMs?: number;
    });
    get isReady(): boolean;
    /** 建立连接（幂等：已就绪则直接返回）。 */
    ensureConnected(): Promise<void>;
    /** 订阅上游事件（不含响应帧）。 */
    onEvent(sink: EventSink): () => void;
    send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
    stop(): void;
    private spawn;
    private handleText;
    private handleClose;
    private scheduleReconnect;
    private startKeepalive;
    private waitReady;
    private flushWaiters;
    private rejectWaiters;
    private failAllPending;
}
export {};
