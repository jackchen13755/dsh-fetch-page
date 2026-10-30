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
