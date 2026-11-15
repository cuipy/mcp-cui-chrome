import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'rebrowser-playwright';
import { withBrowserLock } from './lock.js';
import { persistentContextOptions, profileDir, showCuiChromeBar, stripPlaywrightArtifacts } from './stealth.js';

export type RefEntry = {
  selector: string;
  role: string;
  name: string;
  /** 这个控件该用的操作，例如输入文字、点开后点选、拖动。 */
  gesture: string;
};

class Session {
  private context: BrowserContext | null = null;
  private browser: Browser | null = null;
  private ownsBrowser = false;
  private active: Page | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  pointer = { x: 680, y: 384 };
  refs = new Map<string, RefEntry>();
  refUrl = '';

  /** 窗口是不是这次会话打开的。接到别人的窗口时，关闭只断开自己。 */
  ownsWindow(): boolean {
    return this.ownsBrowser;
  }

  /** 同一时间只跑一个浏览器动作。多个会话之间用文件锁排队。 */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(
      () => withBrowserLock(fn),
      () => withBrowserLock(fn),
    );
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async ensure(): Promise<Page> {
    if (this.context && this.active && !this.active.isClosed()) return this.active;
    await this.launch();
    if (!this.active) throw new Error('Chrome 已启动，但没有可用的标签页');
    return this.active;
  }

  async launch(): Promise<void> {
    await this.close();
    const dir = profileDir();
    await fs.mkdir(dir, { recursive: true });
    try {
      const context = await chromium.launchPersistentContext(dir, persistentContextOptions());
      this.ownsBrowser = true;
      this.browser = context.browser();
      await this.adopt(context);
      return;
    } catch (error) {
      const attached = await this.tryAttach();
      if (attached) {
        console.error('mcp-cui-chrome: 配置目录已有 Chrome，已接到这个窗口');
        await this.adopt(attached);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const brief = message.replace(/\s+/g, ' ').trim().slice(0, 400);
      throw new Error(
        `启动 Chrome 失败。请确认已安装 Google Chrome，或设置 MCP_CHROME_PATH 为 chrome.exe 的完整路径。若另一个会话已经打开了窗口，但那是本次更新前启动的，需要先关掉那个窗口再试。原始错误：${brief}`,
      );
    }
  }

  /** 关掉自己打开的窗口。接到别人的窗口时只断开连接。 */
  async close(): Promise<string> {
    const owns = this.ownsBrowser;
    const context = this.context;
    const browser = this.browser;
    this.context = null;
    this.browser = null;
    this.ownsBrowser = false;
    this.active = null;
    this.refs.clear();
    this.refUrl = '';
    if (owns && context) {
      await context.close().catch(() => undefined);
      return '浏览器已关闭';
    }
    if (browser) {
      await browser.close().catch(() => undefined);
      return '已断开连接，窗口仍由打开它的会话使用';
    }
    return '浏览器没有打开';
  }

  private async tryAttach(): Promise<BrowserContext | null> {
    const portFile = path.join(profileDir(), 'DevToolsActivePort');
    let raw: string;
    try {
      raw = await fs.readFile(portFile, 'utf8');
    } catch {
      return null;
    }
    const port = raw.split(/\r?\n/)[0]?.trim() ?? '';
    if (!/^\d+$/.test(port) || port === '0') return null;
    let browser: Browser;
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch {
      return null;
    }
    const context = browser.contexts()[0];
    if (!context) {
      await browser.close().catch(() => undefined);
      return null;
    }
    this.browser = browser;
    this.ownsBrowser = false;
    return context;
  }

  private async adopt(context: BrowserContext): Promise<void> {
    this.context = context;
    await context.addInitScript(stripPlaywrightArtifacts).catch(() => undefined);
    await context.addInitScript(showCuiChromeBar).catch(() => undefined);
    context.on('page', (page) => {
      if (!this.active || this.active.isClosed()) this.active = page;
    });
    context.on('close', () => {
      this.context = null;
      this.browser = null;
      this.ownsBrowser = false;
      this.active = null;
      this.refs.clear();
      this.refUrl = '';
    });
    const pages = context.pages().filter((page) => !page.isClosed());
    const site = [...pages].reverse().find((page) => /^https?:/i.test(page.url()));
    this.active = site ?? pages[0] ?? (await context.newPage());
  }

  /**
   * 要看的地址已经在某个标签里就切过去，否则新开标签。
   * 只有一个空白页时直接用它，避免启动后再多一个空白标签。
   */
  async pageFor(url: string): Promise<{ page: Page; reused: boolean }> {
    await this.ensure();
    const context = this.context;
    if (!context) throw new Error('Chrome 已启动，但没有可用的标签页');
    const open = this.pages();
    const matches = open.filter((page) => sameDocument(page.url(), url));
    const existing = matches.find((page) => page === this.active) ?? matches.at(-1);
    if (existing) {
      await this.setActive(existing);
      return { page: existing, reused: true };
    }
    const soleBlank = open.length === 1 && open[0]?.url() === 'about:blank' ? open[0] : undefined;
    const page = soleBlank ?? (await context.newPage());
    await this.setActive(page);
    return { page, reused: false };
  }

  pages(): Page[] {
    return this.context?.pages().filter((page) => !page.isClosed()) ?? [];
  }

  async setActive(page: Page): Promise<void> {
    this.active = page;
    await page.bringToFront();
  }
}

function sameDocument(current: string, target: string): boolean {
  let left: URL;
  let right: URL;
  try {
    left = new URL(current);
    right = new URL(target);
  } catch {
    return false;
  }
  if (left.origin !== right.origin) return false;
  const pathOf = (value: string) => value.replace(/\/+$/, '') || '/';
  if (pathOf(left.pathname) !== pathOf(right.pathname)) return false;
  const query = (url: URL) =>
    [...url.searchParams.entries()]
      .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])))
      .map(([key, value]) => `${key}=${value}`)
      .join('&');
  return query(left) === query(right);
}

export const session = new Session();
