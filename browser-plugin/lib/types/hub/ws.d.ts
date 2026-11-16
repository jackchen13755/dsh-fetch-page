/** 握手阶段失败（区别于 TCP 层失败）：多半是 Chrome 的「允许远程调试吗」没被批准。 */
export interface HandshakeFailure extends Error {
    code: 'ws-handshake';
    stage: 'status' | 'closed' | 'timeout';
}
/** TCP 层失败（端口没开、被拒绝）：可以用退避重试。 */
export interface TransportFailure extends Error {
    code: 'ws-tcp';
}
export declare class MiniWebSocket {
    private socket;
    private buf;
    private handshakeResolved;
    private closed;
    private frag;
    private fragIsText;
    /** 收到一条完整文本消息。 */
    onText: ((text: string) => void) | null;
    /** 连接关闭（含对端 close 帧与网络错误）。 */
    onClose: ((code?: number, reason?: string) => void) | null;
    /** 建立连接并完成 HTTP Upgrade 握手。 */
    static connect(urlStr: string, opts?: {
        timeoutMs?: number;
    }): Promise<MiniWebSocket>;
    /** 发送一条文本消息。 */
    send(text: string): void;
    close(): void;
    get isClosed(): boolean;
    private writeFrame;
    private pump;
    private flushFrag;
    private finish;
}
