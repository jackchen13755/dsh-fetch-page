#!/usr/bin/env node
/**
 * Offline contract test for the `ctx.shell` foreground seam, for both plugins in this
 * repo. It runs against the *compiled* `lib/` output — the artifact that actually ships.
 *
 * Why this exists: a harness upgrade broke `fetch_page` with "ctx.shell.run is not a
 * function". 0.1.7 *replaced* the seam's foreground API — `run(spec)` is gone and the
 * projection moved onto the handle (`execute(spec)` → `await handle.result()`) — while
 * the versions this repo pins in node_modules still declare `run`. So the stale call
 * typechecked and only died at runtime, inside a plugin the type checker can't reach.
 *
 * The checks below therefore drive each registered tool against a fake seam shaped like
 * the *installed* harness (a seam with no `run` at all), which is exactly the condition
 * that used to fail. A legacy seam keeps being exercised so the declared peer range
 * (0.1.1/0.1.2, which only have `run`) does not silently rot.
 *
 * Usage: node scripts/smoke-seam.mjs
 */
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/*
 * The compiled libs import `defineTool` from @deepseek-ai/dsh-tools, but the version
 * pinned in this repo's node_modules can no longer resolve standalone (it asks for
 * @deepseek-ai/dsh-scope, which was never installed). The shell seam is what this suite
 * exercises, so map that single dependency to a minimal stub rather than depending on
 * an install — the real dsh-tools is covered by the live end-to-end check instead.
 */
const TOOLS_STUB = 'data:text/javascript,' + encodeURIComponent(`
export function defineTool(options) {
  return {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    output: options.output,
    execute: options.execute,
  }
}
`)

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-tools') return { url: TOOLS_STUB, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

const { apply: applyFetchPage } = await import('../dsh-plugin/lib/index.js')
const { apply: applyBrowser } = await import('../browser-plugin/lib/index.js')

/** The exact broken expression the upgrade surfaced; must never come back. */
const ORIGINAL_BUG = 'ctx.shell.run(ctx.shell.resolve('

const results = []

/** Run one named check, recording pass/fail instead of aborting the suite. */
async function check(name, fn) {
  try {
    await fn()
    results.push([true, name])
  } catch (error) {
    results.push([false, name, error instanceof Error ? error.message : String(error)])
  }
}

/** Minimal `ShellRunResult` — the plugins only read `stdout.text`/`stderr.text`. */
function runResult(text) {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 0,
    stdout: { text },
    stderr: { text: '' },
  }
}

/** A fake `ctx` that captures tool registrations; `shell` is the seam under test. */
function harness(shell) {
  const tools = new Map()
  return { ctx: { tools: { register: (tool) => tools.set(tool.name, tool) }, shell }, tools }
}

/**
 * Seam shaped like the installed harness (>= 0.1.7): `execute()` hands back a handle
 * whose `result()` is the foreground projection. Deliberately has NO `run`.
 */
function currentSeam(calls, payload) {
  return {
    resolve: (request) => ({
      ...request,
      workdir: request.workdir ?? '/tmp',
      timeoutMs: request.timeoutMs ?? 45000,
      onExpiry: 'kill',
      stdoutMaxBytes: request.stdoutMaxBytes ?? 8388608,
    }),
    async execute(spec) {
      calls.push(spec)
      return { result: async () => runResult(payload) }
    },
  }
}

/** Seam shaped like the pinned devDependency (< 0.1.7): `run()` returns the result. */
function legacySeam(calls, payload) {
  return {
    resolve: (request) => ({
      ...request,
      workdir: request.workdir ?? '/tmp',
      timeoutMs: request.timeoutMs ?? 45000,
      onExpiry: 'kill',
      stdoutMaxBytes: request.stdoutMaxBytes ?? 8388608,
    }),
    async run(spec) {
      calls.push(spec)
      return runResult(payload)
    },
  }
}

/** A seam with no foreground API at all — must fail loudly, not with a TypeError. */
function emptySeam() {
  return { resolve: (request) => ({ ...request, workdir: '/tmp', timeoutMs: 45000 }) }
}

const FORWARDED = {
  status: 200,
  url: 'https://example.com/',
  title: 'Example Domain',
  content: 'hello from the bridge',
  mode: 'fetch',
}

// ---------------------------------------------------------------- fetch_page

await check('fetch_page: registers', () => {
  const { ctx, tools } = harness(currentSeam([], '{}'))
  applyFetchPage(ctx, { workdir: '/tmp', workspaceRoot: '/tmp' })
  if (!tools.has('fetch_page')) throw new Error('fetch_page was not registered')
})

