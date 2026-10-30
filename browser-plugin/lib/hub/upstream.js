/**
 * CDP 上游连接：一条常驻 WebSocket 到用户主 Chrome，负责请求/响应关联、
 * 事件广播、保活与断线重连。
 *
 * 「一条连接」是关键：Chrome 的授权粒度是每条 WebSocket 一次，复用同一条
 * 连接才能把「要允许远程调试吗」压到每个 Chrome 会话一次。
 *
 * @module @deepseek-ai/dsh-tool-browser/hub/upstream
 */
import { resolveEndpoint } from './platform.js';
import { MiniWebSocket } from './ws.js';
export class CdpUpstream {
    opts;
    ws = null;
    ready = false;
    nextId = 1;
    pending = new Map();
    readyWaiters = [];
    keepaliveTimer = null;
    reconnectTimer = null;
    stopping = false;
    sinks = new Set();
    stats = {
        connects: 0,
        disconnects: 0,
        requests: 0,
        errors: 0,
        lastError: null,
        lastConnectedAt: null,
    };
    endpoint = null;
    constructor(opts = {}) {
        this.opts = opts;
    }
    get isReady() {
        return this.ready;
    }
    /** 建立连接（幂等：已就绪则直接返回）。 */
    async ensureConnected() {
        if (this.ready)
            return;
        if (!this.ws)
            this.spawn();
        await this.waitReady();
    }
    /** 订阅上游事件（不含响应帧）。 */
    onEvent(sink) {
        this.sinks.add(sink);
        return () => this.sinks.delete(sink);
    }
    async send(method, params = {}, sessionId) {
        await this.ensureConnected();
        const ws = this.ws;
        if (!ws)
            throw new Error('上游未连接');
        const id = this.nextId++;
        const payload = { id, method, params };
        if (sessionId !== undefined)
            payload.sessionId = sessionId;
        this.stats.requests += 1;
        const timeoutMs = this.opts.requestTimeoutMs ?? 120000;
        const promise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`CDP ${method} 超时（${timeoutMs}ms）`));
            }, timeoutMs);
            timer.unref?.();
            this.pending.set(id, { resolve, reject, timer, method });
        });
        ws.send(JSON.stringify(payload));
        return await promise;
    }
    stop() {
        this.stopping = true;
        if (this.keepaliveTimer)
            clearInterval(this.keepaliveTimer);
        this.keepaliveTimer = null;
        if (this.reconnectTimer)
            clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.failAllPending('上游已停止');
        this.ready = false;
        const ws = this.ws;
        this.ws = null;
        ws?.close();
    }
    spawn() {
        let endpoint;
        try {
            endpoint = resolveEndpoint({ profileDir: this.opts.profileDir, cdpWsUrl: this.opts.cdpWsUrl });
        }
        catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            this.stats.errors += 1;
            this.stats.lastError = text;
            this.rejectWaiters(new Error(text));
            throw error;
        }
        this.endpoint = endpoint;
        MiniWebSocket.connect(endpoint.wsUrl, { timeoutMs: this.opts.readyTimeoutMs ?? 30000 })
            .then((ws) => {
            if (this.stopping) {
                ws.close();
                return;
            }
            this.ws = ws;
            this.ready = true;
            this.stats.connects += 1;
            this.stats.lastConnectedAt = new Date().toISOString();
            ws.onText = (text) => this.handleText(text);
            ws.onClose = (code, reason) => this.handleClose(code, reason);
            this.startKeepalive();
            this.flushWaiters();
        })
            .catch((error) => {
            const text = error instanceof Error ? error.message : String(error);
            this.stats.errors += 1;
            this.stats.lastError = text;
            this.rejectWaiters(new Error(text));
            this.scheduleReconnect();
        });
    }
    handleText(text) {
        let msg;
        try {
            msg = JSON.parse(text);
        }
        catch {
            return;
        }
        const id = msg.id;
        if (typeof id !== 'number') {
            // 事件帧：广播给订阅者
            for (const sink of this.sinks) {
                try {
                    sink(msg);
                }
                catch {
                    /* 单个订阅者出错不影响其它 */
                }
            }
            return;
        }
        const entry = this.pending.get(id);
        if (!entry)
            return;
        this.pending.delete(id);
        clearTimeout(entry.timer);
        const error = msg.error;
        if (error) {
            entry.reject(new Error(`${error.message ?? 'CDP 错误'}${error.data ? `: ${error.data}` : ''}`));
            return;
        }
        entry.resolve(msg.result);
    }
    handleClose(code, reason) {
        this.ready = false;
        this.stats.disconnects += 1;
        if (this.keepaliveTimer)
            clearInterval(this.keepaliveTimer);
        this.keepaliveTimer = null;
        this.failAllPending(`上游关闭（code=${code ?? '?'}${reason ? `, ${reason}` : ''}）`);
        this.ws = null;
        if (!this.stopping)
            this.scheduleReconnect();
    }
    scheduleReconnect(delayMs = 1500) {
        if (this.stopping || this.reconnectTimer)
            return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.stopping)
                return;
            try {
                this.spawn();
            }
            catch {
                this.scheduleReconnect(5000);
            }
        }, delayMs);
        this.reconnectTimer.unref?.();
    }
    startKeepalive() {
        if (this.keepaliveTimer)
            clearInterval(this.keepaliveTimer);
        const period = this.opts.keepaliveMs ?? 25000;
        this.keepaliveTimer = setInterval(() => {
            void this.send('Browser.getVersion').catch(() => undefined);
        }, period);
        this.keepaliveTimer.unref?.();
    }
    waitReady(timeoutMs) {
        if (this.ready)
            return Promise.resolve();
        const limit = timeoutMs ?? this.opts.readyTimeoutMs ?? 120000;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const i = this.readyWaiters.findIndex((w) => w.timer === timer);
                if (i >= 0)
                    this.readyWaiters.splice(i, 1);
                reject(new Error(`Chrome 的 CDP 连接未就绪（${limit}ms）。` +
                    '若刚才 Chrome 弹了「要允许远程调试吗」，请点「允许」；' +
                    '也可以先运行 chrome_hub(action:"status") 看 connects 计数与错误信息。'));
            }, limit);
            timer.unref?.();
            this.readyWaiters.push({ resolve, reject, timer });
        });
    }
    flushWaiters() {
        for (const w of this.readyWaiters.splice(0)) {
            clearTimeout(w.timer);
            w.resolve();
        }
    }
    rejectWaiters(error) {
        for (const w of this.readyWaiters.splice(0)) {
            clearTimeout(w.timer);
            w.reject(error);
        }
    }
    failAllPending(reason) {
        for (const [, entry] of this.pending) {
            clearTimeout(entry.timer);
            entry.reject(new Error(reason));
        }
        this.pending.clear();
    }
}
//# sourceMappingURL=upstream.js.map