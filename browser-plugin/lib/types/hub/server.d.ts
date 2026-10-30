/**
 * 本地 HTTP 侧车：把常驻 CDP 连接暴露成简单 HTTP/SSE 接口，供**插件之外**的
 * 脚本（bash 里的 node / curl）复用，从而不必各自直连 9222。
 *
 * 契约与历史 cdp-hub 保持一致：
 *   GET  /health                 → { ok, ready, connects, disconnects, requests, errors, upstream }
 *   GET  /cookies?domains=a,b    → { total, domains, cookies }
 *   GET  /targets                → Target.getTargets
 *   GET  /events                 → SSE 事件流
 *   GET  /json/version|/json/list→ 兼容旧的 HTTP 发现
 *   POST /cdp  { method, params?, sessionId? }
 *   POST /attach { targetId, flatten? }
 *
 * @module @deepseek-ai/dsh-tool-browser/hub/server
 */
import { type Server } from 'node:http';
import type { CdpUpstream } from './upstream.js';
export interface CookieSummary {
    total: number;
    domains: number;
    byDomain: Record<string, number>;
}
export interface ChromeCookie {
    name: string;
    value: string;
    domain: string;
    path?: string;
    expires?: number;
    secure?: boolean;
    httpOnly?: boolean;
    sameSite?: string;
}
export declare function summarizeCookies(cookies: ChromeCookie[]): CookieSummary;
/** 创建 HTTP 侧车（未 listen，交给调用方绑定端口）。 */
export declare function createHubServer(upstream: CdpUpstream, info: () => {
    startedAt: number;
}): Server;