await check('fetch_page: current seam (execute + result) forwards the request', async () => {
  const calls = []
  const { ctx, tools } = harness(currentSeam(calls, JSON.stringify(FORWARDED)))
  applyFetchPage(ctx, { workdir: '/tmp', workspaceRoot: '/tmp' })

  const out = await tools.get('fetch_page').execute({ url: FORWARDED.url, timeout: 20 }, {})
  if (out?.error) throw new Error(`tool returned an error: ${out.error}`)
  if (out.status !== 200 || out.content !== FORWARDED.content) {
    throw new Error(`payload did not round-trip: ${JSON.stringify(out).slice(0, 200)}`)
  }
})

await check('fetch_page: caller timeoutMs reaches the spec (no hard-coded override)', async () => {
  const calls = []
  const { ctx, tools } = harness(currentSeam(calls, JSON.stringify(FORWARDED)))
  applyFetchPage(ctx, { workdir: '/tmp', workspaceRoot: '/tmp' })

  await tools.get('fetch_page').execute({ url: FORWARDED.url, timeout: 20 }, {})
  // bridgeForward runs curl under (timeout + 30) * 1000 = 50000 for timeout 20.
  const seen = calls.map((call) => call.timeoutMs)
  if (!seen.includes(50000)) {
    throw new Error(`timeoutMs was not forwarded; specs saw ${JSON.stringify(seen)} (expected 50000)`)
  }
})

await check('fetch_page: legacy seam (run) still works', async () => {
  const calls = []
  const { ctx, tools } = harness(legacySeam(calls, JSON.stringify(FORWARDED)))
  applyFetchPage(ctx, { workdir: '/tmp', workspaceRoot: '/tmp' })

  const out = await tools.get('fetch_page').execute({ url: FORWARDED.url }, {})
  if (out?.error) throw new Error(`tool returned an error: ${out.error}`)
  if (out.status !== 200) throw new Error(`payload did not round-trip: ${JSON.stringify(out).slice(0, 200)}`)
})

await check('fetch_page: a seam with neither API fails with a clear message', async () => {
  const { ctx, tools } = harness(emptySeam())
  applyFetchPage(ctx, { workdir: '/tmp', workspaceRoot: '/tmp' })

  const out = await tools.get('fetch_page').execute({ url: FORWARDED.url }, {})
  if (!out?.error) throw new Error('expected an error result')
  if (!/neither execute\(\) nor run\(\)/.test(out.error)) {
    throw new Error(`unexpected error text: ${out.error}`)
  }
})

// ------------------------------------------------------------- browser tools

await check('browser: current seam (execute + result) runs cleanly', async () => {
  const calls = []
  const { ctx, tools } = harness(currentSeam(calls, 'ok'))
  applyBrowser(ctx, { workdir: '/tmp', workspaceRoot: '/tmp' })

  const out = await tools.get('browser').execute({ code: 'print(1)' }, {})
  if (out.exitCode !== 0 || out.stderr !== '') {
    throw new Error(`expected a clean run: ${JSON.stringify(out)}`)
  }
  if (!calls.every((call) => call.timeoutMs === 300000)) {
    throw new Error(`unexpected timeouts: ${JSON.stringify(calls.map((call) => call.timeoutMs))}`)
  }
})

await check('browser: legacy seam (run) still works', async () => {
  const calls = []
  const { ctx, tools } = harness(legacySeam(calls, 'ok'))
  applyBrowser(ctx, { workdir: '/tmp', workspaceRoot: '/tmp' })

  const out = await tools.get('browser').execute({ code: 'print(1)' }, {})
  if (out.exitCode !== 0 || out.stderr !== '') {
    throw new Error(`expected a clean run: ${JSON.stringify(out)}`)
  }
})

await check('browser: a seam with neither API fails with a clear message', async () => {
  const { ctx, tools } = harness(emptySeam())
  applyBrowser(ctx, { workdir: '/tmp', workspaceRoot: '/tmp' })

  const out = await tools.get('browser').execute({ code: 'print(1)' }, {})
  if (out.exitCode !== 1 || !/neither execute\(\) nor run\(\)/.test(out.stderr)) {
    throw new Error(`unexpected result: ${JSON.stringify(out)}`)
  }
})

// ------------------------------------------------------------- static guards

await check('compiled libs no longer contain the broken call', () => {
  for (const lib of ['dsh-plugin/lib/index.js', 'browser-plugin/lib/index.js']) {
    const source = readFileSync(join(ROOT, lib), 'utf8')
    if (source.includes(ORIGINAL_BUG)) throw new Error(`${lib} still calls ${ORIGINAL_BUG}`)
  }
})

// ------------------------------------------------------------------- report

let failed = 0
for (const [ok, name, detail] of results) {
  if (ok) {
    console.log(`✅ PASS  ${name}`)
  } else {
    failed += 1
    console.log(`❌ FAIL  ${name}\n         ${detail}`)
  }
}
console.log(`\n${results.length - failed}/${results.length} checks passed`)

if (failed > 0) process.exitCode = 1
