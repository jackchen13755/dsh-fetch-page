/**
 * Model-facing `browser` + `verify_page` tools: drive the user's already-running
 * Chrome through the local `browser-harness` CLI (a thin CDP harness), so login
 * state — cookies, localStorage, sessionStorage — is the real browser's, not a
 * fresh instance.
 *
 * - `browser`: 执行一段 Python 片段操作浏览器（helper 预导入）。
 * - `verify_page`: 打开页面，按 JSON 断言契约校验 DOM/样式/文本，收集
 *   console/network 错误，失败时自动截图留证。
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

/** 生成 verify_page 的 Python 片段（browser-harness -c 执行）。 */
function buildVerifyScript(specPath: string): string {
  const p = JSON.stringify(specPath)
  return `
import json, time, sys

spec = json.loads(open(${p}, encoding='utf-8').read())
url = spec.get('url') or ''
wait_for_selector = spec.get('wait_for_selector') or ''
timeout = float(spec.get('timeout') or 30)
assertions = spec.get('assertions') or []
screenshot = spec.get('screenshot') is True
fail_on_console_errors = spec.get('fail_on_console_errors') is True

# 打开真实标签页，并在导航前开启 CDP 日志/网络监听
tid = cdp('Target.createTarget', url='about:blank')['targetId']
switch_tab(tid)
try:
    cdp('Log.enable')
    cdp('Network.enable')
    cdp('Runtime.enable')
except Exception:
    pass
goto_url(url)
ok_load = wait_for_load(timeout)

if wait_for_selector:
    deadline = time.time() + timeout
    found = False
    while time.time() < deadline:
        if js('!!document.querySelector(' + json.dumps(wait_for_selector) + ')'):
            found = True
            break
        time.sleep(0.3)
    if not found:
        print(json.dumps({'ok': False, 'error': 'wait_for_selector 超时: ' + wait_for_selector}, ensure_ascii=False))
        sys.exit(0)
elif not ok_load:
    print(json.dumps({'ok': False, 'error': '页面加载超时（readyState 未 complete）'}, ensure_ascii=False))
    sys.exit(0)

results = []
for i, a in enumerate(assertions):
    t = a.get('type') or 'selector_exists'
    sel = a.get('selector') or ''
    try:
        if t == 'selector_exists':
            actual = js('!!document.querySelector(' + json.dumps(sel) + ')')
            expected = a.get('expect', True)
            passed = bool(actual) == bool(expected)
            results.append({'index': i, 'type': t, 'selector': sel, 'pass': passed, 'expected': expected, 'actual': bool(actual)})
        elif t == 'selector_visible':
            actual = js("(()=>{const e=document.querySelector(" + json.dumps(sel) + "); if(!e) return false; const r=e.getBoundingClientRect(); const cs=getComputedStyle(e); return (r.width>0||r.height>0) && cs.display!=='none' && cs.visibility!=='hidden';})()")
            expected = a.get('expect', True)
            passed = bool(actual) == bool(expected)
            results.append({'index': i, 'type': t, 'selector': sel, 'pass': passed, 'expected': expected, 'actual': bool(actual)})
        elif t == 'text_contains':
            actual = js('((document.querySelector(' + json.dumps(sel) + ')||{}).textContent || "")')
            expected = a.get('text') or ''
            passed = expected in actual
            results.append({'index': i, 'type': t, 'selector': sel, 'pass': passed, 'expected': expected, 'actual': actual[:500]})
        elif t == 'text_equals':
            actual = (js('((document.querySelector(' + json.dumps(sel) + ')||{}).textContent || "")') or '').strip()
            expected = (a.get('text') or '').strip()
            passed = actual == expected
            results.append({'index': i, 'type': t, 'selector': sel, 'pass': passed, 'expected': expected, 'actual': actual[:500]})
        elif t == 'count':
            actual = js('document.querySelectorAll(' + json.dumps(sel) + ').length')
            passed = True
            if 'equals' in a:
                passed = actual == int(a.get('equals'))
            if 'min' in a:
                passed = passed and actual >= int(a.get('min'))
            if 'max' in a:
                passed = passed and actual <= int(a.get('max'))
            results.append({'index': i, 'type': t, 'selector': sel, 'pass': passed, 'expected': a, 'actual': actual})
        elif t == 'attribute':
            name = a.get('name') or ''
            actual = js('((document.querySelector(' + json.dumps(sel) + ')||{}).getAttribute && (document.querySelector(' + json.dumps(sel) + ')||{}).getAttribute(' + json.dumps(name) + ')) || ""')
            if a.get('contains') is not None:
                passed = str(a.get('contains')) in str(actual)
                expected = 'contains: ' + str(a.get('contains'))
            else:
                expected = a.get('equals') or ''
                passed = str(actual) == str(expected)
            results.append({'index': i, 'type': t, 'selector': sel, 'pass': passed, 'expected': expected, 'actual': actual})
        elif t == 'style':
            prop = a.get('prop') or ''
            actual = js("(()=>{const e=document.querySelector(" + json.dumps(sel) + "); return e ? getComputedStyle(e)[" + json.dumps(prop) + "] : '';})()")
            if a.get('contains') is not None:
                passed = str(a.get('contains')) in str(actual)
                expected = 'contains: ' + str(a.get('contains'))
            else:
                expected = a.get('equals') or ''
                passed = str(actual) == str(expected)
            results.append({'index': i, 'type': t, 'selector': sel, 'pass': passed, 'expected': expected, 'actual': actual})
        else:
            results.append({'index': i, 'type': t, 'selector': sel, 'pass': False, 'expected': None, 'actual': None, 'message': '未知断言类型: ' + t})
    except Exception as e:
        results.append({'index': i, 'type': t, 'selector': sel, 'pass': False, 'expected': None, 'actual': None, 'message': str(e)})

# console / network 错误收集
console_errors = []
network_errors = []
try:
    req_url = {}
    for ev in drain_events():
        m = ev.get('method') or ''
        p = ev.get('params') or {}
        if m == 'Network.requestWillBeSent':
            rid = p.get('requestId') or ''
            rurl = (p.get('request') or {}).get('url') or ''
            if rid and rurl:
                req_url[rid] = rurl
        elif m == 'Log.entryAdded':
            entry = p.get('entry') or {}
            level = entry.get('level') or ''
            text = entry.get('text') or ''
            if level == 'error' or (text and 'error' in text.lower()):
                console_errors.append({'level': level, 'text': text[:500]})
        elif m == 'Network.loadingFailed':
            rid = p.get('requestId') or ''
            network_errors.append({'url': req_url.get(rid, rid), 'errorText': p.get('errorText') or '', 'type': p.get('type') or ''})
except Exception:
    pass

all_assertions_pass = all(r.get('pass') for r in results)
passed_all = all_assertions_pass and (not fail_on_console_errors or not console_errors)

screenshot_path = None
if (not passed_all) or screenshot:
    try:
        screenshot_path = capture_screenshot()
    except Exception as e:
        screenshot_path = None

report = {
    'ok': passed_all,
    'url': js('location.href'),
    'title': js('document.title'),
    'assertions': results,
    'console_errors': console_errors,
    'network_errors': network_errors,
    'screenshot': screenshot_path,
}
print(json.dumps(report, ensure_ascii=False, default=str))
`
}

