import os from 'node:os';
import path from 'node:path';

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

/** 左下角黄底标签。data-cui-status 由操作前后写入，页面上能直接看到。 */
export const showCuiChromeBar = new Function(`
  const HOST_ID = 'cui-chrome-bar';
  const LABEL = 'cui-chrome';
  let bar = null;

  const paint = (host) => {
    if (!bar) return;
    const status = (host.getAttribute('data-cui-status') || '').trim();
    bar.textContent = status ? LABEL + '  ' + status : LABEL;
  };

  const mount = () => {
    const root = document.documentElement;
    if (!root || document.getElementById(HOST_ID)) return;
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

  mount();
  document.addEventListener('DOMContentLoaded', mount);
  if (document.documentElement) {
    new MutationObserver(mount).observe(document.documentElement, { childList: true });
  }
`) as () => void;

export const setCuiChromeStatus = new Function(
  'status',
  `
    const host = document.getElementById('cui-chrome-bar');
    if (host) host.setAttribute('data-cui-status', String(status || '').slice(0, 80));
  `,
) as (status: string) => void;

export function persistentContextOptions() {
  const headless = process.env.MCP_CHROME_HEADLESS === '1';
  const width = 1366 + Math.floor(Math.random() * 80);
  const height = 768 + Math.floor(Math.random() * 48);
  const left = 40 + Math.floor(Math.random() * 80);
  const top = 40 + Math.floor(Math.random() * 40);
  const args = [
    '--disable-blink-features=AutomationControlled',
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
