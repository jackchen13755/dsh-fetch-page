/**
 * Model-facing `browser` tool: drives the user's already-running Chrome through
 * the local `browser-harness` CLI (a thin CDP harness), so login state — cookies,
 * localStorage, sessionStorage — is the real browser's, not a fresh instance.
 * The model writes Python snippets against browser-harness's pre-imported helpers.
 *
 * @module @deepseek-ai/dsh-tool-browser
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ShellRunResult } from '@deepseek-ai/dsh-shell'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'tool-browser'
export const inject = ['tools', 'shell']

/** Plugin config: browser-harness CLI location and shell workdir/workspace. */
export interface Config {
  /** Absolute path to the browser-harness CLI (defaults to ~/.local/bin/browser-harness). */
  browserHarnessPath?: string
  /** Working directory for the shell command. */
  workdir?: string
  /** Sandbox workspace root for the shell command. */
  workspaceRoot?: string
}

/** A single model-facing text content block. */
function textBlock(text: string): { type: 'text'; text: string } {
  return { type: 'text', text }
}

export function apply(ctx: Context, config: Config = {}): void {
  const browserHarnessPath = config.browserHarnessPath ?? join(homedir(), '.local', 'bin', 'browser-harness')
  const workdir = config.workdir ?? homedir()
  const workspaceRoot = config.workspaceRoot ?? homedir()

  function run(cmd: string, stdin?: string): Promise<ShellRunResult> {
    return ctx.shell.run(ctx.shell.resolve({
      command: cmd,
      workdir,
      timeoutMs: 300000,
      stdoutMaxBytes: 8388608,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot },
      ...(stdin !== undefined ? { stdin } : {}),
    }))
  }

  ctx.tools.register(defineTool({
    name: 'browser',
    description: '控制用户正在运行的真实 Chrome（经本地 browser-harness 走 CDP，保留浏览器登录态）。传入一段 Python 代码操作页面。代码里已预置 helper（无需 import）：new_tab(url)、goto_url(url)、wait_for_load()、page_info()、capture_screenshot()、click_at_xy(x,y)、js("...")、http_get(url)、cdp("Domain.method", params)、ensure_real_tab()。首次打开页面用 new_tab(url) 而非 goto_url（避免覆盖用户当前标签页）；操作后建议 capture_screenshot() 验证。',
    parameters: {
      code: { type: 'string', required: true, description: '要执行的 Python 片段（browser-harness -c 的内容）；helper 已预导入。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          exitCode: { type: 'number' },
        },
      },
      render(_args, value) {
        const out = typeof value.stdout === 'string' ? value.stdout : ''
        const err = typeof value.stderr === 'string' ? value.stderr : ''
        const head = out.slice(0, 20000)
        const more = out.length > 20000 ? `\n\n…(stdout 已截断，共 ${out.length} 字符)` : ''
        const tail = err !== '' ? `\n\n[stderr]\n${err.slice(0, 4000)}` : ''
        const exit = typeof value.exitCode === 'number' && value.exitCode !== 0 ? `\n\n[exit code: ${value.exitCode}]` : ''
        return [textBlock(head + more + tail + exit)]
      },
    },
    async execute(args, _exec) {
      try {
        const code = typeof args.code === 'string' ? args.code : ''
        const tmp = `/tmp/bh-${Date.now()}-${Math.random().toString(36).slice(2)}.py`
        await run(`cat > "${tmp}"`, code)
        const result = await run(`"${browserHarnessPath}" -c "$(cat "${tmp}")"; rc=$?; rm -f "${tmp}"; exit $rc`)
        return {
          stdout: result.stdout?.text ?? '',
          stderr: result.stderr?.text ?? '',
          exitCode: result.exitCode ?? 0,
        }
      } catch (error) {
        return { stdout: '', stderr: error instanceof Error ? error.message : String(error), exitCode: 1 }
      }
    },
  }))
}