function extractReport(out: string): Record<string, unknown> | null {
  const text = (out || '').trim()
  if (!text) return null
  // browser-harness 可能先打印更新横幅，从第一个 { 开始尝试解析
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
    } catch { /* fallthrough */ }
  }
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
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

  ctx.tools.register(defineTool({
    name: 'verify_page',
    description:
      '打开真实 Chrome 页面，按 JSON 断言契约验证开发结果（元素存在/可见、文本、数量、属性、样式），' +
      '收集 console/network 错误，失败时自动截图留证。保留浏览器登录态，适合验证本地 dev server 页面。' +
      '断言项 type 支持：selector_exists（expect:true/false）、selector_visible（expect:true/false）、' +
      'text_contains（text）、text_equals（text）、count（equals/min/max）、attribute（name + equals/contains）、style（prop + equals/contains）。',
    parameters: {
      url: { type: 'string', required: true, description: '要打开的页面 URL（http://localhost:3000/... 或线上地址）' },
      assertions: {
        type: 'array',
        required: true,
        description: '断言契约数组，每项至少包含 type 与 selector（text/attribute/style 等按需附带其他字段）。示例：[{"type":"selector_visible","selector":".btn-primary","expect":true},{"type":"text_contains","selector":".title","text":"订单"}]',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            type: { type: 'string' },
            selector: { type: 'string' },
            expect: { type: 'boolean' },
            text: { type: 'string' },
            equals: { type: 'string' },
            contains: { type: 'string' },
            min: { type: 'number' },
            max: { type: 'number' },
            name: { type: 'string' },
            prop: { type: 'string' },
          },
        },
      },
      wait_for_selector: { type: 'string', description: '可选：等待该 CSS 选择器出现后再开始断言（SPA 渲染等待）' },
      timeout: { type: 'number', description: '页面加载/等待超时秒数，默认 30' },
      screenshot: { type: 'boolean', description: '是否始终截图（默认只在失败时自动截图）' },
      fail_on_console_errors: { type: 'boolean', description: '有 console error 时是否判定失败，默认 false（只收集报告）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          url: { type: 'string' },
          title: { type: 'string' },
          assertions: { type: 'array' },
          consoleErrors: { type: 'array' },
          networkErrors: { type: 'array' },
          screenshot: { type: 'string' },
          error: { type: 'string' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
        },
      },
      render(_args, value) {
        if (value.error !== undefined) return [textBlock(`验证失败: ${value.error}`)]
        const ok = value.ok === true
        const title = typeof value.title === 'string' && value.title !== '' ? ` · ${value.title}` : ''
        const url = typeof value.url === 'string' ? value.url : ''
        const assertions = Array.isArray(value.assertions) ? value.assertions : []
        const failed = assertions.filter((a: { pass?: boolean }) => a && a.pass !== true)
        const consoleErrors = Array.isArray(value.consoleErrors) ? value.consoleErrors : []
        const networkErrors = Array.isArray(value.networkErrors) ? value.networkErrors : []
        const lines: string[] = []
        lines.push(`${ok ? '✅ 验证通过' : '❌ 验证失败'}${title}`)
        lines.push(`URL: ${url}`)
        lines.push(`断言: ${assertions.length - failed.length}/${assertions.length} 通过`)
        if (failed.length > 0) {
          lines.push('')
          lines.push('失败项:')
          for (const f of failed) {
            const index = (f && f.index) ?? '?'
            const type = (f && f.type) ?? '?'
            const selector = (f && f.selector) ?? ''
            const message = (f && f.message) ?? ''
            const expected = JSON.stringify((f && f.expected) ?? '')
            const actual = JSON.stringify((f && f.actual) ?? '')
            lines.push(`- [${index}] ${type} ${selector}`)
            lines.push(`  expected: ${expected}`)
            lines.push(`  actual:   ${actual}`)
            if (message) lines.push(`  message: ${message}`)
          }
        }
        if (consoleErrors.length > 0) {
          lines.push('')
          lines.push(`Console 错误 (${consoleErrors.length}):`)
          for (const c of consoleErrors.slice(0, 10)) lines.push(`- [${(c && c.level) ?? 'error'}] ${(c && c.text) ?? ''}`)
        }
        if (networkErrors.length > 0) {
          lines.push('')
          lines.push(`网络请求失败 (${networkErrors.length}):`)
          for (const n of networkErrors.slice(0, 10)) lines.push(`- ${(n && n.errorText) ?? ''} ${(n && n.url) ?? ''}`)
        }
        if (typeof value.screenshot === 'string' && value.screenshot !== '') {
          lines.push('')
          lines.push(`截图: ${value.screenshot}`)
        }
        return [textBlock(lines.join('\n'))]
      },
    },
    async execute(args, _exec) {
      const tmpBase = `/tmp/bh-verify-${Date.now()}-${Math.random().toString(36).slice(2)}`
      const specPath = `${tmpBase}.json`
      const pyPath = `${tmpBase}.py`
      try {
        const spec = {
          url: args.url,
          assertions: Array.isArray(args.assertions) ? args.assertions : [],
          wait_for_selector: args.wait_for_selector ?? '',
          timeout: typeof args.timeout === 'number' ? args.timeout : 30,
          screenshot: args.screenshot === true,
          fail_on_console_errors: args.fail_on_console_errors === true,
        }
        await run(`cat > "${specPath}"`, JSON.stringify(spec))
        await run(`cat > "${pyPath}"`, buildVerifyScript(specPath))
        const result = await run(`"${browserHarnessPath}" -c "$(cat "${pyPath}")"; rc=$?; rm -f "${specPath}" "${pyPath}"; exit $rc`)
        const out = result.stdout?.text ?? ''
        const err = result.stderr?.text ?? ''
        const report = extractReport(out)
        if (report) return report
        return { error: '无法解析验证报告', stdout: out.slice(0, 8000), stderr: err.slice(0, 4000) }
      } catch (error) {
        try { await run(`rm -f "${specPath}" "${pyPath}"`) } catch { /* noop */ }
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
  }))
}
