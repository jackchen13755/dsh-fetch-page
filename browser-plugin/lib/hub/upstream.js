/**
 * CDP 上游连接：一条常驻 WebSocket 到用户主 Chrome，负责请求/响应关联、
 * 事件广播、保活与断线重连。
 *
 * 「一条连接」是关键：Chrome 的授权粒度是每条 WebSocket 一次，复用同一条
 * 连接才能把「要允许远程调试吗」压到每个 Chrome 会话一次。
 *
 * 断线重连策略（S1–S9 + 评审 P1/P2/P3/P5/P6/P7/P9/P10/P11）：
 * - S1 单飞 + 代际守卫：任意时刻最多一条上游 socket；close/error 回调第一行校验
 *   socket 身份，旧 socket 的迟到事件直接丢弃；重连前先把 this.ws 置空。
 * - S2 指数退避 + 抖动：1500 → 3000 → 6000 → 12000（默认 maxAttempts=5，第 5 次失败
 *   进 paused）；调大 maxAttempts 可继续跑到 24000 → 48000，上限 60000ms。
 *   抖动默认 ±20%，硬上限 1/3（超过 1/3 会破坏相邻延迟的单调递增）。
 * - S3 端口预探测：握手前先 TCP 探 DevToolsActivePort 里的端口（500ms 超时）。
 *   未监听就不发 WS 握手——Chrome 的授权弹窗只由 WS 握手触发。
 * - S4 失败上限：网络类失败连续 5 次进入 paused，不再自动发起 WS。
 * - **授权类失败（P2）**：TCP 可达但握手没成功（无 101 / 101 前被关 / 握手超时）
 *   第 1 次就 `paused('auth')`——这类失败等一会儿不会自己好，重试只会多弹一次窗。
 *   之后只有客户端显式请求（auth 冷却 30s，比普通重试更严）或端点（uuid/端口）变化
 *   才放行一次尝试。
 * - S5 懒连接 + 空闲断开：10 分钟没有客户端需求就主动断开并停在 paused(idle)；
 *   `/events` 的活跃订阅者通过 `noteDemand()` 续期（P7）。
 * - S6 keepalive 变看门狗：Browser.getVersion 发出后 10s 无回包或报错即判定半开。
 * - S7/P1 唤醒处理：时间差 > 120s 视为系统睡过 → 重置退避并**最多重建一次**；
 *   且必须满足「有新鲜需求（lastNeedAt 在 wakeDemandMs 内）」或「唤醒前处于 ready」，
 *   否则保持 paused。`SIGCONT` 是进程级广播（fg/bg/kill -CONT 都会发），只当提示，
 *   必须靠时间差证明真的睡过才会被当作唤醒。授权暂停永不被唤醒解除。
 * - S9 日志：每次（重）连接尝试一行结构化日志（attempt / delayMs / portListening），
 *   并对 `<uuid>` 与 home 目录做脱敏（只留 uuid 前 8 位、路径用 ~）。
 *
 * @module @deepseek-ai/dsh-tool-browser/hub/upstream
 */
import { homedir } from 'node:os';
import { connect as netConnect } from 'node:net';
import { createRequire } from 'node:module';
import { prettyPath, resolveEndpoint } from './platform.js';
import { MiniWebSocket } from './ws.js';
export const BACKOFF_BASE_MS = 1500;
export const BACKOFF_MAX_MS = 60000;
export const BACKOFF_JITTER = 0.2;
/** 抖动硬上限：超过 1/3 就无法保证相邻延迟单调递增（(1-j)·2 > (1+j) ⇔ j < 1/3）。 */
export const BACKOFF_MAX_JITTER = 1 / 3;
export const MAX_ATTEMPTS = 5;
export const RESUME_COOLDOWN_MS = 3000;
export const AUTH_COOLDOWN_MS = 30000;
export const IDLE_MS = 600000;
export const WAKE_GAP_MS = 120000;
export const WAKE_DEMAND_MS = 120000;
export const PORT_PROBE_TIMEOUT_MS = 500;
export const KEEPALIVE_WATCHDOG_MS = 10000;
/**
 * 第 attempt 次失败后的等待时长（attempt 从 1 开始）：1500 → 3000 → … → 上限，
 * 再叠抖动。抖动被 clamp 到 1/3 以内，保证相邻延迟严格递增。
 */
