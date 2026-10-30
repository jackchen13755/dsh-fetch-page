/**
 * ChromeHub：插件进程内的 CDP 中枢。
 *
 * - 持有**唯一**一条到用户主 Chrome 的 WebSocket（授权只发生一次）；
 * - 可选地在 127.0.0.1 上开 HTTP 侧车，让插件之外的脚本（bash + node/curl）复用同一条连接；
 * - 对外提供 cookie / 页面驱动 / 原始 CDP 三档能力。
 *
 * 端口被占用时先探 `/health`：若已经是同类 hub 则复用（external 模式），否则报可操作的错误。
 *
 * @module @deepseek-ai/dsh-tool-browser/hub
 */
import { createServer, type Server } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { CdpUpstream } from './upstream.js'
import { createHubServer, summarizeCookies, type ChromeCookie, type CookieSummary } from './server.js'

export interface HubOptions {
  /** HTTP 侧车端口，默认 9334；设为 0 表示不开侧车。 */
  port?: number
  /** 指定 Chrome 用户数据目录（默认按平台推断）。 */
  profileDir?: string
  /** 直接指定 CDP WebSocket 地址（优先于 profileDir）。 */
  cdpWsUrl?: string
  /** 请求超时。 */
  requestTimeoutMs?: number
  /** 等待 Chrome 授权的超时。 */
  readyTimeoutMs?: number
}

export interface HubStatus {
  ready: boolean
  /** true = 端口上已有别的 hub 在跑，本插件复用它而不是抢端口。 */
  external: boolean
  port: number
  baseUrl: string
  upstream: string | null
  source: string | null
  profileDir: string | null
  connects: number
  disconnects: number
  requests: number
  errors: number
  lastError: string | null
  lastConnectedAt: string | null
  uptimeSec: number
}

export interface PageResult {
  ok: boolean
  url: string
  title: string
  readyState: string
  result?: unknown
  screenshotPath?: string
  captured: Array<{ url: string; status: number; bodyKeys?: string[]; bodyText?: string }>
  consoleErrors: string[]
  networkFailures: string[]
  error?: string
}

const DEFAULT_PORT = 9334

async function probeHealth(baseUrl: string, timeoutMs = 1200): Promise<Record<string, unknown> | null> {
  try {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    timer.unref?.()
    const res = await fetch(`${baseUrl}/health`, { signal: ac.signal })
    clearTimeout(timer)
    if (!res.ok) return null
    return (await res.json()) as Record<string, unknown>
  } catch {
    return null
  }
}

export class ChromeHub {
  private upstream: CdpUpstream | null = null
  private server: Server | null = null
  private startedAt = Date.now()
  private externalBase: string | null = null
  private ensureInflight: Promise<HubStatus> | null = null
  private readonly port: number
  private readonly opts: HubOptions

  constructor(opts: HubOptions = {}) {
    this.opts = opts
    this.port = opts.port ?? Number(process.env.DSH_CHROME_HUB_PORT ?? DEFAULT_PORT)
  }

  get baseUrl(): string {
    return this.externalBase ?? `http://127.0.0.1:${this.port}`
  }

  /** 确保连接可用（必要时建立连接并开侧车）。幂等。 */
  async ensure(): Promise<HubStatus> {
    if (this.ensureInflight) return await this.ensureInflight
    this.ensureInflight = this.doEnsure().finally(() => {
      this.ensureInflight = null
    })
    return await this.ensureInflight
  }

  private async doEnsure(): Promise<HubStatus> {
    // 关键顺序：先探端口上有没有现成的 hub。若有，直接复用——
    // 绝不能先去连 Chrome：那会多建一条 WebSocket，让 Chrome 白弹一次授权。
    if (this.port > 0) {
      const health = await probeHealth(`http://127.0.0.1:${this.port}`)
      if (health !== null && health['ok'] === true) {
        this.externalBase = `http://127.0.0.1:${this.port}`
        return this.statusFromExternal(health)
      }
    }

    if (this.externalBase) {
      const health = await probeHealth(this.externalBase)
      if (health) return this.statusFromExternal(health)
      this.externalBase = null
    }

    if (this.upstream === null) {
      this.upstream = new CdpUpstream({
        ...(this.opts.profileDir !== undefined ? { profileDir: this.opts.profileDir } : {}),
        ...(this.opts.cdpWsUrl !== undefined ? { cdpWsUrl: this.opts.cdpWsUrl } : {}),
        ...(this.opts.requestTimeoutMs !== undefined ? { requestTimeoutMs: this.opts.requestTimeoutMs } : {}),
        ...(this.opts.readyTimeoutMs !== undefined ? { readyTimeoutMs: this.opts.readyTimeoutMs } : {}),
      })
    }

    await this.upstream.ensureConnected()
    if (this.port > 0) await this.ensureServer()
    return await this.status()
  }

