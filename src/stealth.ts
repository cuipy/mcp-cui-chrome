import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 独立 Chrome 配置目录，和日常使用的用户数据分开。 */
export function profileDir(): string {
  if (process.env.MCP_CHROME_PROFILE) return process.env.MCP_CHROME_PROFILE;
  const base = process.env.LOCALAPPDATA || os.homedir();
  return path.join(base, 'mcp-cui-chrome', 'chrome-profile');
}

/**
 * 清掉 Playwright 留在页面主世界里的标记。
 * 用字符串生成函数，避免打包器把 Node 侧的辅助函数写进页面。
 * 不改 navigator：真实 Chrome 的指纹保持原样。
 */
export const stripPlaywrightArtifacts = new Function(`
  const record = window;
  const hide = (key) => {
    try {
      delete record[key];
    } catch {
      /* 不可删除 */
    }
    if (Object.prototype.hasOwnProperty.call(window, key)) {
      try {
        Object.defineProperty(window, key, { get: () => undefined, configurable: true });
      } catch {
        /* 不可配置 */
      }
    }
  };
  for (const key of Object.getOwnPropertyNames(window)) {
    if (/^__pw|pwInitScripts|playwright/i.test(key)) hide(key);
  }
  if (!record.chrome) record.chrome = {};
`) as () => void;

/** package.json 里的版本号，黄条标签和 MCP 服务声明都用它，避免多处写死。 */
export function packageVersion(): string {
  try {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const pkg = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '';
  } catch {
    return '';
  }
}

/** 黄条标签，形如 cui-chrome[v7]，取版本号最后一段。 */
function barLabel(): string {
  const patch = packageVersion().split('.')[2];
  return patch ? `cui-chrome[v${patch}]` : 'cui-chrome';
}

/**
 * 左下角黄底标签。data-cui-status 由操作前后写入，页面上能直接看到。
 * addInitScript 会把脚本注入到每个 frame，这里只在顶层页面挂载，避免 iframe 里也出现标签。
 */
export const showCuiChromeBar = new Function(`
  const HOST_ID = 'cui-chrome-bar';
  const LABEL = ${JSON.stringify(barLabel())};

  const isTop = () => {
    try {
      return window.top === window;
    } catch {
      return false;
    }
  };

  let bar = null;
  let mounted = false;

  const paint = (host) => {
    if (!bar) return;
    const status = (host.getAttribute('data-cui-status') || '').trim();
    bar.textContent = status ? LABEL + '  ' + status : LABEL;
  };

  const unmount = () => {
    if (isTop()) return false;
    const host = document.getElementById(HOST_ID);
    if (host) host.remove();
    bar = null;
    mounted = false;
    return true;
  };

  const mount = () => {
    if (mounted || !isTop()) return;
    const root = document.documentElement;
    if (!root || document.getElementById(HOST_ID)) return;
    mounted = true;
    const host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('data-cui-chrome', 'bar');
    const set = (name, value) => host.style.setProperty(name, value, 'important');
    set('position', 'fixed');
    set('left', '0');
    set('bottom', '0');
    set('right', 'auto');
    set('top', 'auto');
    set('transform', 'none');
    set('width', 'max-content');
    set('max-width', '70vw');
    set('z-index', '2147483647');
    set('pointer-events', 'none');
    set('margin', '0');
    const shadow = host.attachShadow({ mode: 'closed' });
    bar = document.createElement('div');
    bar.textContent = LABEL;
    bar.style.cssText = 'box-sizing:border-box;width:max-content;max-width:70vw;overflow:hidden;text-overflow:ellipsis;padding:4px 12px;border-radius:0 4px 0 0;background:#ffe14a;color:#1a1a1a;font:600 13px/20px Segoe UI,Microsoft YaHei,sans-serif;white-space:nowrap;text-align:left;';
    shadow.appendChild(bar);
    new MutationObserver(() => paint(host)).observe(host, { attributes: true, attributeFilter: ['data-cui-status'] });
    root.appendChild(host);
    paint(host);
  };

  setTimeout(mount, 50);
  document.addEventListener('DOMContentLoaded', () => setTimeout(mount, 50));
  if (document.documentElement) {
    new MutationObserver(() => {
      if (unmount()) return;
      mount();
    }).observe(document.documentElement, { childList: true });
  }

  let checks = 0;
  const watchdog = () => {
    if (unmount()) return;
    checks += 1;
    if (checks < 4) setTimeout(watchdog, checks === 1 ? 300 : 1000);
  };
  setTimeout(watchdog, 300);
`) as () => void;

export const setCuiChromeStatus = new Function(
  'status',
  `
    const host = document.getElementById('cui-chrome-bar');
    if (host) host.setAttribute('data-cui-status', String(status || '').slice(0, 80));
  `,
) as (status: string) => void;

/** 0 表示由 Chrome 自己选一个本机端口，供后启动的会话接上来。 */
export function cdpPort(): number {
  const raw = process.env.MCP_CHROME_CDP_PORT;
  if (!raw) return 0;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('MCP_CHROME_CDP_PORT 必须是 0 到 65535 的整数');
  }
  return port;
}

export function persistentContextOptions() {
  const headless = process.env.MCP_CHROME_HEADLESS === '1';
  const width = 1366 + Math.floor(Math.random() * 80);
  const height = 768 + Math.floor(Math.random() * 48);
  const left = 40 + Math.floor(Math.random() * 80);
  const top = 40 + Math.floor(Math.random() * 40);
  const args = [
    '--disable-blink-features=AutomationControlled',
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${cdpPort()}`,
    `--window-position=${left},${top}`,
    `--window-size=${width},${height}`,
  ];
  const shared = {
    headless,
    ignoreDefaultArgs: ['--enable-automation'],
    args,
    viewport: null,
  };
  const chromePath = process.env.MCP_CHROME_PATH;
  if (chromePath) return { ...shared, executablePath: chromePath };
  return { ...shared, channel: 'chrome' as const };
}
