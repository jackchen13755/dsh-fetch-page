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

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ShellRunResult } from '@deepseek-ai/dsh-shell'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'tool-fetch-page'
export const inject = ['tools', 'shell']

/** Plugin config: relay daemon location and the shell workdir/workspace. */
export interface Config {
  /** Relay daemon base URL. */
  daemonUrl?: string
  /** Absolute path to the relay daemon script (spawned on first use). */
  daemonPath?: string
  /** Working directory for the shell commands. */
  workdir?: string
  /** Sandbox workspace root for the shell commands. */
  workspaceRoot?: string
}

/** Strip HTML to readable text, isolating `<body>` and decoding common entities. */
function htmlToText(html: string): string {
  let s = html
  const bodyMatch = /<body[^>]*>([\s\S]*)<\/body>/i.exec(s)
  if (bodyMatch?.[1] !== undefined) s = bodyMatch[1]
  s = s.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|table|section|article|blockquote|pre|ul|ol|dl|dt|dd|header|footer|main|form|fieldset)[^>]*>/gi, '\n')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<\/(td|th)>/gi, ' ')
  s = s.replace(/<[^>]+>/g, ' ')
  s = s.replace(/&nbsp;/gi, ' ')
  s = s.replace(/&amp;/gi, '&')
  s = s.replace(/&lt;/gi, '<')
  s = s.replace(/&gt;/gi, '>')
  s = s.replace(/&quot;/gi, '"')
  s = s.replace(/&#0?39;/gi, "'")
  s = s.replace(/&#(\d+);/g, (_m, d: string) => String.fromCharCode(parseInt(d, 10)))
  s = s.split('\n').map((line) => line.replace(/[ \t\u00a0]+/g, ' ').replace(/^ +| +$/g, '')).join('\n')
  s = s.replace(/\n{3,}/g, '\n\n')
  return s.replace(/^[ \t\n]+|[ \t\n]+$/g, '')
}

/** A single model-facing text content block. */
function textBlock(text: string): { type: 'text'; text: string } {
  return { type: 'text', text }
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(Math.round(n), min), max)
}

export function apply(ctx: Context, config: Config = {}): void {
  const daemonUrl = config.daemonUrl ?? 'http://127.0.0.1:9317'
  const daemonPath = config.daemonPath ?? join(homedir(), 'dsh', 'dsh-relay-daemon')
  const workdir = config.workdir ?? homedir()
  const workspaceRoot = config.workspaceRoot ?? homedir()

  function run(cmd: string, stdin?: string, timeoutMs = 45000): Promise<ShellRunResult> {
    return ctx.shell.run(ctx.shell.resolve({
      command: cmd,
      workdir,
      timeoutMs,
      stdoutMaxBytes: 8388608,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot },
      ...(stdin !== undefined ? { stdin } : {}),
    }))
  }

  async function ensureDaemon(): Promise<void> {
    await run(`lsof -ti tcp:9317 -sTCP:LISTEN >/dev/null 2>&1 || (nohup /usr/local/bin/node ${daemonPath} > /tmp/dsh-relay-daemon.log 2>&1 &)`)
  }

  ctx.tools.register(defineTool({
    name: 'fetch_page',
    description:
      '通过浏览器扩展抓取页面：默认用浏览器 Cookie 转发 HTTP 请求（绕过 CORS，可访问登录态页面）。' +
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
        if (value.error !== undefined) return [textBlock(`转发失败: ${value.error}`)]
        const raw = typeof value.body === 'string' ? value.body : ''
        const rendered = value.rendered === true
        const title = rendered
          ? (typeof value.title === 'string' ? value.title : '')
          : ((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1]) ?? '').replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').trim()
        const isHtml = rendered ? false : /<(html|head|body|title|div|p|span|a|table|meta)[^>]*>/i.test(raw)
        const text = rendered ? raw : (isHtml ? htmlToText(raw) : raw)
        const head = text.slice(0, 12000)
        const more = text.length > 12000 ? `\n\n…(已截断，正文共 ${text.length} 字符)` : ''
        const prefix = rendered ? `SPA 渲染抓取 · HTTP ${value.status ?? 200}` : `HTTP ${value.status ?? '?'}`
        const line1 = `${prefix}${title !== '' ? ` · ${title}` : ''}\n\n`
        return [textBlock(line1 + head + more)]
      },
    },
    async execute(args, _exec) {
      try {
        await ensureDaemon()
        const mode = typeof args.mode === 'string' ? args.mode : 'auto'
        const timeout = clampInt(args.timeout, 45, 5, 120)
        const payload = JSON.stringify({
          url: args.url,
          method: args.method ?? 'GET',
          headers: args.headers ?? {},
          body: args.body ?? null,
          mode,
          wait_for_selector: args.wait_for_selector ?? '',
          target_selector: args.target_selector ?? '',
          timeout,
          scroll: clampInt(args.scroll, 0, 0, 20),
          format: args.format ?? 'markdown',
        })
        const curlTimeout = timeout + 15
        const result = await run(`curl -s --max-time ${curlTimeout} -X POST ${daemonUrl}/forward -H "Content-Type: application/json" --data-binary @-`, payload, (timeout + 30) * 1000)
        const out = result.stdout?.text ?? ''
        try {
          return JSON.parse(out)
        } catch {
          return { error: '无效响应' }
        }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
  }))
}
