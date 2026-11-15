import fs from 'node:fs/promises';
import { chromium, type BrowserContext, type Page } from 'rebrowser-playwright';
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
  private active: Page | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  pointer = { x: 680, y: 384 };
  refs = new Map<string, RefEntry>();
  refUrl = '';

  /** 同一时间只跑一个浏览器动作，避免鼠标轨迹互相打断。 */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
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
    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(dir, persistentContextOptions());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `启动 Chrome 失败。请确认已安装 Google Chrome，或设置 MCP_CHROME_PATH 为 chrome.exe 的完整路径。原始错误：${message}`,
      );
    }
    this.context = context;
    await context.addInitScript(stripPlaywrightArtifacts);
    await context.addInitScript(showCuiChromeBar);
    context.on('page', (page) => {
      this.active = page;
    });
    context.on('close', () => {
      this.context = null;
      this.active = null;
      this.refs.clear();
      this.refUrl = '';
    });
    const pages = context.pages().filter((page) => !page.isClosed());
    this.active = pages[0] ?? (await context.newPage());
  }

  async close(): Promise<void> {
    const context = this.context;
    this.context = null;
    this.active = null;
    this.refs.clear();
    this.refUrl = '';
    if (context) await context.close().catch(() => undefined);
  }

  pages(): Page[] {
    return this.context?.pages().filter((page) => !page.isClosed()) ?? [];
  }

  async setActive(page: Page): Promise<void> {
    this.active = page;
    await page.bringToFront();
  }
}

export const session = new Session();
