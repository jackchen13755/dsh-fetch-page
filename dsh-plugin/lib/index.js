/**
 * Model-facing `fetch_page` tool: forwards an HTTP request through the local
 * browser-extension relay daemon so the browser's cookie jar (and thus login
 * state) travels with the request while CORS is bypassed by the extension's
 * background fetch.
 *
 * @module @deepseek-ai/dsh-tool-fetch-page
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { homedir } from 'node:os';
import { join } from 'node:path';
export const name = 'tool-fetch-page';
export const inject = ['tools', 'shell'];
/** Strip HTML to readable text, isolating `<body>` and decoding common entities. */
function htmlToText(html) {
    let s = html;
    const bodyMatch = /<body[^>]*>([\s\S]*)<\/body>/i.exec(s);
    if (bodyMatch?.[1] !== undefined)
        s = bodyMatch[1];
    s = s.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ');
    s = s.replace(/<\/(p|div|h[1-6]|li|tr|table|section|article|blockquote|pre|ul|ol|dl|dt|dd|header|footer|main|form|fieldset)[^>]*>/gi, '\n');
    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<\/(td|th)>/gi, ' ');
    s = s.replace(/<[^>]+>/g, ' ');
    s = s.replace(/&nbsp;/gi, ' ');
    s = s.replace(/&amp;/gi, '&');
    s = s.replace(/&lt;/gi, '<');
    s = s.replace(/&gt;/gi, '>');
    s = s.replace(/&quot;/gi, '"');
    s = s.replace(/&#0?39;/gi, "'");
    s = s.replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(parseInt(d, 10)));
    s = s.split('\n').map((line) => line.replace(/[ \t\u00a0]+/g, ' ').replace(/^ +| +$/g, '')).join('\n');
    s = s.replace(/\n{3,}/g, '\n\n');
    return s.replace(/^[ \t\n]+|[ \t\n]+$/g, '');
}
/** A single model-facing text content block. */
function textBlock(text) {
    return { type: 'text', text };
}
export function apply(ctx, config = {}) {
    const daemonUrl = config.daemonUrl ?? 'http://127.0.0.1:9317';
    const daemonPath = config.daemonPath ?? join(homedir(), 'dsh', 'dsh-relay-daemon');
    const workdir = config.workdir ?? homedir();
    const workspaceRoot = config.workspaceRoot ?? homedir();
    function run(cmd, stdin) {
        return ctx.shell.run(ctx.shell.resolve({
            command: cmd,
            workdir,
            timeoutMs: 45000,
            stdoutMaxBytes: 8388608,
            sandboxPolicy: { mode: 'danger-full-access', workspaceRoot },
            ...(stdin !== undefined ? { stdin } : {}),
        }));
    }
    async function ensureDaemon() {
        await run(`lsof -ti tcp:9317 -sTCP:LISTEN >/dev/null 2>&1 || (nohup /usr/local/bin/node ${daemonPath} > /tmp/dsh-relay-daemon.log 2>&1 &)`);
    }
    ctx.tools.register(defineTool({
        name: 'fetch_page',
        description: '通过浏览器扩展用当前浏览器的 Cookie 转发 HTTP 请求，可访问登录态页面并绕过 CORS。扩展未连接时会超时。',
        parameters: {
            url: { type: 'string', required: true, description: '目标 URL' },
            method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'], description: 'HTTP 方法，默认 GET' },
            headers: { type: 'object', additionalProperties: true, description: '额外请求头（扩展会自动携带 Cookie）' },
            body: { type: 'string', description: '请求体（字符串）' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: true,
                properties: {
                    status: { type: 'number' },
                    statusText: { type: 'string' },
                    headers: { type: 'object', additionalProperties: true },
                    body: { type: 'string' },
                    error: { type: 'string' },
                },
            },
            render(_args, value) {
                if (value.error !== undefined)
                    return [textBlock(`转发失败: ${value.error}`)];
                const raw = typeof value.body === 'string' ? value.body : '';
                const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw);
                const title = titleMatch?.[1] !== undefined ? titleMatch[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').trim() : '';
                const isHtml = /<(html|head|body|title|div|p|span|a|table|meta)[^>]*>/i.test(raw);
                const text = isHtml ? htmlToText(raw) : raw;
                const head = text.slice(0, 12000);
                const more = text.length > 12000 ? `\n\n…(已截断，正文共 ${text.length} 字符)` : '';
                const line1 = `HTTP ${value.status ?? '?'}${title !== '' ? ` · ${title}` : ''}\n\n`;
                return [textBlock(line1 + head + more)];
            },
        },
        async execute(args, _exec) {
            try {
                await ensureDaemon();
                const payload = JSON.stringify({ url: args.url, method: args.method ?? 'GET', headers: args.headers ?? {}, body: args.body ?? null });
                const result = await run(`curl -s --max-time 35 -X POST ${daemonUrl}/forward -H "Content-Type: application/json" --data-binary @-`, payload);
                const out = result.stdout?.text ?? '';
                try {
                    return JSON.parse(out);
                }
                catch {
                    return { error: '无效响应' };
                }
            }
            catch (error) {
                return { error: error instanceof Error ? error.message : String(error) };
            }
        },
    }));
}