export function backoffDelayMs(attempt, opts = {}, random = Math.random) {
    const base = opts.baseMs ?? BACKOFF_BASE_MS;
    const max = opts.maxMs ?? BACKOFF_MAX_MS;
    const jitter = Math.max(0, Math.min(opts.jitter ?? BACKOFF_JITTER, BACKOFF_MAX_JITTER));
    const exp = Math.max(0, Math.floor(attempt) - 1);
    const raw = Math.min(max, base * 2 ** exp);
    if (jitter === 0)
        return Math.round(raw);
    const factor = 1 + (random() * 2 - 1) * jitter;
    return Math.round(Math.max(1, Math.min(max, raw * factor)));
}
/** TCP 探活：端口有监听返回 true（超时内连不上按未监听处理）。 */
export function probeTcpPort(host, port, timeoutMs = PORT_PROBE_TIMEOUT_MS) {
    return new Promise((resolve) => {
        let settled = false;
        let timer = null;
        const socket = netConnect({ host, port });
        const finish = (listening) => {
            if (settled)
                return;
            settled = true;
            if (timer !== null)
                clearTimeout(timer);
            try {
                socket.destroy();
            }
            catch {
                /* ignore */
            }
            resolve(listening);
        };
        timer = setTimeout(() => finish(false), timeoutMs);
        timer.unref?.();
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
        socket.once('timeout', () => finish(false));
    });
}
function describeError(error) {
    return error instanceof Error ? error.message : String(error);
}
/** 脱敏：`<uuid>` 只留前 8 位，home 目录缩成 `~`。 */
export function sanitizeText(text, homeDir = homedir()) {
    let out = text.replace(/\/devtools\/browser\/([0-9a-zA-Z-]{8})[0-9a-zA-Z-]+/g, '/devtools/browser/$1…');
    if (homeDir !== '' && homeDir !== '/')
        out = out.split(homeDir).join('~');
    return out;
}
/** 授权类失败：TCP 通了但 WS 握手没成功（Chrome 在等/拒绝「允许远程调试吗」）。 */
export function isAuthFailure(error) {
    if (error === null || typeof error !== 'object')
        return false;
    const code = error.code;
    return typeof code === 'string' && code.startsWith('ws-handshake');
}
/**
 * 严格解析 ws:// 端点：显式端口必须是 1..65535 的整数，非法就报错，
 * **绝不静默回落**（开发机上 9222 常另有 Chrome，回落 = 连错浏览器）。
 */
