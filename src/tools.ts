import type { McpServer } from '@modelcontextprotocol/server';
import type { Page } from 'rebrowser-playwright';
import * as z from 'zod/v4';
import { humanClick, humanDrag, humanHover, humanPress, humanScroll, humanType, sleep } from './human.js';
import { session } from './session.js';
import { setCuiChromeStatus } from './stealth.js';
import { locatorFor, takeSnapshot } from './snapshot.js';

type ToolResult = {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
  isError?: boolean;
};

function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text }], isError };
}

const PREPARE_PAUSE_MS = 800;

function clip(text: string, max = 40): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function targetLabel(ref: string): string {
  const entry = session.refs.get(ref);
  const name = entry?.name.trim();
  return name ? `「${clip(name, 30)}」` : ref;
}

async function showStatus(page: Page, status: string): Promise<void> {
  await page.evaluate(setCuiChromeStatus, status).catch(() => undefined);
}

/** 先把准备做的事写到页面上，停一下，再执行。返回值同时带准备和结果。 */
async function act(
  intent: string,
  fn: (page: Page) => Promise<string>,
  pick?: () => Promise<Page>,
): Promise<ToolResult> {
  try {
    const text = await session.run(async () => {
      const page = pick ? await pick() : await session.ensure();
      await showStatus(page, intent);
      await sleep(PREPARE_PAUSE_MS);
      const outcome = await fn(page);
      const result = `结果：成功。${outcome}`;
      await showStatus(page, result);
      const detail = await takeSnapshot(await session.ensure(), session);
      return `${intent}\n${result}\n\n${detail}`;
    });
    return textResult(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const result = `结果：失败。${message}`;
    try {
      await session.run(async () => {
        await showStatus(await session.ensure(), result);
      });
    } catch {
      /* 窗口已经不可用时，只把失败写进返回值。 */
    }
    return textResult(`${intent}\n${result}`, true);
  }
}

function assertHttp(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`无效地址：${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('只允许打开 http 或 https 地址');
  }
  return parsed.toString();
}

async function settle(page: Page): Promise<void> {
  await sleep(250);
  await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => undefined);
  await sleep(150 + Math.random() * 250);
}

async function tabList(): Promise<string> {
  const pages = session.pages();
  const current = await session.ensure();
  const lines = await Promise.all(
    pages.map(async (page, index) => {
      const mark = page === current ? '  ← 当前' : '';
      const title = (await page.title()) || '（无标题）';
      return `${index}. ${title} — ${page.url()}${mark}`;
    }),
  );
  return lines.join('\n') || '（没有标签页）';
}

export function registerTools(server: McpServer): void {
  server.registerTool(
    'browser_navigate',
    {
      title: '打开网页',
      description:
        '用户要打开 Chrome 或访问网页时用这个，不要用 IDE 内置浏览器。打开一个 http(s) 地址。相同地址的标签已存在就切换过去，没有再新建，不改别的标签。',
      inputSchema: z.object({
        url: z.string().describe('要打开的 http 或 https 地址'),
      }),
    },
    async ({ url }) => {
      const target = assertHttp(url);
      const intent = `准备：打开 ${clip(target, 60)}`;
      let reused = false;
      return act(
        intent,
        async (page) => {
          if (reused) return `已切换到已打开的标签 ${page.url()}`;
          await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await settle(page);
          return `已打开 ${page.url()}`;
        },
        async () => {
          const picked = await session.pageFor(target);
          reused = picked.reused;
          return picked.page;
        },
      );
    },
  );

  server.registerTool(
    'browser_snapshot',
    {
      title: '读取页面',
      description:
        '用户要看当前 Chrome 页面时用这个。读取标题、网址、可操作元素编号和正文。若本该有的内容不在，用 browser_reload 刷新一次再读。快照若写了遮挡，先关掉那一层或按 Escape。',
      inputSchema: z.object({}),
    },
    async () => {
      const intent = '准备：读取当前页面';
      return act(intent, async (page) => `已读取 ${page.url()}`);
    },
  );

  server.registerTool(
    'browser_click',
    {
      title: '拟人点击',
      description:
        '通用：按快照编号点击。开始前显示要点的元素，结束后显示是否成功、页面有没有跳转。落点被别的内容挡住时会失败，不点穿过去。',
      inputSchema: z.object({
        ref: z.string().describe('快照里的元素编号，例如 e3'),
        button: z.enum(['left', 'right', 'middle']).optional().describe('鼠标按键，默认左键'),
      }),
    },
    async ({ ref, button }) => {
      const intent = `准备：点击 ${targetLabel(ref)}`;
      return act(intent, async (page) => {
        const before = page.url();
        const locator = await locatorFor(page, session, ref);
        await humanClick(page, session.pointer, locator, button ?? 'left');
        await settle(page);
        const after = (await session.ensure()).url();
        return after === before ? `已点击 ${targetLabel(ref)}` : `已点击 ${targetLabel(ref)}，页面到了 ${after}`;
      });
    },
  );

  server.registerTool(
    'browser_type',
    {
      title: '拟人输入',
      description: '通用：只对文本框逐字输入。下拉框、选项、按钮会直接失败，并说明该用点选还是点击。',
      inputSchema: z.object({
        ref: z.string().describe('输入框编号，例如 e2'),
        text: z.string().describe('要输入的文字'),
        clear: z.boolean().optional().describe('输入前先全选并删除已有内容'),
        submit: z.boolean().optional().describe('输入完成后按 Enter'),
      }),
    },
    async ({ ref, text, clear, submit }) => {
      const intent = `准备：在 ${targetLabel(ref)} 输入「${clip(text)}」`;
      return act(intent, async (page) => {
        const entry = session.refs.get(ref);
        if (entry?.gesture && !entry.gesture.startsWith('输入')) {
          throw new Error(`${ref} 的操作是「${entry.gesture}」，不能往里面输入文字`);
        }
        const locator = await locatorFor(page, session, ref);
        await humanType(page, session.pointer, locator, text, clear ?? false);
        if (submit) await humanPress(page, 'Enter');
        await settle(page);
        let shown = '';
        try {
          shown = await locator.inputValue();
        } catch {
          shown = '';
        }
        const wrote = shown ? `框里现在是「${clip(shown)}」` : '已逐字输入';
        return `已在 ${targetLabel(ref)} 输入。${wrote}`;
      });
    },
  );

  server.registerTool(
    'browser_press',
    {
      title: '按键',
      description: '通用：在当前焦点按一个键。开始前显示键名，结束后显示是否成功。',
      inputSchema: z.object({
        key: z.string().describe('Playwright 键名，例如 Enter、Control+A'),
      }),
    },
    async ({ key }) => {
      const intent = `准备：按键 ${key}`;
      return act(intent, async (page) => {
        await humanPress(page, key);
        await settle(page);
        return `已按下 ${key}`;
      });
    },
  );

  server.registerTool(
    'browser_hover',
    {
      title: '悬停',
      description: '通用：把鼠标移到编号对应的元素上，不点击。用来展开需要悬停才出现的菜单。',
      inputSchema: z.object({
        ref: z.string().describe('元素编号，例如 e4'),
      }),
    },
    async ({ ref }) => {
      const intent = `准备：悬停 ${targetLabel(ref)}`;
      return act(intent, async (page) => {
        const locator = await locatorFor(page, session, ref);
        await humanHover(page, session.pointer, locator);
        return `鼠标已移到 ${targetLabel(ref)}`;
      });
    },
  );

  server.registerTool(
    'browser_drag',
    {
      title: '拖拽',
      description: '通用：按住一个元素，拖到另一个元素上，或按像素偏移拖动。用于滑块、排序和需要拖动的控件。',
      inputSchema: z.object({
        from: z.string().describe('拖动起点的元素编号'),
        to: z.string().optional().describe('拖动终点的元素编号'),
        dx: z.number().optional().describe('没有 to 时，相对起点向右的像素，向左用负数'),
        dy: z.number().optional().describe('没有 to 时，相对起点向下的像素，向上用负数'),
      }),
    },
    async ({ from, to, dx, dy }) => {
      const intent = to ? `准备：把 ${targetLabel(from)} 拖到 ${targetLabel(to)}` : `准备：拖动 ${targetLabel(from)}`;
      return act(intent, async (page) => {
        if (!to && dx === undefined && dy === undefined) {
          throw new Error('拖拽需要终点编号 to，或像素偏移 dx、dy');
        }
        const source = await locatorFor(page, session, from);
        if (to) {
          const target = await locatorFor(page, session, to);
          const box = await target.boundingBox();
          if (!box) throw new Error(`编号 ${to} 没有可拖到的位置`);
          await humanDrag(page, session.pointer, source, {
            x: box.x + box.width / 2,
            y: box.y + box.height / 2,
          });
          return `已把 ${targetLabel(from)} 拖到 ${targetLabel(to)}`;
        }
        const box = await source.boundingBox();
        if (!box) throw new Error(`编号 ${from} 没有可拖动的位置`);
        await humanDrag(page, session.pointer, source, {
          x: box.x + box.width / 2 + (dx ?? 0),
          y: box.y + box.height / 2 + (dy ?? 0),
        });
        return `已拖动 ${targetLabel(from)}`;
      });
    },
  );

  server.registerTool(
    'browser_scroll',
    {
      title: '滚动',
      description: '通用：在当前页面分段滚动。开始前显示方向，结束后显示是否成功。',
      inputSchema: z.object({
        direction: z.enum(['up', 'down']).describe('滚动方向'),
        pixels: z.number().int().positive().max(4000).optional().describe('滚动像素，默认大约 480 到 760'),
      }),
    },
    async ({ direction, pixels }) => {
      const way = direction === 'up' ? '向上' : '向下';
      const intent = `准备：${way}滚动${pixels ? pixels + '像素' : ''}`;
      return act(intent, async (page) => {
        await humanScroll(page, session.pointer, direction, pixels);
        await sleep(120);
        return `已${way}滚动`;
      });
    },
  );

  server.registerTool(
    'browser_tabs',
    {
      title: '标签页',
      description: '通用：列出、新建、切换或关闭标签。开始前说明要做什么，结束后说明是否成功。',
      inputSchema: z.object({
        action: z.enum(['list', 'new', 'switch', 'close']).describe('list、new、switch 或 close'),
        index: z.number().int().nonnegative().optional().describe('switch 或 close 的标签序号，从 0 开始'),
        url: z.string().optional().describe('new 时可选，新建后立刻打开的地址'),
      }),
    },
    async ({ action, index, url }) => {
      const intent =
        action === 'list'
          ? '准备：列出标签页'
          : action === 'new'
            ? `准备：新建标签${url ? `并打开 ${clip(url, 40)}` : ''}`
            : action === 'switch'
              ? `准备：切换到第 ${index ?? '?'} 个标签`
              : `准备：关闭第 ${index ?? '?'} 个标签`;
      return act(intent, async (page) => {
        const context = page.context();
        if (action === 'list') return `标签如下。\n${await tabList()}`;
        if (action === 'new') {
          const created = await context.newPage();
          await session.setActive(created);
          if (url) {
            await created.goto(assertHttp(url), { waitUntil: 'domcontentloaded', timeout: 30000 });
            await settle(created);
          }
          return `已新建标签，当前是 ${created.url()}`;
        }
        if (index === undefined) throw new Error('switch 和 close 需要 index');
        const pages = session.pages();
        const target = pages[index];
        if (!target) throw new Error(`没有序号 ${index} 的标签，当前共 ${pages.length} 个`);
        if (action === 'switch') {
          await session.setActive(target);
          return `已切换到 ${target.url()}`;
        }
        const wasActive = target === page;
        await target.close();
        const rest = session.pages();
        if (rest.length === 0) {
          const created = await context.newPage();
          await session.setActive(created);
          return '已关闭最后一个标签，并打开了一个空白页';
        }
        if (wasActive) await session.setActive(rest[Math.max(0, index - 1)] ?? rest[0]!);
        return `已关闭第 ${index} 个标签`;
      });
    },
  );

  server.registerTool(
    'browser_reload',
    {
      title: '刷新页面',
      description:
        '通用：刷新当前标签，相当于 F5。快照里本该出现的按钮或正文没有时用一次，然后再读页面。不要连续反复刷新。',
      inputSchema: z.object({}),
    },
    async () => {
      const intent = '准备：刷新当前页面';
      return act(intent, async (page) => {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
        await settle(page);
        return `已刷新 ${page.url()}`;
      });
    },
  );

  server.registerTool(
    'browser_go_back',
    {
      title: '后退',
      description: '通用：当前标签后退一页。开始前说明，结束后显示是否退回到上一页。',
      inputSchema: z.object({}),
    },
    async () => {
      const intent = '准备：后退一页';
      return act(intent, async (page) => {
        const before = page.url();
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 });
        await settle(page);
        if (page.url() === before) throw new Error('没有可以后退的历史');
        return `已后退到 ${page.url()}`;
      });
    },
  );

  server.registerTool(
    'browser_screenshot',
    {
      title: '截图',
      description: '通用：截取当前视口。开始前在页面上说明，结束后返回图片并标明成功或失败。',
      inputSchema: z.object({}),
    },
    async () => {
      const intent = '准备：截取当前页面';
      try {
        const shot = await session.run(async () => {
          const page = await session.ensure();
          await showStatus(page, intent);
          await sleep(PREPARE_PAUSE_MS);
          const buffer = await page.screenshot({ type: 'png' });
          const result = '结果：成功。已截取当前视口';
          await showStatus(page, result);
          const title = await page.title();
          return { data: buffer.toString('base64'), caption: `${intent}\n${result}\n${title}\n${page.url()}` };
        });
        return {
          content: [
            { type: 'image' as const, data: shot.data, mimeType: 'image/png' },
            { type: 'text' as const, text: shot.caption },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return textResult(`${intent}\n结果：失败。${message}`, true);
      }
    },
  );

  server.registerTool(
    'browser_close',
    {
      title: '关闭浏览器',
      description: '通用：关掉这次会话自己打开的 Chrome。如果窗口是别的会话打开的，只断开连接，窗口留着。',
      inputSchema: z.object({}),
    },
    async () => {
      const intent = '准备：关闭浏览器';
      try {
        const outcome = await session.run(async () => {
          const page = await session.ensure();
          await showStatus(page, intent);
          await sleep(PREPARE_PAUSE_MS);
          const closing = session.ownsWindow();
          await showStatus(page, closing ? '结果：成功。正在关闭' : '结果：成功。断开连接，窗口保留');
          return session.close();
        });
        return textResult(`${intent}\n结果：成功。${outcome}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return textResult(`${intent}\n结果：失败。${message}`, true);
      }
    },
  );
}
