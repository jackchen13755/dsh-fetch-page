import type { Context } from '@deepseek-ai/cordis'
export declare const name: 'tool-browser'
export declare const inject: string[]
export interface Config {
  browserHarnessPath?: string
  workdir?: string
  workspaceRoot?: string
}
export declare function apply(ctx: Context, config?: Config): void
