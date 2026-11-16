/**
 * lib/hub/platform.js 的端点解析回归（评审 P6 + P8）：边界输入是验收载体。
 *
 * 覆盖 DevToolsActivePort 的 12 组写法（含端口 0 / 65536 / 非整数 / 缺行），
 * 以及 resolveEndpoint 的四条来源与「报错不得带用户名」的约束。
 * 全部用 mkdtemp 造 fixture，不读真实 Chrome 目录。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  chromeProfileCandidates,
  isValidPort,
  prettyPath,
  readDevToolsActivePort,
  resolveEndpoint,
} from '../../../../browser-plugin/lib/hub/platform.js'

// 环境变量会干扰来源判定：这组用例只测「配置/文件」两条路
delete process.env.DSH_CHROME_WS
delete process.env.CDP_PROFILE_DIR

function withProfile(contents, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cdp-port-'))
  try {
    if (contents !== undefined) writeFileSync(join(dir, 'DevToolsActivePort'), contents)
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('readDevToolsActivePort：合法文件（端口 + /devtools/browser/<uuid>）', () => {
  withProfile('9222\n/devtools/browser/aaaa1111-bbbb-2222\n', (dir) => {
    assert.deepEqual(readDevToolsActivePort(dir), { port: 9222, path: '/devtools/browser/aaaa1111-bbbb-2222' })
  })
})

test('readDevToolsActivePort：CRLF + 行尾空格也能解析', () => {
  withProfile(' 51234 \r\n /devtools/browser/x-y-z \r\n', (dir) => {
    assert.deepEqual(readDevToolsActivePort(dir), { port: 51234, path: '/devtools/browser/x-y-z' })
  })
})

test('readDevToolsActivePort：文件缺失 → undefined', () => {
  withProfile(undefined, (dir) => {
    assert.equal(readDevToolsActivePort(dir), undefined)
  })
})

test('readDevToolsActivePort：空文件 → undefined', () => {
  withProfile('', (dir) => assert.equal(readDevToolsActivePort(dir), undefined))
})

test('readDevToolsActivePort：只有端口没有路径 → undefined', () => {
  withProfile('9222\n', (dir) => assert.equal(readDevToolsActivePort(dir), undefined))
})

test('readDevToolsActivePort：端口 0 非法 → undefined（不回落 80/9222）', () => {
  withProfile('0\n/devtools/browser/x\n', (dir) => assert.equal(readDevToolsActivePort(dir), undefined))
})

test('readDevToolsActivePort：端口 65536 越界 → undefined', () => {
  withProfile('65536\n/devtools/browser/x\n', (dir) => assert.equal(readDevToolsActivePort(dir), undefined))
})

test('readDevToolsActivePort：超大端口 → undefined', () => {
  withProfile('99999999\n/devtools/browser/x\n', (dir) => assert.equal(readDevToolsActivePort(dir), undefined))
})

test('readDevToolsActivePort：非数字端口 → undefined', () => {
  withProfile('abc\n/devtools/browser/x\n', (dir) => assert.equal(readDevToolsActivePort(dir), undefined))
})

test('readDevToolsActivePort：小数端口 → undefined', () => {
  withProfile('80.5\n/devtools/browser/x\n', (dir) => assert.equal(readDevToolsActivePort(dir), undefined))
})

test('readDevToolsActivePort：负端口 → undefined', () => {
  withProfile('-1\n/devtools/browser/x\n', (dir) => assert.equal(readDevToolsActivePort(dir), undefined))
})

test('readDevToolsActivePort：路径不以 / 开头 → undefined', () => {
  withProfile('9222\ndevtools/browser/x\n', (dir) => assert.equal(readDevToolsActivePort(dir), undefined))
})

test('readDevToolsActivePort：第 2 行不是 devtools 路径但以 / 开头 → 仍接受（Chrome 变体）', () => {
  withProfile('9222\n/json/version\n', (dir) => {
    assert.deepEqual(readDevToolsActivePort(dir), { port: 9222, path: '/json/version' })
  })
})

test('isValidPort：只接受 1..65535 的整数', () => {
  for (const port of [1, 80, 9222, 65535]) assert.equal(isValidPort(port), true, String(port))
  for (const port of [0, -1, 65536, 99999999, 80.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(isValidPort(port), false, String(port))
  }
})

test('resolveEndpoint：显式 cdpWsUrl 优先（source=explicit）', () => {
  const endpoint = resolveEndpoint({ cdpWsUrl: 'ws://127.0.0.1:1234/devtools/browser/xyz' })
  assert.deepEqual(endpoint, { wsUrl: 'ws://127.0.0.1:1234/devtools/browser/xyz', source: 'explicit' })
})

test('resolveEndpoint：配置的 profileDir 读到 DevToolsActivePort（source=config）', () => {
  withProfile('9222\n/devtools/browser/abc\n', (dir) => {
    const endpoint = resolveEndpoint({ profileDir: dir })
    assert.equal(endpoint.wsUrl, 'ws://127.0.0.1:9222/devtools/browser/abc')
    assert.equal(endpoint.source, 'config')
    assert.equal(endpoint.profileDir, dir)
  })
})

test('resolveEndpoint：端口非法的文件当作没有端点（报可操作错误，不猜端口）', () => {
  withProfile('65536\n/devtools/browser/abc\n', (dir) => {
    assert.throws(
      () => resolveEndpoint({ profileDir: dir }),
      (error) => {
        assert.match(error.message, /没有找到 Chrome 的远程调试端点/)
        assert.match(error.message, /已查找的目录/)
        assert.ok(!error.message.includes('ws://127.0.0.1:9222'), '不得静默回落到 9222')
        return true
      },
    )
  })
})

test('P9 resolveEndpoint 报错：home 目录缩成 ~（不把用户名带进日志）', () => {
  const missing = join(homedir(), '__dsh_no_such_chrome_profile__')
  assert.throws(
    () => resolveEndpoint({ profileDir: missing }),
    (error) => {
      assert.ok(error.message.includes('~/__dsh_no_such_chrome_profile__'), error.message)
      assert.ok(!error.message.includes(homedir()), `不得出现完整 home 路径：${error.message}`)
      return true
    },
  )
})

test('prettyPath：home 前缀替换成 ~，其它路径原样', () => {
  assert.equal(prettyPath(join(homedir(), 'Library', 'Chrome')), '~/Library/Chrome')
  assert.equal(prettyPath('/tmp/whatever'), '/tmp/whatever')
})

test('chromeProfileCandidates：按平台给出至少一个候选目录', () => {
  const dirs = chromeProfileCandidates()
  assert.ok(Array.isArray(dirs) && dirs.length >= 1)
  assert.ok(dirs.every((dir) => typeof dir === 'string' && dir.startsWith('/')))
})
