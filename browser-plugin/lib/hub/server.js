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
import { createServer } from 'node:http';
export function summarizeCookies(cookies) {
    const byDomain = {};
    for (const c of cookies) {
        const d = c.domain || '(none)';
        byDomain[d] = (byDomain[d] ?? 0) + 1;
    }
    return { total: cookies.length, domains: Object.keys(byDomain).length, byDomain };
}
function sendJson(res, status, body) {
    const buf = Buffer.from(JSON.stringify(body, null, 2), 'utf8');
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': buf.length,
        'cache-control': 'no-store',
    });
    res.end(buf);
}
async function readJsonBody(req) {
    const chunks = [];
    for await (const chunk of req)
        chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    return raw === '' ? {} : JSON.parse(raw);
}
/** 创建 HTTP 侧车（未 listen，交给调用方绑定端口）。 */
export function createHubServer(upstream, info) {
    const sseClients = new Set();
    upstream.onEvent((msg) => {
        const line = `data: ${JSON.stringify(msg)}\n\n`;
        for (const client of sseClients) {
            try {
                client.write(line);
            }
            catch {
                sseClients.delete(client);
            }
        }
    });
    const server = createServer((req, res) => {
        void handle(req, res).catch((error) => {
            const text = error instanceof Error ? error.message : String(error);
            sendJson(res, 502, { error: text });
        });
    });
    async function handle(req, res) {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const method = req.method ?? 'GET';
        if (method === 'GET' && url.pathname === '/health') {
            const endpoint = upstream.endpoint;
            sendJson(res, 200, {
                ok: true,
                ready: upstream.isReady,
                upstream: endpoint?.wsUrl ?? null,
                source: endpoint?.source ?? null,
                profileDir: endpoint?.profileDir ?? null,
                uptimeSec: Math.round((Date.now() - info().startedAt) / 1000),
                ...upstream.stats,
            });
            return;
        }
        if (method === 'GET' && url.pathname === '/cookies') {
            const result = (await upstream.send('Storage.getCookies'));
            let cookies = result.cookies ?? [];
            const filter = url.searchParams.get('domains');
            if (filter) {
                const pats = filter
                    .split(',')
                    .map((s) => s.trim())
                    .filter((s) => s !== '');
                cookies = cookies.filter((c) => pats.some((p) => (c.domain ?? '').includes(p)));
            }
            sendJson(res, 200, { ...summarizeCookies(cookies), cookies });
            return;
        }
        if (method === 'GET' && url.pathname === '/targets') {
            sendJson(res, 200, await upstream.send('Target.getTargets'));
            return;
        }
        if (method === 'GET' && url.pathname === '/events') {
            res.writeHead(200, {
                'content-type': 'text/event-stream; charset=utf-8',
                'cache-control': 'no-store',
                connection: 'keep-alive',
            });
            res.write(': connected\n\n');
            sseClients.add(res);
            const ping = setInterval(() => {
                try {
                    res.write(': ping\n\n');
                }
                catch {
                    /* ignore */
                }
            }, 15000);
            ping.unref?.();
            req.on('close', () => {
                clearInterval(ping);
                sseClients.delete(res);
            });
            return;
        }
        if (method === 'GET' && url.pathname === '/json/version') {
            const v = (await upstream.send('Browser.getVersion').catch(() => ({})));
            sendJson(res, 200, {
                Browser: v.product ?? 'Chrome',
                'Protocol-Version': v.protocolVersion ?? '1.3',
                webSocketDebuggerUrl: upstream.endpoint?.wsUrl ?? null,
            });
            return;
        }
        if (method === 'GET' && url.pathname === '/json/list') {
            const r = (await upstream.send('Target.getTargets'));
            const pages = (r.targetInfos ?? []).filter((t) => t.type === 'page');
            sendJson(res, 200, pages.map((t) => ({ id: t.targetId, type: t.type, title: t.title, url: t.url })));
            return;
        }
        if (method === 'POST' && url.pathname === '/cdp') {
            const body = await readJsonBody(req);
            const cdpMethod = typeof body.method === 'string' ? body.method : '';
            if (cdpMethod === '') {
                sendJson(res, 400, { error: 'body 需要 { method, params?, sessionId? }' });
                return;
            }
            const params = body.params ?? {};
            const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined;
            sendJson(res, 200, { result: await upstream.send(cdpMethod, params, sessionId) });
            return;
        }
        if (method === 'POST' && url.pathname === '/attach') {
            const body = await readJsonBody(req);
            const targetId = typeof body.targetId === 'string' ? body.targetId : '';
            if (targetId === '') {
                sendJson(res, 400, { error: 'body 需要 { targetId }' });
                return;
            }
            sendJson(res, 200, await upstream.send('Target.attachToTarget', { targetId, flatten: body.flatten !== false }));
            return;
        }
        sendJson(res, 404, { error: `no route ${method} ${url.pathname}` });
    }
    server.on('close', () => {
        for (const client of sseClients) {
            try {
                client.end();
            }
            catch {
                /* ignore */
            }
        }
        sseClients.clear();
    });
    return server;
}
//# sourceMappingURL=server.js.map