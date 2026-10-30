export interface ResolvedEndpoint {
    /** WebSocket 地址，形如 ws://127.0.0.1:9222/devtools/browser/<uuid>。 */
    wsUrl: string;
    /** 解析来源，便于排障：env / config / DevToolsActivePort / probe。 */
    source: string;
    /** 命中的用户数据目录（env/config 直连时为空）。 */
    profileDir?: string;
}
/** 各平台 Chrome 用户数据目录候选（按优先级）。 */
export declare function chromeProfileCandidates(): string[];
/** 读 DevToolsActivePort；文件缺失或内容不完整时返回 undefined。 */
export declare function readDevToolsActivePort(profileDir: string): {
    port: number;
    path: string;
} | undefined;
/**
 * 解析 CDP 端点。优先级：
 * 1. 显式 ws 地址（config.cdpWsUrl / 环境变量 DSH_CHROME_WS）
 * 2. 指定或默认的 profile 目录里的 DevToolsActivePort
 * 3. 常见端口探测（仅当 DevToolsActivePort 缺失时）
 */
export declare function resolveEndpoint(opts?: {
    profileDir?: string;
    cdpWsUrl?: string;
}): ResolvedEndpoint;
