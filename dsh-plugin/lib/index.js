/**
 * Model-facing `fetch_page` tool: forwards an HTTP request through the local
 * browser-extension relay daemon so the browser's cookie jar (and thus login
 * state) travels with the request while CORS is bypassed by the extension's
 * background fetch.
 *
 * 新增 SPA 渲染模式：`mode: "render"` 时扩展会在真实标签页中执行 JS，
 * 等待 SPA 渲染稳定后用 Readability + Turndown 提取正文（Markdown/Text/HTML）。
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
function clampInt(value, fallback, min, max) {
    const n = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);
    if (!Number.isFinite(n))
        return fallback;
    return Math.min(Math.max(Math.round(n), min), max);
}
// ---- 禅道解决 Bug 常用解析辅助 ----
function isLoggedIn(html) {
    return !/m=user&f=login/.test(html);
}
function currentStatus(html) {
    const m = html.match(/<th>\s*Bug状态\s*<\/th>\s*<td[^>]*>\s*<span[^>]*>([^<]*)<\/span>/);
    if (m?.[1])
        return m[1].trim();
    const m2 = html.match(/<th>\s*Bug状态\s*<\/th>\s*<td[^>]*>([^<]+)<\/td>/);
    return m2?.[1]?.trim() ?? '';
}
function lastResolvedBuild(html) {
    const re = /解决版本[\s\S]{0,300}?旧值为\s*["']([^"']*)["']\s*，\s*新值为\s*["']([^"']*)["']/g;
    let m;
    let build = '';
    while ((m = re.exec(html))) {
        if (m[2])
            build = m[2];
    }
    return build;
}
function extractRequiredFields(html) {
    const set = new Set();
    const cfg = html.match(/requiredFields":\s*"([^"]*)"/);
    if (cfg && cfg[1])
        for (const f of cfg[1].split(','))
            if (f)
                set.add(f.trim());
    const tdRe = /<td\b[^>]*\bclass=(["'])[^"']*\brequired\b[^"']*\1[^>]*>[\s\S]*?<(?:select|input|textarea)\b[^>]*\bname=(["'])([^"']+)\2/g;
    let m;
    while ((m = tdRe.exec(html)))
        if (m && m[3])
            set.add(m[3]);
    const ctrlRe = /<(?:select|input|textarea)\b[^>]*\bname=(["'])([^"']+)\1[^>]*\bclass=(["'])[^"']*\brequired\b[^"']*\3/g;
    while ((m = ctrlRe.exec(html)))
        if (m && m[2])
            set.add(m[2]);
    const ctrlRe2 = /<(?:select|input|textarea)\b[^>]*\bclass=(["'])[^"']*\brequired\b[^"']*\1[^>]*\bname=(["'])([^"']+)\2/g;
    while ((m = ctrlRe2.exec(html)))
        if (m && m[3])
            set.add(m[3]);
    return [...set];
}
function tagByName(html, tag, name) {
    const re = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
    for (const m of html.matchAll(re)) {
        const full = m[0];
        if (new RegExp(`\\bname=(['\"])${name}\\1`).test(full))
            return full;
    }
    return '';
}
function selectedValue(html, name) {
    const selMatch = html.match(new RegExp(`<select\\b[^>]*\\bname=(['\"])${name}\\1[^>]*>([\\s\\S]*?)<\\/select>`));
    if (!selMatch)
        return '';
    const options = (selMatch[2] ?? '').match(/<option\b[^>]*>[\s\S]*?<\/option>|<option[^>]*\/?>/g) || [];
    for (const opt of options) {
        if (/\bselected\b/.test(opt)) {
            const vm = opt.match(/\bvalue=(['"])(.*?)\1/);
            return vm?.[2] ?? '';
        }
    }
    return '';
}
function inputValue(html, name) {
    const tag = tagByName(html, 'input', name);
    if (!tag)
        return '';
    const vm = tag.match(/\bvalue=(['"])(.*?)\1/);
    return vm?.[2] ?? '';
}
function textareaValue(html, name) {
    const re = new RegExp(`<textarea\\b[^>]*\\bname=(['\"])${name}\\1[^>]*>([\\s\\S]*?)<\\/textarea>`, 'i');
    const m = html.match(re);
    return m?.[2] ?? '';
}
function parseForm(html) {
    const kuid = (html.match(/var kuid = '([^']+)'/) || [])[1] || inputValue(html, 'uid');
    return {
        uid: kuid,
        bugInchargedBy: selectedValue(html, 'bugInchargedBy'),
        assignedTo: selectedValue(html, 'assignedTo'),
        resolvedDate: inputValue(html, 'resolvedDate'),
        detailReason: textareaValue(html, 'detail_reason'),
        changeImpact: textareaValue(html, 'changeImpact'),
        resolvedBuild: selectedValue(html, 'resolvedBuild'),
        requiredFields: extractRequiredFields(html),
    };
}
export function apply(ctx, config = {}) {
    const daemonUrl = config.daemonUrl ?? 'http://127.0.0.1:9317';
    const daemonPath = config.daemonPath ?? join(homedir(), 'dsh', 'dsh-relay-daemon');
    const workdir = config.workdir ?? homedir();
    const workspaceRoot = config.workspaceRoot ?? homedir();
    function run(cmd, stdin, timeoutMs = 45000) {
        return ctx.shell.run(ctx.shell.resolve({
            command: cmd,
            workdir,
            timeoutMs,
            stdoutMaxBytes: 8388608,
            sandboxPolicy: { mode: 'danger-full-access', workspaceRoot },
            ...(stdin !== undefined ? { stdin } : {}),
        }));
    }
    async function ensureDaemon() {
        await run(`lsof -ti tcp:9317 -sTCP:LISTEN >/dev/null 2>&1 || (nohup /usr/local/bin/node ${daemonPath} > /tmp/dsh-relay-daemon.log 2>&1 &)`);
    }
    /** 统一的浏览器转发入口：把请求交给本地守护进程，由浏览器扩展用当前登录态执行。 */
    async function bridgeForward(req) {
        const timeout = clampInt(req.timeout, 45, 5, 120);
        const payload = JSON.stringify({
            url: req.url,
            method: req.method ?? 'GET',
            headers: req.headers ?? {},
            body: req.body ?? null,
            mode: req.mode ?? 'auto',
            wait_for_selector: req.wait_for_selector ?? '',
            target_selector: req.target_selector ?? '',
            timeout,
            scroll: clampInt(req.scroll, 0, 0, 20),
            format: req.format ?? 'markdown',
        });
        const curlTimeout = timeout + 15;
        const result = await run(`curl -s --max-time ${curlTimeout} -X POST ${daemonUrl}/forward -H "Content-Type: application/json" --data-binary @-`, payload, (timeout + 30) * 1000);
        const out = result.stdout?.text ?? '';
        try {
            return JSON.parse(out);
        }
        catch {
            throw new Error('浏览器转发返回无效 JSON: ' + out.slice(0, 200));
        }
    }
    ctx.tools.register(defineTool({
        name: 'fetch_page',
        description: '通过浏览器扩展抓取页面：直接使用浏览器插件桥接（本地守护进程 → 扩展后台 fetch），默认自动携带浏览器 Cookie（绕过 CORS，可访问登录态页面），无需读取或请求 Chrome Cookie 权限。' +
            '单页应用（SPA）内容由 JS 渲染、纯 HTTP 拿不到时，用 mode:"render" 在真实标签页中执行 JS 并提取正文；' +
            'mode:"auto" 会先轻量抓取、发现是 SPA 空壳时自动升级为渲染。' +
            '渲染模式可配合 wait_for_selector（等某元素出现）、target_selector（只提取页内某区域）、scroll（无限滚动加载次数）、format（markdown/text/html）。',
        parameters: {
            url: { type: 'string', required: true, description: '目标 URL' },
            method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'], description: 'HTTP 方法，默认 GET（渲染模式仅支持 GET）' },
            headers: { type: 'object', additionalProperties: true, description: '额外请求头（扩展会自动携带浏览器 Cookie）' },
            body: { type: 'string', description: '请求体（字符串，仅非 GET 生效）' },
            mode: { type: 'string', enum: ['auto', 'fetch', 'render'], description: '抓取模式：auto=先轻量抓取、SPA 空壳自动升级渲染（默认）；fetch=纯 HTTP 不执行 JS；render=真实标签页执行 JS 后提取' },
            wait_for_selector: { type: 'string', description: '渲染模式：等待该 CSS 选择器出现后再提取（如 .content、#root table）' },
            target_selector: { type: 'string', description: '渲染模式：只提取该 CSS 选择器对应区域的内容' },
            timeout: { type: 'number', description: '渲染等待/请求超时秒数，默认 45，最大 120' },
            scroll: { type: 'number', description: '渲染模式：提取前滚动到底部的次数（无限滚动/懒加载页面用），默认 0，最大 20' },
            format: { type: 'string', enum: ['markdown', 'text', 'html'], description: '渲染模式输出格式，默认 markdown' },
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
                    rendered: { type: 'boolean' },
                    title: { type: 'string' },
                    text: { type: 'string' },
                    markdown: { type: 'string' },
                    url: { type: 'string' },
                    error: { type: 'string' },
                },
            },
            render(_args, value) {
                if (value.error !== undefined)
                    return [textBlock(`转发失败: ${value.error}`)];
                const raw = typeof value.body === 'string' ? value.body : '';
                const rendered = value.rendered === true;
                const title = rendered
                    ? (typeof value.title === 'string' ? value.title : '')
                    : ((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1]) ?? '').replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').trim();
                const isHtml = rendered ? false : /<(html|head|body|title|div|p|span|a|table|meta)[^>]*>/i.test(raw);
                const text = rendered ? raw : (isHtml ? htmlToText(raw) : raw);
                const head = text.slice(0, 12000);
                const more = text.length > 12000 ? `\n\n…(已截断，正文共 ${text.length} 字符)` : '';
                const prefix = rendered ? `SPA 渲染抓取 · HTTP ${value.status ?? 200}` : `HTTP ${value.status ?? '?'}`;
                const line1 = `${prefix}${title !== '' ? ` · ${title}` : ''}\n\n`;
                return [textBlock(line1 + head + more)];
            },
        },
        async execute(args, _exec) {
            try {
                await ensureDaemon();
                return await bridgeForward({
                    url: args.url,
                    method: args.method ?? 'GET',
                    headers: (args.headers ?? {}),
                    body: typeof args.body === 'string' ? args.body : null,
                    mode: typeof args.mode === 'string' ? args.mode : 'auto',
                    wait_for_selector: args.wait_for_selector ?? '',
                    target_selector: args.target_selector ?? '',
                    ...(args.timeout !== undefined ? { timeout: args.timeout } : {}),
                    ...(args.scroll !== undefined ? { scroll: args.scroll } : {}),
                    format: args.format ?? 'markdown',
                });
            }
            catch (error) {
                return { error: error instanceof Error ? error.message : String(error) };
            }
        },
    }));
    // ---- zentao_resolve_bug 工具（复用 fetch_page 的浏览器转发链路） ----
    async function forward(method, url, headers, body) {
        return bridgeForward({
            url, method, headers: headers || {}, body: body || null,
            mode: 'fetch', timeout: 60, scroll: 0, wait_for_selector: '', target_selector: '', format: 'html',
        });
    }
    function maybeThrow(resp, label) {
        if (resp?.error)
            throw new Error(`${label}: ${resp.error}`);
        const st = Number(resp?.status ?? 200);
        if (st >= 400)
            throw new Error(`${label}: HTTP ${st}${resp.statusText ? ' ' + resp.statusText : ''}`);
    }
    ctx.tools.register(defineTool({
        name: 'zentao_resolve_bug',
        description: '通过浏览器插件桥接解决禅道 Bug（zen.sgrl.io）：复用 fetch_page 的浏览器转发链路，读取当前登录态的详情/解决表单、解析 uid 与默认值、标注必填项，并提交解决。无需读取 Chrome Cookie。',
        parameters: {
            bugID: { type: 'string', required: true, description: '禅道 Bug ID（必填）' },
            resolution: { type: 'string', enum: ['bydesign', 'duplicate', 'external', 'fixed', 'notrepro', 'postponed', 'willnotfix'], description: '解决方案，默认 fixed' },
            reason: { type: 'string', description: 'Bug产生原因，默认 codeBug' },
            build: { type: 'string', description: '解决版本 build ID；缺省自动取该 bug 最近一次解决版本，其次取解决表单默认 resolvedBuild' },
            comment: { type: 'string', description: '备注' },
            detail: { type: 'string', description: 'bug详细原因' },
            impact: { type: 'string', description: '代码变更影响范围' },
            assignedTo: { type: 'string', description: '指派给（缺省使用表单默认）' },
            inChargedBy: { type: 'string', description: 'Bug所属人（表单必填项，建议显式指定）' },
            force: { type: 'boolean', description: '当前已是已解决时仍强制再次解决' },
            dryRun: { type: 'boolean', description: '只解析并返回提交字段，不真正提交' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: true,
                properties: {
                    ok: { type: 'boolean' },
                    dryRun: { type: 'boolean' },
                    bugID: { type: 'string' },
                    status: { type: 'string' },
                    message: { type: 'string' },
                    fields: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
                    required: { type: 'array', items: { type: 'string' } },
                    missingRequired: { type: 'array', items: { type: 'string' } },
                    url: { type: 'string' },
                    error: { type: 'string' },
                    body: { type: 'string' },
                },
            },
            render(_args, value) {
                if (value.error !== undefined && value.error !== '')
                    return [textBlock(`错误: ${value.error}`)];
                const lines = [];
                if (value.dryRun)
                    lines.push(`[dry-run] Bug ${value.bugID} 将提交以下字段（当前状态：${value.status || '未知'}）：`);
                else if (value.ok)
                    lines.push(`成功：Bug ${value.bugID} 状态已变为「${value.status}」。`);
                else
                    lines.push(`提交完成但校验异常：Bug ${value.bugID} 状态「${value.status || '未知'}」。`);
                if (Array.isArray(value.fields)) {
                    const req = new Set(value.required || []);
                    for (const item of value.fields) {
                        const [k, v] = item;
                        lines.push(`  ${k} = ${v || '(空)'}${req.has(k) ? '  [必填]' : ''}`);
                    }
                }
                if (Array.isArray(value.missingRequired) && value.missingRequired.length)
                    lines.push(`注意：必填项为空：${value.missingRequired.join(', ')}`);
                if (value.message)
                    lines.push(value.message);
                if (value.url)
                    lines.push(value.url);
                return [textBlock(lines.join('\n'))];
            },
        },
        async execute(args, _exec) {
            const a = args;
            try {
                await ensureDaemon();
                const bugID = String(a.bugID ?? '');
                if (!bugID)
                    return { error: '缺少 bugID' };
                const base = process.env.ZENTAO_BASE || 'https://zen.sgrl.io';
                const viewUrl = `${base}/index.php?m=bug&f=view&bugID=${bugID}`;
                const formUrl = `${base}/index.php?m=bug&f=resolve&bugID=${bugID}&onlybody=yes`;
                const viewResp = await forward('GET', viewUrl);
                maybeThrow(viewResp, '获取详情页失败');
                const viewHtml = String(viewResp.body ?? '');
                if (!isLoggedIn(viewHtml))
                    throw new Error('浏览器未登录 zen.sgrl.io，请确认浏览器已登录后重试。');
                const status = currentStatus(viewHtml);
                if (!a.dryRun && status === '已解决' && !a.force) {
                    return { ok: true, bugID, status, message: '当前已是已解决，无需操作；如需再次解决请加 force=true', url: viewUrl };
                }
                const formResp = await forward('GET', formUrl);
                maybeThrow(formResp, '获取解决表单失败');
                const formHtml = String(formResp.body ?? '');
                if (!isLoggedIn(formHtml))
                    throw new Error('浏览器未登录 zen.sgrl.io，无法打开解决表单。');
                const form = parseForm(formHtml);
                if (!form.uid)
                    throw new Error('解析解决表单失败：未找到 uid（kuid）。');
                const build = String(a.build ?? '') || lastResolvedBuild(viewHtml) || String(form.resolvedBuild ?? '');
                const fields = [
                    ['resolution', String(a.resolution ?? 'fixed')],
                    ['reason', String(a.reason ?? 'codeBug')],
                    ['bugInchargedBy', String(a.inChargedBy || form.bugInchargedBy || '')],
                    ['assignedTo', String(a.assignedTo || form.assignedTo || '')],
                    ['resolvedDate', String(form.resolvedDate ?? '')],
                    ['uid', String(form.uid ?? '')],
                ];
                if (build)
                    fields.push(['resolvedBuild', build]);
                if (a.impact || form.changeImpact)
                    fields.push(['changeImpact', String(a.impact || form.changeImpact || '')]);
                if (a.comment)
                    fields.push(['comment', String(a.comment)]);
                if (a.detail)
                    fields.push(['detail_reason', String(a.detail)]);
                const required = Array.isArray(form.requiredFields) ? form.requiredFields : [];
                const requiredSet = new Set(required);
                const absentRequired = required.filter((r) => !fields.some(([k]) => k === r));
                const emptyRequired = fields.filter(([k, v]) => requiredSet.has(k) && !v).map(([k]) => k);
                const missingRequired = [...absentRequired, ...emptyRequired];
                if (a.dryRun) {
                    return { ok: true, dryRun: true, bugID, status, fields, required, missingRequired, url: viewUrl };
                }
                if (missingRequired.length > 0) {
                    return { ok: false, error: `必填项为空，未提交：${missingRequired.join(', ')}。请提供对应参数。`, bugID, status, fields, required, missingRequired, url: viewUrl };
                }
                const body = fields
                    .filter(([, v]) => v !== undefined && v !== null && v !== '')
                    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
                    .join('&');
                const postResp = await forward('POST', formUrl, { 'Content-Type': 'application/x-www-form-urlencoded' }, body);
                maybeThrow(postResp, '提交失败');
                const afterResp = await forward('GET', viewUrl);
                const afterStatus = currentStatus(String(afterResp.body ?? ''));
                if (afterStatus === '已解决') {
                    return { ok: true, bugID, status: afterStatus, message: '成功，Bug 已解决', url: viewUrl };
                }
                return { ok: false, bugID, status: afterStatus || '未知', message: '提交完成但状态校验异常，请打开页面确认', url: viewUrl, body: String(postResp.body ?? '').slice(0, 500) };
            }
            catch (e) {
                return { error: e instanceof Error ? e.message : String(e) };
            }
        },
    }));
}
//# sourceMappingURL=index.js.map