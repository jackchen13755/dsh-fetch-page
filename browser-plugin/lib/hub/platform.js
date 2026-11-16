/**
 * 平台适配：定位 Chrome 的用户数据目录，并从 `DevToolsActivePort` 解出 CDP 端点。
 *
 * 背景：主 Chrome 走 `chrome://inspect` 的「远程调试」开关时，`/json/version` 返回 404，
 * 唯一可靠来源就是用户数据目录下的 `DevToolsActivePort`（第 1 行端口、第 2 行
 * `/devtools/browser/<uuid>`）。各平台目录不同，这里做统一解析，避免把 macOS 路径写死。
 *
 * 端口校验从严：只接受 1..65535 的整数。非法值一律视为「没有可用端点」，
 * 由 `resolveEndpoint` 报可操作的错误——绝不在调用方那边静默猜一个 9222
 * （开发机上 9222 常另有 Chrome，静默回落会连错浏览器）。
 *
 * @module @deepseek-ai/dsh-tool-browser/hub/platform
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
/** 把 home 目录缩成 `~`：错误信息/日志不该把用户名带进公开仓库的排障输出。 */
export function prettyPath(path) {
    const home = homedir();
    if (home === '' || home === '/')
        return path;
    return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}
/** 各平台 Chrome 用户数据目录候选（按优先级）。 */
export function chromeProfileCandidates() {
    const home = homedir();
    const os = platform();
    if (os === 'darwin') {
        return [join(home, 'Library', 'Application Support', 'Google', 'Chrome')];
    }
    if (os === 'win32') {
        const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
        return [join(local, 'Google', 'Chrome', 'User Data')];
    }
    return [
        join(home, '.config', 'google-chrome'),
        join(home, '.config', 'chromium'),
        join(home, 'snap', 'chromium', 'common', 'chromium'),
    ];
}
/** 端口是否合法（1..65535 的整数）。 */
export function isValidPort(port) {
    return Number.isInteger(port) && port >= 1 && port <= 65535;
}
/** 读 DevToolsActivePort；文件缺失、端口非法或内容不完整时返回 undefined。 */
export function readDevToolsActivePort(profileDir) {
    const file = join(profileDir, 'DevToolsActivePort');
    if (!existsSync(file))
        return undefined;
    let raw;
    try {
        raw = readFileSync(file, 'utf8');
    }
    catch {
        return undefined;
    }
    const lines = raw
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s !== '');
    const port = Number(lines[0]);
    const wsPath = lines[1];
    // 端口 0 / 65536 / 非整数一律非法：宁可报错，也不猜一个端口去连别的 Chrome。
    if (lines[0] === undefined || !isValidPort(port))
        return undefined;
    if (wsPath === undefined || !wsPath.startsWith('/'))
        return undefined;
    return { port, path: wsPath };
}
/**
 * 解析 CDP 端点。优先级：
 * 1. 显式 ws 地址（config.cdpWsUrl / 环境变量 DSH_CHROME_WS）
 * 2. 指定或默认的 profile 目录里的 DevToolsActivePort
 * 3. 常见端口探测（仅当 DevToolsActivePort 缺失时）
 */
export function resolveEndpoint(opts = {}) {
    const explicit = opts.cdpWsUrl ?? process.env.DSH_CHROME_WS;
    if (explicit)
        return { wsUrl: explicit, source: 'explicit' };
    const configured = opts.profileDir ?? process.env.CDP_PROFILE_DIR;
    const dirs = configured ? [configured] : chromeProfileCandidates();
    for (const dir of dirs) {
        const parsed = readDevToolsActivePort(dir);
        if (parsed) {
            return {
                wsUrl: `ws://127.0.0.1:${parsed.port}${parsed.path}`,
                source: configured ? 'config' : 'DevToolsActivePort',
                profileDir: dir,
            };
        }
    }
    throw new Error('没有找到 Chrome 的远程调试端点：DevToolsActivePort 缺失、端口非法，或文件里没有 /devtools/browser/<uuid>。' +
        '请在 Chrome 打开 chrome://inspect/#remote-debugging 并开启远程调试' +
        '（或给插件配置 profileDir / 设置环境变量 DSH_CHROME_WS）。' +
        `已查找的目录：${dirs.map(prettyPath).join(', ')}。` +
        '排查提示：Chrome 重启后 DevToolsActivePort 会更新，旧文件的端口可能已无监听。');
}
//# sourceMappingURL=platform.js.map