  private async ensureServer(): Promise<void> {
    if (this.server !== null) return
    const upstream = this.upstream
    if (upstream === null) return
    const server = createHubServer(upstream, () => ({ startedAt: this.startedAt }))
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException): void => {
        server.removeListener('error', onError)
        if (error.code === 'EADDRINUSE') {
          // 端口已被占用：先看是不是同类 hub，是就复用，别抢
          void probeHealth(`http://127.0.0.1:${this.port}`).then((health) => {
            if (health) {
              this.externalBase = `http://127.0.0.1:${this.port}`
              resolve()
              return
            }
            reject(
              new Error(
                `端口 ${this.port} 已被其它进程占用，且 /health 不像 CDP hub。` +
                  '请释放该端口，或用配置 port 换一个端口。',
              ),
            )
          })
          return
        }
        reject(error)
      }
      server.once('error', onError)
      server.listen(this.port, '127.0.0.1', () => {
        server.removeListener('error', onError)
        this.server = server
        resolve()
      })
    })
  }

  /** 当前状态（不主动建立连接；若端口上有外部 hub 就报它的状态）。 */
  async status(): Promise<HubStatus> {
    const base: HubStatus = {
      ready: false,
      external: this.externalBase !== null,
      port: this.port,
      baseUrl: this.baseUrl,
      upstream: null,
      source: null,
      profileDir: null,
      connects: 0,
      disconnects: 0,
      requests: 0,
      errors: 0,
      lastError: null,
      lastConnectedAt: null,
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
    }
    if (this.externalBase) {
      const health = await probeHealth(this.externalBase)
      return health ? this.statusFromExternal(health) : base
    }
    const upstream = this.upstream
    if (upstream === null) return base
    return {
      ...base,
      ready: upstream.isReady,
      upstream: upstream.endpoint?.wsUrl ?? null,
      source: upstream.endpoint?.source ?? null,
      profileDir: upstream.endpoint?.profileDir ?? null,
      ...upstream.stats,
    }
  }

  private statusFromExternal(health: Record<string, unknown>): HubStatus {
    const num = (v: unknown): number => (typeof v === 'number' ? v : 0)
    const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
    return {
      ready: health.ready === true,
      external: true,
      port: this.port,
      baseUrl: this.baseUrl,
      upstream: str(health.upstream),
      source: str(health.source),
      profileDir: str(health.profileDir),
      connects: num(health.connects),
      disconnects: num(health.disconnects),
      requests: num(health.requests),
      errors: num(health.errors),
      lastError: str(health.lastError),
      lastConnectedAt: str(health.lastConnectedAt),
      uptimeSec: num(health.uptimeSec),
    }
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        setTimeout(() => resolve(), 1500).unref?.()
      })
    }
    this.upstream?.stop()
    this.upstream = null
    this.externalBase = null
  }

  /** 发一条 CDP 命令：本进程持有上游则直连，否则走外部 hub 的 HTTP。 */
  async call(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    const status = await this.ensure()
    if (!status.ready) {
      throw new Error(`CDP 上游未就绪：${status.lastError ?? '未知原因'}（connects=${status.connects}）`)
    }
    if (this.externalBase) {
      const res = await fetch(`${this.externalBase}/cdp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, params, ...(sessionId !== undefined ? { sessionId } : {}) }),
      })
      const body = (await res.json()) as { result?: unknown; error?: string }
      if (!res.ok) throw new Error(body.error ?? `hub ${res.status}`)
      return body.result
    }
    const upstream = this.upstream
    if (upstream === null) throw new Error('上游未初始化')
    return await upstream.send(method, params, sessionId)
  }

  async cookies(domains?: string): Promise<{ summary: CookieSummary; cookies: ChromeCookie[] }> {
    const result = (await this.call('Storage.getCookies')) as { cookies?: ChromeCookie[] }
    let cookies = result.cookies ?? []
    if (domains !== undefined && domains !== '') {
      const pats = domains
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '')
      cookies = cookies.filter((c) => pats.some((p) => (c.domain ?? '').includes(p)))
    }
    return { summary: summarizeCookies(cookies), cookies }
  }

  /** 订阅事件（本进程持有上游时直接订阅；外部模式下退回 SSE）。 */
  onEvent(sink: (msg: Record<string, unknown>) => void): () => void {
    if (this.externalBase) {
      const ac = new AbortController()
      void (async () => {
        try {
          const res = await fetch(`${this.externalBase}/events`, {
            headers: { accept: 'text/event-stream' },
            signal: ac.signal,
          })
          if (!res.ok || res.body === null) return
          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buf = ''
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            buf += decoder.decode(value, { stream: true })
            let idx = buf.indexOf('\n\n')
            while (idx >= 0) {
              const chunk = buf.slice(0, idx)
              buf = buf.slice(idx + 2)
              const dataLine = chunk.split('\n').find((l) => l.startsWith('data: '))
              if (dataLine) {
                try {
                  sink(JSON.parse(dataLine.slice(6)) as Record<string, unknown>)
                } catch {
                  /* ignore */
                }
              }
              idx = buf.indexOf('\n\n')
            }
          }
        } catch {
          /* aborted */
        }
      })()
      return () => ac.abort()
    }
    const upstream = this.upstream
    if (upstream === null) return () => undefined
    return upstream.onEvent(sink)
  }

  /**
   * 页面驱动：开标签页 → 等加载/选择器 → 求值 → 可选截图与响应体抓取 → 关标签页。
   */
  async page(spec: {
    url: string
    expr?: string
    waitForSelector?: string
    timeoutMs?: number
    capture?: string
    screenshotPath?: string
    keep?: boolean
    viewport?: { width: number; height: number }
  }): Promise<PageResult> {
    await this.ensure()
    const timeoutMs = spec.timeoutMs ?? 60000
    const result: PageResult = {
      ok: true,
      url: '',
      title: '',
      readyState: '',
      captured: [],
      consoleErrors: [],
      networkFailures: [],
    }

    const created = (await this.call('Target.createTarget', { url: 'about:blank', background: false })) as {
      targetId: string
    }
    const targetId = created.targetId
    const attached = (await this.call('Target.attachToTarget', { targetId, flatten: true })) as {
      sessionId: string
    }
    const sessionId = attached.sessionId
    const S = (method: string, params: Record<string, unknown> = {}): Promise<unknown> =>
      this.call(method, params, sessionId)

    const match = spec.capture ?? ''
    const bodyFetch: Array<Promise<void>> = []
    const off = this.onEvent((msg) => {
      const evSession = typeof msg['sessionId'] === 'string' ? (msg['sessionId'] as string) : ''
      if (evSession !== '' && evSession !== sessionId) return
      const method = typeof msg['method'] === 'string' ? (msg['method'] as string) : ''
      const p = (msg['params'] ?? {}) as Record<string, unknown>
      if (method === 'Runtime.consoleAPICalled' && p['type'] === 'error') {
        result.consoleErrors.push('console.error')
        return
      }
      if (method === 'Network.loadingFailed') {
        const requestId = typeof p['requestId'] === 'string' ? (p['requestId'] as string) : ''
        result.networkFailures.push(requestId)
        return
      }
      if (method === 'Network.responseReceived') {
        const response = p['response'] as { url?: string; status?: number } | undefined
        const url = response?.url ?? ''
        if (match === '' || !url.includes(match)) return
        const status = typeof response?.status === 'number' ? response.status : 0
        const entry: { url: string; status: number; bodyKeys?: string[]; bodyText?: string } = { url, status }
        result.captured.push(entry)
        const requestId = typeof p['requestId'] === 'string' ? (p['requestId'] as string) : ''
        if (requestId !== '') {
          bodyFetch.push(
            this.call('Network.getResponseBody', { requestId }, sessionId)
              .then((body) => {
                const b = body as { body?: string; base64Encoded?: boolean }
                const text = b.body ?? ''
                if (b.base64Encoded === true) return
                if (text.startsWith('{') || text.startsWith('[')) {
                  try {
                    entry.bodyKeys = Object.keys(JSON.parse(text) as Record<string, unknown>)
                    return
                  } catch {
                    /* 不是 JSON */
                  }
                }
                entry.bodyText = text.slice(0, 500)
              })
              .catch(() => undefined),
          )
        }
      }
    })

    try {
      await S('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(
        () => undefined,
      )
      await S('Page.enable')
      await S('Runtime.enable')
      if (match !== '' || true) {
        await S('Network.enable').catch(() => undefined)
      }
      const viewport = spec.viewport ?? { width: 1600, height: 1200 }
      await S('Emulation.setDeviceMetricsOverride', {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        mobile: false,
      }).catch(() => undefined)

      await S('Page.navigate', { url: spec.url })

      const started = Date.now()
      let loaded = false
      while (Date.now() - started < timeoutMs) {
        await new Promise((r) => setTimeout(r, 400))
        try {
          const ready = (await S('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true })) as {
            result?: { value?: unknown }
          }
          if (ready.result?.value === 'complete') {
            loaded = true
            break
          }
        } catch {
          /* 导航中 */
        }
      }
      if (!loaded) {
        result.ok = false
        result.error = `页面加载超时（${timeoutMs}ms，readyState 未 complete）`
      }

      if (spec.waitForSelector !== undefined && spec.waitForSelector !== '') {
        const selStart = Date.now()
        let found = false
        while (Date.now() - selStart < timeoutMs) {
          const probe = (await S('Runtime.evaluate', {
            expression: `!!document.querySelector(${JSON.stringify(spec.waitForSelector)})`,
            returnByValue: true,
          })) as { result?: { value?: unknown } }
          if (probe.result?.value === true) {
            found = true
            break
          }
          await new Promise((r) => setTimeout(r, 300))
        }
        if (!found) {
          result.ok = false
          result.error = `waitForSelector 超时：${spec.waitForSelector}`
        }
      }

      const info = (await S('Runtime.evaluate', {
        expression: 'JSON.stringify({title: document.title, url: location.href, readyState: document.readyState})',
        returnByValue: true,
      })) as { result?: { value?: string } }
      if (typeof info.result?.value === 'string') {
        try {
          const parsed = JSON.parse(info.result.value) as { title?: string; url?: string; readyState?: string }
          result.title = parsed.title ?? ''
          result.url = parsed.url ?? ''
          result.readyState = parsed.readyState ?? ''
        } catch {
          /* ignore */
        }
      }

      if (spec.expr !== undefined && spec.expr !== '') {
        const evaluated = (await S('Runtime.evaluate', {
          expression: `(async () => { ${spec.expr} })()`,
          awaitPromise: true,
          returnByValue: true,
          userGesture: true,
        })) as {
          result?: { value?: unknown }
          exceptionDetails?: { text?: string; exception?: { description?: string } }
        }
        if (evaluated.exceptionDetails) {
          result.ok = false
          result.error = `表达式抛错：${evaluated.exceptionDetails.exception?.description ?? evaluated.exceptionDetails.text ?? ''}`
        } else {
          result.result = evaluated.result?.value
        }
      }

      if (spec.screenshotPath !== undefined && spec.screenshotPath !== '') {
        const shot = (await S('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })) as {
          data: string
        }
        await writeFile(spec.screenshotPath, Buffer.from(shot.data, 'base64'))
        result.screenshotPath = spec.screenshotPath
      }

      await Promise.allSettled(bodyFetch)
    } catch (error) {
      result.ok = false
      result.error = error instanceof Error ? error.message : String(error)
    } finally {
      off()
      if (spec.keep !== true) {
        await this.call('Target.closeTarget', { targetId }).catch(() => undefined)
      }
    }

    return result
  }
}
