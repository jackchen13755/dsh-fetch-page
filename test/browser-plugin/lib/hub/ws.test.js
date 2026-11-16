/**
 * lib/hub/ws.js 的握手/分帧回归（评审 P2(c) + P8：这一层原先零覆盖）。
 *
 * 用本地 net server 扮演「Chrome 的调试端点」，模拟三种对端行为：
 * 正常 101 / 403 拒绝 / 握手窗口内优雅 FIN。不联网、不碰真实 Chrome。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { MiniWebSocket } from '../../../../browser-plugin/lib/hub/ws.js'

const HANDSHAKE_101 = 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now()
  for (;;) {
    if (predicate()) return
    if (Date.now() - started > timeoutMs) throw new Error('waitFor 超时')
    await sleep(5)
  }
}

async function startServer(handler) {
  const sockets = new Set()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => undefined)
    try {
      handler(socket)
    } catch {
      /* 测试对端出错不该拖垮用例 */
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    port,
    url: (path = '/devtools/browser/mock') => `ws://127.0.0.1:${port}${path}`,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/** 服务端 → 客户端的帧（服务端不 mask）。 */
function frame(opcode, payload = Buffer.alloc(0)) {
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len])
  } else if (len <= 0xffff) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, payload])
}

test('MiniWebSocket：101 握手 → 收文本帧 → close 帧回调 onClose', async (t) => {
  const server = await startServer((socket) => {
    let handshook = false
    socket.on('data', () => {
      if (handshook) return
      handshook = true
      socket.write(HANDSHAKE_101)
      setTimeout(() => socket.write(frame(0x1, Buffer.from('{"id":1,"result":{"ok":true}}'))), 5)
    })
  })
  t.after(() => server.close())

  const ws = await MiniWebSocket.connect(server.url(), { timeoutMs: 1000 })
  assert.equal(ws.isClosed, false)

  const text = await new Promise((resolve) => {
    ws.onText = resolve
  })
  assert.deepEqual(JSON.parse(text), { id: 1, result: { ok: true } })

  const closed = new Promise((resolve) => {
    ws.onClose = (code) => resolve(code)
  })
  ws.close()
  assert.equal(ws.isClosed, true, 'client close 后 isClosed 必须为 true')
  assert.equal(await closed, 1000)
})

test('MiniWebSocket：对端 close 帧（1000）会回调 onClose 并置 isClosed', async (t) => {
  const server = await startServer((socket) => {
    socket.once('data', () => {
      socket.write(HANDSHAKE_101)
      setTimeout(() => {
        const payload = Buffer.alloc(2)
        payload.writeUInt16BE(1000, 0)
        socket.write(frame(0x8, payload))
      }, 5)
    })
  })
  t.after(() => server.close())

  const ws = await MiniWebSocket.connect(server.url(), { timeoutMs: 1000 })
  const code = await new Promise((resolve) => {
    ws.onClose = (value) => resolve(value)
  })
  assert.equal(code, 1000)
  assert.equal(ws.isClosed, true)
})

test('MiniWebSocket：403 → 抛出 ws-handshake/status（授权未获准的典型形态）', async (t) => {
  const server = await startServer((socket) => {
    socket.once('data', () => socket.end('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n'))
  })
  t.after(() => server.close())

  await assert.rejects(MiniWebSocket.connect(server.url(), { timeoutMs: 1000 }), (error) => {
    assert.equal(error.code, 'ws-handshake')
    assert.equal(error.stage, 'status')
    assert.match(error.message, /403/)
    return true
  })
})

test('P2(c) 握手窗口内优雅 FIN：立刻 reject（不得挂满 timeout）', async (t) => {
  const server = await startServer((socket) => {
    socket.once('data', () => socket.end()) // 读了 request 就 FIN，不回 101
  })
  t.after(() => server.close())

  const started = Date.now()
  await assert.rejects(MiniWebSocket.connect(server.url(), { timeoutMs: 5000 }), (error) => {
    assert.equal(error.code, 'ws-handshake')
    assert.equal(error.stage, 'closed')
    return true
  })
  const elapsed = Date.now() - started
  assert.ok(elapsed < 800, `必须在握手窗口内立刻失败，而不是等 5000ms 超时（实际 ${elapsed}ms）`)
})

test('MiniWebSocket：握手超时 → ws-handshake/timeout，且错误文本不含完整 uuid', async (t) => {
  const server = await startServer(() => {
    /* 接受连接但永不回 101 */
  })
  t.after(() => server.close())

  const uuid = 'aaaa1111-bbbb-2222-cccc-333344445555'
  await assert.rejects(MiniWebSocket.connect(server.url(`/devtools/browser/${uuid}`), { timeoutMs: 80 }), (error) => {
    assert.equal(error.code, 'ws-handshake')
    assert.equal(error.stage, 'timeout')
    assert.ok(!error.message.includes(uuid), `错误文本不得带完整 uuid：${error.message}`)
    assert.match(error.message, /127\.0\.0\.1:\d+/)
    return true
  })
})

test('MiniWebSocket：端口没开 → ws-tcp（网络类，可退避重试）', async (t) => {
  const server = await startServer(() => undefined)
  const url = server.url()
  await server.close()

  await assert.rejects(MiniWebSocket.connect(url, { timeoutMs: 500 }), (error) => {
    assert.equal(error.code, 'ws-tcp')
    return true
  })
})

test('MiniWebSocket：客户端发出的文本帧必须 masked 且内容正确', async (t) => {
  const frames = []
  const server = await startServer((socket) => {
    let handshook = false
    socket.on('data', (chunk) => {
      if (!handshook) {
        handshook = true
        socket.write(HANDSHAKE_101)
        return
      }
      frames.push(chunk)
    })
  })
  t.after(() => server.close())

  const ws = await MiniWebSocket.connect(server.url(), { timeoutMs: 1000 })
  ws.send('hello')
  await waitFor(() => frames.length > 0)

  const raw = frames[0]
  assert.equal(raw[0] & 0x0f, 0x1, 'opcode 应为文本帧')
  assert.equal((raw[1] & 0x80) !== 0, true, '客户端帧必须 mask')
  const len = raw[1] & 0x7f
  assert.equal(len, 5)
  const mask = raw.subarray(2, 6)
  const payload = raw.subarray(6, 6 + len)
  const out = Buffer.alloc(len)
  for (let i = 0; i < len; i += 1) out[i] = payload[i] ^ mask[i & 3]
  assert.equal(out.toString('utf8'), 'hello')
})
