/**
 * 本地 HTTP 侧车：把常驻 CDP 连接暴露成简单 HTTP/SSE 接口，供**插件之外**的
 * 脚本（bash 里的 node / curl）复用，从而不必各自直连 9222。
 *
 * 契约与历史 cdp-hub 保持一致：
 *   GET  /health                 → { ok, hub, pid, ready, paused, pausedReason, attempts,
 *                                    nextRetryMs, endpointChanged, lastError, connects,
 *                                    disconnects, requests, keepalives, errors, upstream,
 *                                    source, profileDir, uptimeSec }
 *     `ok` 是上游真实就绪状态（不再恒 true）；pid 用于区分自身与外部 hub。
 *   GET  /cookies?domains=a,b    → { total, domains, cookies }
 *   GET  /targets                → Target.getTargets
 *   GET  /events                 → SSE 事件流
 *   GET  /json/version|/json/list→ 兼容旧的 HTTP 发现
 *   POST /cdp  { method, params?, sessionId? }
 *   POST /attach { targetId, flatten? }
 *
 * @module @deepseek-ai/dsh-tool-browser/hub/server
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { CdpUpstream } from './upstream.js'

export interface CookieSummary {
  total: number
  domains: number
  byDomain: Record<string, number>
}

export interface ChromeCookie {
  name: string
  value: string
  domain: string
  path?: string
  expires?: number
  secure?: boolean
  httpOnly?: boolean
  sameSite?: string
}

export function summarizeCookies(cookies: ChromeCookie[]): CookieSummary {
  const byDomain: Record<string, number> = {}
  for (const c of cookies) {
    const d = c.domain || '(none)'
    byDomain[d] = (byDomain[d] ?? 0) + 1
  }
  return { total: cookies.length, domains: Object.keys(byDomain).length, byDomain }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body, null, 2), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
    'cache-control': 'no-store',
  })
  res.end(buf)
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer))
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  return raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>)
}

/** 创建 HTTP 侧车（未 listen，交给调用方绑定端口）。 */
export function createHubServer(upstream: CdpUpstream, info: () => { startedAt: number }): Server {
  const sseClients = new Set<ServerResponse>()
  upstream.onEvent((msg) => {
    const line = `data: ${JSON.stringify(msg)}\n\n`
    for (const client of sseClients) {
      try {
        client.write(line)
      } catch {
        sseClients.delete(client)
      }
    }
  })

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      const text = error instanceof Error ? error.message : String(error)
      sendJson(res, 502, { error: text })
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const method = req.method ?? 'GET'

    if (method === 'GET' && url.pathname === '/health') {
      const endpoint = upstream.endpoint
      const health = upstream.health
      // S8：ok 不再恒 true——它就是上游真实就绪状态；paused/attempts/nextRetryMs 让
      // 脚本能区分「hub 活着但上游暂停」和「已连上」。pid 用于区分自身与外部 hub。
      sendJson(res, 200, {
        ...upstream.stats,
        ok: health.ready,
        hub: true,
        pid: process.pid,
        ready: health.ready,
        paused: health.paused,
        pausedReason: health.pausedReason,
        attempts: health.attempts,
        lastError: health.lastError,
        nextRetryMs: health.nextRetryMs,
        // P15：README/JSDoc 承诺过的字段必须真的返回（授权暂停时用来判断端点是否变了）。
        endpointChanged: health.endpointChanged,
        lastAttemptAt: health.lastAttemptAt,
        idleForMs: health.idleForMs,
        upstream: endpoint?.wsUrl ?? null,
        source: endpoint?.source ?? null,
        profileDir: endpoint?.profileDir ?? null,
        uptimeSec: Math.round((Date.now() - info().startedAt) / 1000),
      })
      return
    }

    if (method === 'GET' && url.pathname === '/cookies') {
      const result = (await upstream.send('Storage.getCookies')) as { cookies?: ChromeCookie[] }
      let cookies = result.cookies ?? []
      const filter = url.searchParams.get('domains')
      if (filter) {
        const pats = filter
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s !== '')
        cookies = cookies.filter((c) => pats.some((p) => (c.domain ?? '').includes(p)))
      }
      sendJson(res, 200, { ...summarizeCookies(cookies), cookies })
      return
    }

    if (method === 'GET' && url.pathname === '/targets') {
      sendJson(res, 200, await upstream.send('Target.getTargets'))
      return
    }

    if (method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      })
      res.write(': connected\n\n')
      sseClients.add(res)
      // P7：纯 /events 订阅者不会调用 send()，必须在这里续期「客户端需求」，
      // 否则一次断线会走 pause(idle) 后永不恢复，而客户端看到的现象是「流还开着」。
      upstream.noteDemand()
      const ping = setInterval(() => {
        upstream.noteDemand()
        try {
          res.write(': ping\n\n')
        } catch {
          /* ignore */
        }
      }, 15000)
      ping.unref?.()
      req.on('close', () => {
        clearInterval(ping)
        sseClients.delete(res)
      })
      return
    }

    if (method === 'GET' && url.pathname === '/json/version') {
      const v = (await upstream.send('Browser.getVersion').catch(() => ({}))) as Record<string, unknown>
      sendJson(res, 200, {
        Browser: v.product ?? 'Chrome',
        'Protocol-Version': v.protocolVersion ?? '1.3',
        webSocketDebuggerUrl: upstream.endpoint?.wsUrl ?? null,
      })
      return
    }

    if (method === 'GET' && url.pathname === '/json/list') {
      const r = (await upstream.send('Target.getTargets')) as { targetInfos?: Array<Record<string, unknown>> }
      const pages = (r.targetInfos ?? []).filter((t) => t.type === 'page')
      sendJson(
        res,
        200,
        pages.map((t) => ({ id: t.targetId, type: t.type, title: t.title, url: t.url })),
      )
      return
    }

    if (method === 'POST' && url.pathname === '/cdp') {
      const body = await readJsonBody(req)
      const cdpMethod = typeof body.method === 'string' ? body.method : ''
      if (cdpMethod === '') {
        sendJson(res, 400, { error: 'body 需要 { method, params?, sessionId? }' })
        return
      }
      const params = (body.params as Record<string, unknown> | undefined) ?? {}
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined
      sendJson(res, 200, { result: await upstream.send(cdpMethod, params, sessionId) })
      return
    }

    if (method === 'POST' && url.pathname === '/attach') {
      const body = await readJsonBody(req)
      const targetId = typeof body.targetId === 'string' ? body.targetId : ''
      if (targetId === '') {
        sendJson(res, 400, { error: 'body 需要 { targetId }' })
        return
      }
      sendJson(
        res,
        200,
        await upstream.send('Target.attachToTarget', { targetId, flatten: body.flatten !== false }),
      )
      return
    }

    sendJson(res, 404, { error: `no route ${method} ${url.pathname}` })
  }

  server.on('close', () => {
    for (const client of sseClients) {
      try {
        client.end()
      } catch {
        /* ignore */
      }
    }
    sseClients.clear()
  })

  return server
}
