/**
 * Model-facing `fetch_page` tool: forwards an HTTP request through the local
 * browser-extension relay daemon so the browser's cookie jar (and thus login
 * state) travels with the request while CORS is bypassed by the extension's
 * background fetch.
 *
 * @module @deepseek-ai/dsh-tool-fetch-page
 */
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "tool-fetch-page";
export declare const inject: string[];
/** Plugin config: relay daemon location and the shell workdir/workspace. */
export interface Config {
    /** Relay daemon base URL. */
    daemonUrl?: string;
    /** Absolute path to the relay daemon script (spawned on first use). */
    daemonPath?: string;
    /** Working directory for the shell commands. */
    workdir?: string;
    /** Sandbox workspace root for the shell commands. */
    workspaceRoot?: string;
}
export declare function apply(ctx: Context, config?: Config): void;
