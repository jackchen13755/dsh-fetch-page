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
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "tool-browser";
export declare const inject: string[];
/** Plugin config: browser-harness CLI location and shell workdir/workspace. */
export interface Config {
    /** Absolute path to the browser-harness CLI (defaults to ~/.local/bin/browser-harness). */
    browserHarnessPath?: string;
    /** Working directory for the shell command. */
    workdir?: string;
    /** Sandbox workspace root for the shell command. */
    workspaceRoot?: string;
}
export declare function apply(ctx: Context, config?: Config): void;
