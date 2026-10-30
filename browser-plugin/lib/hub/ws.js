/**
 * 最小 WebSocket 客户端（RFC 6455，仅客户端、仅文本帧）。
 *
 * 为什么要自己写：本插件跑在宿主进程（Electron）里，宿主 Node 版本不保证有全局
 * `WebSocket`（Node 22 才有），而 Chrome 的 `chrome://inspect` 端点只认 WebSocket。
 * 用 `node:net` 手写 130 行即可，零依赖、跨 Node 版本、跨平台一致。
 *
 * 覆盖范围：握手、masked 文本帧发送、分片接收、ping/pong、close。
 * 不支持：扩展（permessage-deflate）、二进制帧的业务使用（仅忽略）。
 *
 * @module @deepseek-ai/dsh-tool-browser/hub/ws
 */
import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
const OP_TEXT = 0x1;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;
export class MiniWebSocket {
    socket = null;
    buf = Buffer.alloc(0);
    handshakeResolved = false;
    closed = false;
    frag = [];
    fragIsText = false;
    /** 收到一条完整文本消息。 */
    onText = null;
    /** 连接关闭（含对端 close 帧与网络错误）。 */
    onClose = null;
    /** 建立连接并完成 HTTP Upgrade 握手。 */
    static connect(urlStr, opts = {}) {
        const url = new URL(urlStr);
        if (url.protocol !== 'ws:')
            throw new Error(`只支持 ws:// 端点，收到 ${url.protocol}`);
        const host = url.hostname;
        const port = Number(url.port || 80);
        const pathPart = `${url.pathname || '/'}${url.search}`;
        const key = randomBytes(16).toString('base64');
        const timeoutMs = opts.timeoutMs ?? 15000;
        const ws = new MiniWebSocket();
        const socket = connect({ host, port });
        ws.socket = socket;
        socket.setNoDelay(true);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                socket.destroy();
                reject(new Error(`连接 Chrome CDP 超时（${timeoutMs}ms）：${urlStr}`));
            }, timeoutMs);
            timer.unref?.();
            const fail = (err) => {
                clearTimeout(timer);
                socket.destroy();
                reject(err);
            };
            socket.once('error', fail);
            socket.once('connect', () => {
                socket.write(`GET ${pathPart} HTTP/1.1\r\n` +
                    `Host: ${host}:${port}\r\n` +
                    'Upgrade: websocket\r\n' +
                    'Connection: Upgrade\r\n' +
                    `Sec-WebSocket-Key: ${key}\r\n` +
                    'Sec-WebSocket-Version: 13\r\n' +
                    '\r\n');
            });
            // 握手响应 + 后续帧都从同一路数据里切
            const onData = (chunk) => {
                ws.buf = Buffer.concat([ws.buf, chunk]);
                if (!ws.handshakeResolved) {
                    const end = ws.buf.indexOf('\r\n\r\n');
                    if (end < 0)
                        return;
                    const head = ws.buf.subarray(0, end).toString('latin1');
                    ws.buf = ws.buf.subarray(end + 4);
                    const statusLine = head.split('\r\n')[0] ?? '';
                    if (!/^HTTP\/1\.1 101/.test(statusLine)) {
                        fail(new Error(`WebSocket 握手失败：${statusLine}`));
                        return;
                    }
                    ws.handshakeResolved = true;
                    clearTimeout(timer);
                    socket.removeListener('error', fail);
                    socket.on('error', (e) => ws.finish(undefined, e.message));
                    resolve(ws);
                    ws.pump();
                    return;
                }
                ws.pump();
            };
            socket.on('data', onData);
            socket.on('close', () => ws.finish());
        });
    }
    /** 发送一条文本消息。 */
    send(text) {
        if (this.closed)
            throw new Error('WebSocket 已关闭');
        this.writeFrame(OP_TEXT, Buffer.from(text, 'utf8'));
    }
    close() {
        if (this.closed)
            return;
        try {
            this.writeFrame(OP_CLOSE, Buffer.alloc(0));
        }
        catch {
            /* ignore */
        }
        this.finish(1000, 'client close');
    }
    get isClosed() {
        return this.closed;
    }
    writeFrame(opcode, payload) {
        const socket = this.socket;
        if (!socket || this.closed)
            return;
        const len = payload.length;
        let header;
        if (len < 126) {
            header = Buffer.alloc(2);
            header[1] = 0x80 | len;
        }
        else if (len <= 0xffff) {
            header = Buffer.alloc(4);
            header[1] = 0x80 | 126;
            header.writeUInt16BE(len, 2);
        }
        else {
            header = Buffer.alloc(10);
            header[1] = 0x80 | 127;
            header.writeBigUInt64BE(BigInt(len), 2);
        }
        header[0] = 0x80 | opcode; // FIN + opcode
        const mask = randomBytes(4);
        const masked = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i += 1)
            masked[i] = payload[i] ^ mask[i & 3];
        socket.write(Buffer.concat([header, mask, masked]));
    }
    pump() {
        for (;;) {
            if (this.buf.length < 2)
                return;
            const b0 = this.buf[0];
            const b1 = this.buf[1];
            const fin = (b0 & 0x80) !== 0;
            const opcode = b0 & 0x0f;
            const masked = (b1 & 0x80) !== 0;
            let len = b1 & 0x7f;
            let off = 2;
            if (len === 126) {
                if (this.buf.length < off + 2)
                    return;
                len = this.buf.readUInt16BE(off);
                off += 2;
            }
            else if (len === 127) {
                if (this.buf.length < off + 8)
                    return;
                len = Number(this.buf.readBigUInt64BE(off));
                off += 8;
            }
            let maskKey = null;
            if (masked) {
                if (this.buf.length < off + 4)
                    return;
                maskKey = this.buf.subarray(off, off + 4);
                off += 4;
            }
            if (this.buf.length < off + len)
                return;
            const payload = this.buf.subarray(off, off + len);
            this.buf = this.buf.subarray(off + len);
            let data = payload;
            if (maskKey) {
                const un = Buffer.allocUnsafe(len);
                for (let i = 0; i < len; i += 1)
                    un[i] = payload[i] ^ maskKey[i & 3];
                data = un;
            }
            if (opcode === OP_CLOSE) {
                const code = data.length >= 2 ? data.readUInt16BE(0) : undefined;
                const reason = data.length > 2 ? data.subarray(2).toString('utf8') : undefined;
                this.finish(code, reason);
                return;
            }
            if (opcode === OP_PING) {
                this.writeFrame(OP_PONG, data);
                continue;
            }
            if (opcode === OP_PONG)
                continue;
            if (opcode === OP_TEXT) {
                this.frag = [Buffer.from(data)];
                this.fragIsText = true;
                if (fin)
                    this.flushFrag();
                continue;
            }
            if (opcode === 0x0) {
                this.frag.push(Buffer.from(data));
                if (fin)
                    this.flushFrag();
                continue;
            }
            // 二进制帧：本插件不消费，忽略
        }
    }
    flushFrag() {
        const full = Buffer.concat(this.frag);
        this.frag = [];
        if (this.fragIsText)
            this.onText?.(full.toString('utf8'));
    }
    finish(code, reason) {
        if (this.closed)
            return;
        this.closed = true;
        try {
            this.socket?.destroy();
        }
        catch {
            /* ignore */
        }
        this.onClose?.(code, reason);
    }
}
//# sourceMappingURL=ws.js.map