export function parseEndpointUrl(wsUrl) {
    const masked = sanitizeText(wsUrl);
    let url;
    try {
        url = new URL(wsUrl);
    }
    catch {
        return {
            ok: false,
            reason: `端点地址无法解析（${masked}）：ws:// 地址里的端口必须在 1..65535 之间，检查 DevToolsActivePort 或 cdpWsUrl 配置`,
        };
    }
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
        return { ok: false, reason: `只支持 ws:// / wss:// 端点，收到 ${url.protocol}（${masked}）` };
    }
    const host = url.hostname === '' ? '127.0.0.1' : url.hostname;
    if (url.port === '') {
        // 没写端口是合法写法：按 WS/WSS 协议默认 80/443（不是「猜一个 CDP 端口」）
        return { ok: true, host, port: url.protocol === 'wss:' ? 443 : 80 };
    }
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return {
            ok: false,
            reason: `端点端口非法（${url.port}）：必须在 1..65535 之间；请检查 DevToolsActivePort 或 cdpWsUrl 配置`,
        };
    }
    return { ok: true, host, port };
}
export class CdpUpstream {
    opts;
    ws = null;
    countedSocket = null;
    connecting = null;
    /** P13：attemptConnect 正在跑（同步段也算），用于挡住任何重入。 */
    connectInFlight = false;
    ready = false;
    nextId = 1;
    pending = new Map();
    keepaliveTimer = null;
    heartbeatTimer = null;
    reconnectTimer = null;
    stopping = false;
    sinks = new Set();
    /** 连续失败次数（握手成功清零）。 */
    attempts = 0;
    paused = false;
    pausedReason = null;
    nextRetryAt = null;
    /** 本次 attempt 之前等待了多久（只用于日志）。 */
    scheduledDelayMs = null;
    lastAttemptAt = null;
    lastNeedAt = null;
    connectedAt = null;
    /** 连续「握手成功但立刻被断」的次数（活过 flapMs 才清零）。 */
    shortLived = 0;
    lastTick;
    /** true = 这次尝试是 paused 后被客户端显式放行的那一次；失败要立刻回 paused。 */
    resumedFromPause = false;
    resumeReason = null;
    /** 授权失败时用的端点，用于判断「端点是否已经变了」。 */
    authFailedEndpoint = null;
    malformedFrames = 0;
    detachWakeHooks = [];
    stats = {
        connects: 0,
        disconnects: 0,
        requests: 0,
        keepalives: 0,
        errors: 0,
        lastError: null,
        lastConnectedAt: null,
    };
    endpoint = null;
    backoffBaseMs;
    backoffMaxMs;
    backoffJitter;
    maxAttempts;
    portProbeTimeoutMs;
    idleMs;
    resumeCooldownMs;
    authCooldownMs;
    wakeDemandMs;
    wakeGapMs;
    heartbeatMs;
    flapMs;
    onLog;
    constructor(opts = {}) {
        this.opts = opts;
        this.backoffBaseMs = opts.backoffBaseMs ?? BACKOFF_BASE_MS;
        this.backoffMaxMs = opts.backoffMaxMs ?? BACKOFF_MAX_MS;
        this.backoffJitter = Math.max(0, Math.min(opts.backoffJitter ?? BACKOFF_JITTER, BACKOFF_MAX_JITTER));
        this.maxAttempts = Math.max(1, opts.maxAttempts ?? MAX_ATTEMPTS);
        this.portProbeTimeoutMs = opts.portProbeTimeoutMs ?? PORT_PROBE_TIMEOUT_MS;
        this.idleMs = opts.idleMs ?? IDLE_MS;
        this.resumeCooldownMs = opts.resumeCooldownMs ?? RESUME_COOLDOWN_MS;
        this.authCooldownMs = opts.authCooldownMs ?? AUTH_COOLDOWN_MS;
        this.wakeDemandMs = opts.wakeDemandMs ?? WAKE_DEMAND_MS;
        this.wakeGapMs = opts.wakeGapMs ?? WAKE_GAP_MS;
        this.heartbeatMs = Math.max(1, opts.heartbeatMs ?? 5000);
        this.flapMs = Math.max(0, opts.flapMs ?? 10000);
        this.onLog = opts.log ?? ((line) => console.error(line));
        this.lastTick = this.now();
        this.attachWakeHooks();
        this.startHeartbeat();
    }
    get isReady() {
        return this.ready;
    }
    get isPaused() {
        return this.paused;
    }
    /** /health 用：上游真实状态。 */
    get health() {
        const now = this.now();
        return {
            ready: this.ready,
            paused: this.paused,
            pausedReason: this.pausedReason,
            attempts: this.attempts,
            lastError: this.stats.lastError,
            nextRetryMs: this.nextRetryAt === null ? null : Math.max(0, this.nextRetryAt - now),
            lastAttemptAt: this.lastAttemptAt === null ? null : new Date(this.lastAttemptAt).toISOString(),
            idleForMs: this.lastNeedAt === null ? null : Math.max(0, now - this.lastNeedAt),
            // 只有授权暂停时才需要这个判断；健康路径不做 fs 读取。
            endpointChanged: this.paused && this.pausedReason === 'auth' ? this.endpointSignatureChanged() : false,
        };
    }
    now() {
        return this.opts.now ? this.opts.now() : Date.now();
    }
    /**
     * 记录一次客户端需求（对外公开：`/events` 的订阅者/心跳也要续期，见 P7）。
     */
    noteDemand() {
        this.lastNeedAt = this.now();
    }
    /**
     * 建立连接（幂等 + 单飞）：并发调用共用同一条在途连接，任意时刻最多一条 socket。
     * paused 时只有客户端显式请求（或端点已变化）才放行一次新尝试：
     * - failures / idle：冷却 resumeCooldownMs；
     * - auth：冷却 authCooldownMs，更严（避免轮询脚本每轮一次弹窗）。
     */
    async ensureConnected() {
        if (this.stopping)
            throw new Error('上游已停止：需要重新创建 ChromeHub 才能再次连接。');
        this.noteDemand();
        // P13：唤醒判定必须在「占用单飞槽之前」——
        // 否则 attemptConnect 的同步段先跑 detectWake，handleWake 会看到 connecting===null
        // 而再开一条 attempt，唤醒后变成两条 socket / 两次握手（勾一次授权弹窗）。
        this.detectWake(this.now());
        if (this.ready && this.ws !== null)
            return;
        if (this.connecting === null) {
            this.resumeIfPaused();
            if (this.paused)
                throw new Error(this.pausedError());
            this.startAttempt();
        }
        if (this.connecting === null)
            throw new Error(this.pausedError());
        await this.connecting;
    }
    /**
     * 单飞槽的唯一入口：任何时刻最多一条在途尝试。
     * 已有一条在途时直接复用它的 promise（不新开 socket）。
     */
    startAttempt() {
        const existing = this.connecting;
        if (existing !== null)
            return existing;
        const promise = this.attemptConnect().finally(() => {
            if (this.connecting === promise)
                this.connecting = null;
        });
        this.connecting = promise;
        return promise;
    }
    /** 订阅上游事件（不含响应帧）。 */
    onEvent(sink) {
        this.sinks.add(sink);
        return () => this.sinks.delete(sink);
    }
    async send(method, params = {}, sessionId) {
        await this.ensureConnected();
        return await this.request(method, params, sessionId, this.opts.requestTimeoutMs ?? 120000, 'request');
    }
    stop() {
        this.stopping = true;
        this.clearTimer('keepalive');
        this.clearTimer('heartbeat');
        this.clearTimer('reconnect');
        this.detachWake();
        this.failAllPending('上游已停止');
        this.ready = false;
        const ws = this.ws;
        this.ws = null;
        this.countedSocket = null;
        try {
            ws?.close();
        }
        catch {
            /* ignore */
        }
        this.paused = false;
        this.pausedReason = null;
        this.attempts = 0;
        this.nextRetryAt = null;
        this.scheduledDelayMs = null;
    }
    // ── 连接 / 重连 ─────────────────────────────────────────────────────────
    /**
     * 单次连接尝试：严格解析端点 → 端口预探测 → WS 握手 → adopt 前 liveness 校验。
     * 失败按类别记账：授权类首次即 paused(auth)，其它按指数退避。
     */
    async attemptConnect() {
        // P13 兜底：同步段重入时直接放弃本次（绝不允许第二条 socket）。
        if (this.connectInFlight) {
            this.onLog('[cdp-hub] upstream attempt skipped reason=already-in-flight');
            return;
        }
        this.connectInFlight = true;
        try {
            await this.runAttempt();
        }
        finally {
            this.connectInFlight = false;
        }
    }
    async runAttempt() {
        const attempt = this.attempts + 1;
        const delayMs = this.scheduledDelayMs;
        this.scheduledDelayMs = null;
        let endpoint;
        try {
            endpoint = this.resolveCurrentEndpoint();
        }
        catch (error) {
            this.recordFailure(error, attempt, delayMs, null);
            throw error;
        }
        this.endpoint = endpoint;
        const parsed = parseEndpointUrl(endpoint.wsUrl);
        if (!parsed.ok) {
            const error = new Error(`CDP 端点非法：${parsed.reason}（端点来源 ${endpoint.source}）`);
            this.recordFailure(error, attempt, delayMs, null);
            throw error;
        }
        const { host, port } = parsed;
        const portListening = await this.probePort(host, port);
        this.logAttempt({ attempt, delayMs, portListening, host, port, source: endpoint.source });
        if (!portListening) {
            const error = new Error(`Chrome 调试端口 ${host}:${port} 未在监听（端点来源 ${endpoint.source}）。` +
                'DevToolsActivePort 可能已过期（Chrome 重启/退出）：请在 chrome://inspect/#remote-debugging 重新开启远程调试。');
            this.recordFailure(error, attempt, delayMs, portListening);
            // 端口没开就不发 WS 握手：Chrome 的授权弹窗只由 WS 握手触发。
            throw error;
        }
        let socket;
        try {
            socket = await this.connectSocket(endpoint.wsUrl, { timeoutMs: this.opts.readyTimeoutMs ?? 30000 });
        }
        catch (error) {
            if (isAuthFailure(error)) {
                this.recordAuthFailure(error, attempt, delayMs, portListening, endpoint.wsUrl);
            }
            else {
                this.recordFailure(error, attempt, delayMs, portListening);
            }
            throw error;
        }
        if (this.stopping) {
            try {
                socket.close();
            }
            catch {
                /* ignore */
            }
            throw new Error('上游已停止');
        }
        if (socket.isClosed === true) {
            const error = new Error('握手成功后连接立刻被关闭（adopt 前）：Chrome 可能刚关闭了远程调试入口');
            this.recordFailure(error, attempt, delayMs, portListening);
            throw error;
        }
        if (!this.adoptSocket(socket)) {
            const error = new Error('握手成功后连接立刻被关闭（adopt 窗口内）');
            this.stats.errors += 1;
            this.stats.lastError = this.sanitize(error.message);
            this.onLog(`[cdp-hub] upstream dropped in adopt window error=${this.stats.lastError}`);
            throw error;
        }
    }
    /** 接管一条握手成功的 socket（唯一入口，确保 handlers 都带身份校验）。 */
    adoptSocket(socket) {
        // 防御：万一有旧 socket 还挂着（迟到的握手结果），先断开它，保证峰值 = 1。
        const stale = this.ws;
        this.ws = socket;
        if (stale !== null && stale !== socket) {
            try {
                stale.close();
            }
            catch {
                /* ignore */
            }
        }
        this.ready = true;
        this.attempts = 0;
        this.paused = false;
        this.pausedReason = null;
        this.nextRetryAt = null;
        this.resumedFromPause = false;
        this.resumeReason = null;
        this.lastTick = this.now();
        this.connectedAt = this.now();
        // 先挂 handlers：这样 adopt 窗口内的 close 也能走统一失败路径（P3）。
        socket.onText = (text) => {
            if (socket !== this.ws)
                return; // S1：旧 socket 迟到文本直接丢弃
            this.handleText(text);
        };
        socket.onClose = (code, reason) => {
            this.handleClose(socket, code, reason);
        };
        if (socket.isClosed === true) {
            // 握手 resolve 之后、adopt 之前被关掉：不许把 ready 留在 true，
            // 立刻按统一失败路径处理（pending 失败 + 退避重连）。
            this.stats.errors += 1;
            this.stats.lastError = this.sanitize('握手成功后连接立刻被关闭（adopt 窗口内）');
            this.handleClose(socket, undefined, 'closed-before-adopt');
            return false;
        }
        this.countedSocket = socket;
        this.stats.connects += 1;
        this.stats.lastConnectedAt = new Date().toISOString();
        this.startKeepalive();
        const where = parseEndpointUrl(this.endpoint?.wsUrl ?? '');
        this.onLog(`[cdp-hub] upstream connected connects=${this.stats.connects} port=${where.ok ? where.port : '?'} source=${this.endpoint?.source ?? '?'}`);
        return true;
    }
    /** 统一关闭路径：先置空 this.ws（让旧 socket 的后续事件被身份校验挡掉）。 */
    closeCurrent(reason) {
        const ws = this.ws;
        this.ws = null;
        this.ready = false;
        this.countedSocket = null;
        this.clearTimer('keepalive');
        this.failAllPending(reason);
        try {
            ws?.close();
        }
        catch {
            /* ignore */
        }
    }
    handleClose(socket, code, reason) {
        if (socket !== this.ws)
            return; // S1：旧 socket 的迟到 close 事件直接丢弃
        this.ws = null;
        this.ready = false;
        if (this.countedSocket === socket) {
            this.stats.disconnects += 1;
            this.countedSocket = null;
        }
        this.clearTimer('keepalive');
        this.failAllPending(`上游关闭（code=${code ?? '?'}${reason ? `, ${reason}` : ''}）`);
        this.onLog(`[cdp-hub] upstream closed code=${code ?? '?'} disconnects=${this.stats.disconnects}`);
        if (this.stopping)
            return;
        const now = this.now();
        const livedMs = this.connectedAt === null ? 0 : now - this.connectedAt;
        this.connectedAt = null;
        if (livedMs >= this.flapMs) {
            // 健康连接断开：按第 1 次失败计（下次等待 1500ms）。
            this.shortLived = 0;
            this.attempts = 1;
        }
        else {
            // 握手成功却立刻被断：当作失败累加，否则会退回「每 1.5s 一次新握手」的风暴。
            this.shortLived += 1;
            this.attempts = Math.max(2, this.shortLived + 1);
            this.onLog(`[cdp-hub] upstream flapped livedMs=${Math.round(livedMs)} shortLived=${this.shortLived}`);
        }
        if (!this.hasDemand()) {
            this.pause('idle');
            return;
        }
        if (this.attempts >= this.maxAttempts) {
            this.pause('failures');
            return;
        }
        this.scheduleReconnect(backoffDelayMs(this.attempts, this.backoffOptions()));
    }
    scheduleReconnect(delayMs) {
        if (this.stopping || this.paused || this.reconnectTimer)
            return;
        this.scheduledDelayMs = delayMs;
        this.nextRetryAt = this.now() + delayMs;
        const timer = setTimeout(() => {
            this.reconnectTimer = null;
            this.nextRetryAt = null;
            void this.retryTick();
        }, delayMs);
        timer.unref?.();
        this.reconnectTimer = timer;
    }
    async retryTick() {
        // P13：同样先判唤醒（睡醒后定时器才被补跑），再占单飞槽。
        this.detectWake(this.now());
        if (this.stopping || this.paused || this.ready)
            return;
        if (!this.hasDemand()) {
            this.pause('idle');
            return;
        }
        if (this.connecting !== null)
            return;
        await this.startAttempt().catch(() => undefined); // 失败已在 recordFailure 里记账并排好下一次退避
    }
    /** 网络类/端点类失败：按指数退避重试，到上限后 paused(failures)。 */
    recordFailure(error, attempt, delayMs, portListening) {
        const text = this.sanitize(describeError(error));
        this.attempts = attempt;
        this.stats.errors += 1;
        this.stats.lastError = text;
        this.lastAttemptAt = this.now();
        this.onLog(`[cdp-hub] upstream attempt failed attempt=${attempt} delayMs=${delayMs ?? 0} portListening=${portListening === null ? 'n/a' : String(portListening)} error=${text.replace(/\s+/g, ' ').slice(0, 200)}`);
        if (this.resumedFromPause) {
            // S4：客户端放行的那一次也失败了 → 立刻回 paused，等下个冷却后的显式请求。
            const reason = this.resumeReason === 'auth' ? 'auth' : 'failures';
            this.resumedFromPause = false;
            this.resumeReason = null;
            this.pause(reason);
            return;
        }
        if (this.attempts >= this.maxAttempts) {
            this.pause('failures');
            return;
        }
        if (!this.hasDemand()) {
            this.pause('idle');
            return;
        }
        this.scheduleReconnect(backoffDelayMs(this.attempts, this.backoffOptions()));
    }
    /**
     * 授权类失败（P2）：TCP 可达但握手没成功，第 1 次就暂停。
     * 这类失败「等一会儿」不会自己好——用户没点允许、或 uuid 已过期——重试只会多弹一次窗。
     */
    recordAuthFailure(error, attempt, delayMs, portListening, wsUrl) {
        const text = this.sanitize(describeError(error));
        this.attempts = Math.max(1, attempt);
        this.stats.errors += 1;
        this.stats.lastError = text;
        this.lastAttemptAt = this.now();
        this.authFailedEndpoint = wsUrl;
        this.onLog(`[cdp-hub] upstream auth failed attempt=${attempt} delayMs=${delayMs ?? 0} portListening=${portListening === null ? 'n/a' : String(portListening)} error=${text.replace(/\s+/g, ' ').slice(0, 200)}`);
        this.resumedFromPause = false;
        this.resumeReason = null;
        this.pause('auth');
    }
    pause(reason) {
        this.paused = true;
        this.pausedReason = reason;
        this.nextRetryAt = null;
        this.clearTimer('reconnect');
        this.onLog(`[cdp-hub] upstream paused reason=${reason} attempts=${this.attempts}`);
    }
    /** paused 时客户端显式请求的唯一放行口。 */
    resumeIfPaused() {
        if (!this.paused || this.stopping)
            return;
        const now = this.now();
        if (this.pausedReason === 'idle') {
            this.paused = false;
            this.pausedReason = null;
            this.attempts = 0;
            this.onLog('[cdp-hub] upstream resume reason=client-request (from idle)');
            return;
        }
        if (this.pausedReason === 'auth') {
            const changed = this.endpointSignatureChanged();
            const waitMs = this.lastAttemptAt === null ? 0 : this.lastAttemptAt + this.authCooldownMs - now;
            if (!changed && waitMs > 0)
                throw new Error(this.pausedError(waitMs));
            this.paused = false;
            this.pausedReason = null;
            this.attempts = 0;
            this.resumedFromPause = true;
            this.resumeReason = 'auth';
            this.onLog(`[cdp-hub] upstream resume reason=client-request (from auth, endpointChanged=${changed})`);
            return;
        }
        // failures
        const waitMs = this.lastAttemptAt === null ? 0 : this.lastAttemptAt + this.resumeCooldownMs - now;
        if (waitMs > 0)
            throw new Error(this.pausedError(waitMs));
        this.paused = false;
        this.pausedReason = null;
        this.attempts = 0;
        this.resumedFromPause = true;
        this.resumeReason = 'failures';
        this.onLog('[cdp-hub] upstream resume reason=client-request (from failures)');
    }
    pausedError(waitMs) {
        const cooldown = this.pausedReason === 'auth' ? this.authCooldownMs : this.resumeCooldownMs;
        const wait = waitMs ?? (this.lastAttemptAt === null ? 0 : this.lastAttemptAt + cooldown - this.now());
        const hint = this.pausedReason === 'idle'
            ? '空闲超时已主动断开'
            : this.pausedReason === 'auth'
                ? 'Chrome 的远程调试授权没通过（握手未成功），已停止自动重试以免反复弹窗'
                : `连续失败 ${this.attempts} 次后已停止自动重连（避免反复触发 Chrome 授权弹窗）`;
        const next = wait > 0 ? `冷却剩余 ${Math.ceil(wait / 1000)}s 后可重试。` : '可直接重试。';
        const fix = this.pausedReason === 'auth'
            ? '请先在 Chrome 里点「允许」；若已允许仍失败，多半是 DevToolsActivePort 的 uuid 已过期（Chrome 重启过），重新开启远程调试后再试。'
            : '若 Chrome 弹过「要允许远程调试吗」，请先点允许；或在 chrome://inspect/#remote-debugging 重新开启远程调试。';
        return `Chrome CDP 上游已暂停：${hint}。最后一次错误：${this.stats.lastError ?? '未知'}。${next}${fix}`;
    }
    hasDemand() {
        if (this.lastNeedAt === null)
            return false;
        return this.now() - this.lastNeedAt < this.idleMs;
    }
    backoffOptions() {
        return { baseMs: this.backoffBaseMs, maxMs: this.backoffMaxMs, jitter: this.backoffJitter };
    }
    probePort(host, port) {
        if (this.opts.probePort)
            return this.opts.probePort(host, port, this.portProbeTimeoutMs);
        return probeTcpPort(host, port, this.portProbeTimeoutMs);
    }
    async connectSocket(wsUrl, opts) {
        if (this.opts.connect)
            return await this.opts.connect(wsUrl, opts);
        return await MiniWebSocket.connect(wsUrl, opts);
    }
    resolveCurrentEndpoint() {
        const base = this.opts.resolveEndpointFn ?? resolveEndpoint;
        return base({
            ...(this.opts.profileDir !== undefined ? { profileDir: this.opts.profileDir } : {}),
            ...(this.opts.cdpWsUrl !== undefined ? { cdpWsUrl: this.opts.cdpWsUrl } : {}),
        });
    }
    /** 授权暂停后端点是否已经变化（端口/uuid 变了说明用户重新开了远程调试）。 */
    endpointSignatureChanged() {
        if (this.authFailedEndpoint === null)
            return false;
        try {
            return this.resolveCurrentEndpoint().wsUrl !== this.authFailedEndpoint;
        }
        catch {
            return false;
        }
    }
    sanitize(text) {
        return sanitizeText(text, homedir());
    }
    logAttempt(info) {
        this.lastAttemptAt = this.now();
        this.onLog(`[cdp-hub] upstream attempt attempt=${info.attempt} delayMs=${info.delayMs ?? 0}` +
            ` portListening=${String(info.portListening)} endpoint=${info.host}:${info.port} source=${info.source}`);
    }
    // ── 请求 / 事件 ─────────────────────────────────────────────────────────
    async request(method, params, sessionId, timeoutMs, kind) {
        const ws = this.ws;
        if (ws === null || !this.ready)
            throw new Error('上游未连接');
        const id = this.nextId++;
        const payload = { id, method, params };
        if (sessionId !== undefined)
            payload.sessionId = sessionId;
        if (kind === 'keepalive')
            this.stats.keepalives += 1;
        else
            this.stats.requests += 1;
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
    handleText(text) {
        let parsed;
        try {
            parsed = JSON.parse(text);
        }
        catch {
            this.dropMalformedFrame('非法 JSON');
            return;
        }
        // Chrome 正常不会发 null/数组，但这是宿主进程内的回调：一帧畸形就是一次宿主崩溃。
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            this.dropMalformedFrame('非对象帧');
            return;
        }
        const msg = parsed;
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
    dropMalformedFrame(what) {
        this.malformedFrames += 1;
        this.onLog(`[cdp-hub] upstream dropped malformed frame (${what}) count=${this.malformedFrames}`);
    }
    // ── 保活看门狗 / 心跳 / 唤醒 ─────────────────────────────────────────────
    startKeepalive() {
        this.clearTimer('keepalive');
        const period = this.opts.keepaliveMs ?? 25000;
        const timer = setInterval(() => this.keepaliveTick(), period);
        timer.unref?.();
        this.keepaliveTimer = timer;
    }
    /** S6：Browser.getVersion 看门狗——10s 无回包/报错就判定半开并走统一重连。 */
    keepaliveTick() {
        const socket = this.ws;
        if (socket === null || this.stopping)
            return;
        this.lastTick = this.now();
        const watchdogMs = this.opts.keepaliveWatchdogMs ?? KEEPALIVE_WATCHDOG_MS;
        this.request('Browser.getVersion', {}, undefined, watchdogMs, 'keepalive').catch((error) => {
            if (socket !== this.ws)
                return; // 旧 socket 的迟到失败：忽略
            const text = this.sanitize(describeError(error));
            this.stats.errors += 1;
            this.stats.lastError = `keepalive 失败：${text}`;
            this.onLog(`[cdp-hub] upstream keepalive failed error=${text.replace(/\s+/g, ' ').slice(0, 200)}`);
            try {
                socket.close();
            }
            catch {
                /* ignore */
            }
        });
    }
    startHeartbeat() {
        this.clearTimer('heartbeat');
        const timer = setInterval(() => this.heartbeatTick(), this.heartbeatMs);
        timer.unref?.();
        this.heartbeatTimer = timer;
    }
    /**
     * S5 + S7 兜底：检测系统睡眠（时间差）并处理空闲断开。
     * 取不到 powerMonitor/SIGCONT 时，只有这里能让 hub 在唤醒后自愈。
     */
    heartbeatTick() {
        if (this.stopping)
            return;
        if (this.detectWake(this.now()))
            return;
        const now = this.now();
        if (this.ready && this.lastNeedAt !== null && now - this.lastNeedAt > this.idleMs) {
            this.closeCurrent('空闲超时：上游已断开');
            this.pause('idle');
        }
    }
    /** 时间差兜底的睡眠检测：睡过就按唤醒处理（重置退避 + 单次重建）。 */
    detectWake(now) {
        const gap = now - this.lastTick;
        if (gap <= this.wakeGapMs) {
            this.lastTick = now;
            return false;
        }
        return this.handleWake(`time-gap(${Math.round(gap)}ms)`);
    }
    /**
     * 系统唤醒（P1）：重置退避计数，**最多**发起一次重建，且必须先满足
     * 「有新鲜需求」或「唤醒前处于 ready」；授权暂停永不被唤醒解除。
     */
    handleWake(source) {
        if (this.stopping)
            return false;
        const now = this.now();
        const gap = now - this.lastTick;
        this.lastTick = now;
        this.scheduledDelayMs = null;
        this.nextRetryAt = null;
        this.clearTimer('reconnect');
        const freshDemand = this.lastNeedAt !== null && now - this.lastNeedAt <= this.wakeDemandMs;
        const wasReady = this.ready;
        this.onLog(`[cdp-hub] upstream wake source=${source} gapMs=${Math.round(gap)} freshDemand=${freshDemand}` +
            ` wasReady=${wasReady} paused=${this.paused}${this.pausedReason === null ? '' : `(${this.pausedReason})`}`);
        if (this.paused && this.pausedReason === 'auth') {
            // 授权没通过时，任何唤醒都不许再握手：那只会多弹一次窗。
            this.onLog('[cdp-hub] upstream wake ignored reason=auth-paused（授权暂停只能由客户端请求或端点变化解除）');
            return false;
        }
        if (!freshDemand && !wasReady) {
            this.onLog('[cdp-hub] upstream wake ignored reason=no-fresh-demand（不为探测去握手）');
            if (!this.paused) {
                // P16：idle 暂停必须与 attempts=0 一致（不能出现 failures + attempts=0）。
                this.attempts = 0;
                this.shortLived = 0;
                this.pause('idle');
            }
            return false;
        }
        // 只有真的要重建时才重置退避计数，保证 /health 不会自相矛盾（P16）。
        this.attempts = 0;
        this.shortLived = 0;
        if (this.paused) {
            this.paused = false;
            this.pausedReason = null;
        }
        if (wasReady) {
            // 睡眠后旧 socket 基本已死：主动收掉（pending 立刻失败），再重建一次。
            this.closeCurrent('系统唤醒：重建上游连接');
        }
        if (this.connecting !== null)
            return false;
        void this.startAttempt().catch(() => undefined);
        return true;
    }
    /** SIGCONT 等「进程级广播」只当提示：必须由时间差证明真的睡过，才升级为唤醒。 */
    onWakeHint(source) {
        if (this.stopping)
            return;
        const gap = this.now() - this.lastTick;
        if (gap > this.wakeGapMs) {
            this.handleWake(`${source}(gapMs=${Math.round(gap)})`);
            return;
        }
        this.onLog(`[cdp-hub] upstream wake-hint ignored source=${source} gapMs=${Math.round(gap)}`);
    }
    attachWakeHooks() {
        // 0) 宿主/测试注入的唤醒源
        for (const emitter of this.opts.wakeEmitters ?? []) {
            try {
                const off = emitter.subscribe(() => {
                    if (emitter.mode === 'hint')
                        this.onWakeHint(emitter.name);
                    else
                        this.handleWake(emitter.name);
                });
                this.detachWakeHooks.push(off);
            }
            catch {
                /* 取不到就静默兜底（时间差） */
            }
        }
        if (this.opts.attachSystemWake === false)
            return;
        // 1) Electron powerMonitor（宿主在主进程时可用；非 Electron 环境 require 会抛，静默兜底）
        try {
            const requireFn = createRequire(import.meta.url);
            const electron = requireFn('electron');
            const powerMonitor = electron?.powerMonitor;
            if (powerMonitor && typeof powerMonitor.on === 'function') {
                const handler = () => {
                    this.handleWake('powerMonitor:resume');
                };
                powerMonitor.on('resume', handler);
                this.detachWakeHooks.push(() => {
                    try {
                        powerMonitor.removeListener?.('resume', handler);
                    }
                    catch {
                        /* ignore */
                    }
                });
            }
        }
        catch {
            /* 不是 Electron 主进程 / 宿主没暴露 powerMonitor：静默用时间差兜底 */
        }
        // 2) POSIX SIGCONT：只是「进程被继续」的提示，不是连接触发器。
        try {
            const handler = () => {
                this.onWakeHint('SIGCONT');
            };
            process.on('SIGCONT', handler);
            this.detachWakeHooks.push(() => {
                try {
                    process.removeListener('SIGCONT', handler);
                }
                catch {
                    /* ignore */
                }
            });
        }
        catch {
            /* 平台不支持：静默兜底 */
        }
    }
    detachWake() {
        for (const off of this.detachWakeHooks.splice(0)) {
            try {
                off();
            }
            catch {
                /* ignore */
            }
        }
    }
    // ── 定时器 / 收尾 ───────────────────────────────────────────────────────
    clearTimer(which) {
        if (which === 'keepalive') {
            if (this.keepaliveTimer !== null)
                clearInterval(this.keepaliveTimer);
            this.keepaliveTimer = null;
            return;
        }
        if (which === 'heartbeat') {
            if (this.heartbeatTimer !== null)
                clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
            return;
        }
        if (this.reconnectTimer !== null)
            clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
    }
    failAllPending(reason) {
        for (const [, entry] of this.pending) {
            clearTimeout(entry.timer);
            entry.reject(new Error(reason));
        }
        this.pending.clear();
    }
}
// 供排障脚本复用（不改动运行时行为）
export { prettyPath };
//# sourceMappingURL=upstream.js.map