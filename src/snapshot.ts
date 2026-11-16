import type { CDPSession, Frame, Locator, Page } from 'rebrowser-playwright';
import type { FrameRef, RefEntry } from './session.js';

const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'textarea',
  'select',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[role="textbox"]',
  '[role="searchbox"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="switch"]',
  '[role="option"]',
  '[role="treeitem"]',
  '[role="slider"]',
  '[contenteditable="true"]',
].join(',');

const ROLE_LABEL: Record<string, string> = {
  link: '链接',
  button: '按钮',
  textbox: '输入框',
  searchbox: '搜索框',
  checkbox: '复选框',
  radio: '单选',
  combobox: '下拉框',
  listbox: '列表',
  tab: '标签页',
  menuitem: '菜单项',
  menuitemcheckbox: '选项',
  menuitemradio: '选项',
  switch: '开关',
  option: '选项',
  slider: '滑块',
};

const MAX_REFS = 120;

type RawElement = {
  selector: string;
  role: string;
  name: string;
  gesture: string;
  inViewport: boolean;
  disabled: boolean;
};

export type RefStore = {
  refs: Map<string, RefEntry>;
  refUrl: string;
};

/** 页面里执行的脚本用字符串生成，避免打包器把 Node 辅助函数塞进浏览器。 */
const collectElements = new Function(
  'selector',
  `
    function visible(el) {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return false;
      if (Number(style.opacity) === 0 && !paintedControl(el)) return false;
      const hidden = el.closest('[aria-hidden="true"]');
      if (!hidden || hidden === el) return true;
      const hiddenStyle = window.getComputedStyle(hidden);
      return hiddenStyle.display !== 'none' && hiddenStyle.visibility !== 'hidden' && Number(hiddenStyle.opacity) !== 0;
    }

    function paintedControl(el) {
      const type = (el.getAttribute('type') || '').toLowerCase();
      const role = (el.getAttribute('role') || '').split(/\\s+/)[0] || '';
      return type === 'checkbox' || type === 'radio' || role === 'checkbox' || role === 'radio' || role === 'switch';
    }

    function cssPath(el) {
      const parts = [];
      let node = el;
      while (node && node !== document.documentElement) {
        if (node.id && /^[A-Za-z][\\w:-]*$/.test(node.id)) {
          const idSel = '#' + CSS.escape(node.id);
          if (document.querySelectorAll(idSel).length === 1) {
            parts.unshift(idSel);
            break;
          }
        }
        const parent = node.parentElement;
        if (!parent) break;
        const tag = node.tagName.toLowerCase();
        const sameTag = [...parent.children].filter((child) => child.tagName === node.tagName);
        const part = sameTag.length > 1 ? tag + ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')' : tag;
        parts.unshift(part);
        node = parent;
      }
      return parts.join(' > ');
    }

    function roleOf(el) {
      const explicit = el.getAttribute('role');
      if (explicit) return explicit.split(/\\s+/)[0] || 'button';
      const tag = el.tagName;
      if (tag === 'A') return 'link';
      if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
      if (tag === 'TEXTAREA') return 'textbox';
      if (tag === 'SELECT') return 'combobox';
      if (el.getAttribute('contenteditable') === 'true') return 'textbox';
      if (tag === 'INPUT') {
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
        if (type === 'search') return 'searchbox';
        if (type === 'range') return 'slider';
        return 'textbox';
      }
      return 'button';
    }

    function gestureOf(el, role) {
      const opensMenu = el.tagName === 'SELECT' || role === 'combobox' || role === 'listbox';
      const multi = el.hasAttribute('multiple') || el.getAttribute('aria-multiselectable') === 'true';
      if (opensMenu) return multi ? '点开后可多选，不要输入文字' : '点开后点选一项，不要输入文字';
      if (role === 'option' || role === 'menuitem' || role === 'menuitemcheckbox' || role === 'menuitemradio' || role === 'treeitem') return '点击选中';
      if (role === 'slider') return '拖动';
      if (role === 'checkbox' || role === 'radio' || role === 'switch') return '点击切换';
      if (role === 'textbox' || role === 'searchbox') return '输入文字';
      return '点击';
    }

    function nameOf(el) {
      const aria = el.getAttribute('aria-label');
      if (aria && aria.trim()) return aria;
      const labelledby = el.getAttribute('aria-labelledby');
      if (labelledby) {
        const text = labelledby.split(/\\s+/).map((id) => {
          const label = document.getElementById(id);
          return label ? label.textContent || '' : '';
        }).join(' ').trim();
        if (text) return text;
      }
      const type = (el.getAttribute('type') || '').toLowerCase();
      if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.placeholder) return el.placeholder;
      if ((type === 'submit' || type === 'button' || type === 'reset') && el.value) return el.value;
      const text = (el.textContent || '').trim();
      if (text) return text;
      const own = el.getAttribute('title') || el.getAttribute('alt') || '';
      if (own) return own;
      const label = el.closest('label');
      if (label) {
        const labelText = (label.innerText || label.textContent || '').trim();
        if (labelText) return labelText;
      }
      if (el.id) {
        const forLabel = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (forLabel) return (forLabel.innerText || forLabel.textContent || '').trim();
      }
      return '';
    }

    const seen = new Set();
    const items = [];
    for (const el of document.querySelectorAll(selector)) {
      if (!visible(el)) continue;
      const selectorPath = cssPath(el);
      if (!selectorPath || seen.has(selectorPath)) continue;
      seen.add(selectorPath);
      const rect = el.getBoundingClientRect();
      items.push({
        selector: selectorPath,
        role: roleOf(el),
        name: nameOf(el).replace(/\\s+/g, ' ').trim().slice(0, 80),
        gesture: gestureOf(el, roleOf(el)),
        inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth,
        disabled: el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true',
      });
    }

    function inOverlay(el) {
      let node = el.parentElement;
      while (node && node !== document.body && node !== document.documentElement) {
        const role = (node.getAttribute('role') || '').toLowerCase();
        if (role === 'menu' || role === 'listbox' || role === 'list') return true;
        const style = window.getComputedStyle(node);
        if (style.position === 'absolute' || style.position === 'fixed') {
          const rect = node.getBoundingClientRect();
          if (
            rect.width >= 48 &&
            rect.height >= 24 &&
            rect.width <= window.innerWidth * 0.92 &&
            rect.height <= window.innerHeight * 0.92
          ) return true;
        }
        node = node.parentElement;
      }
      return false;
    }

    for (const el of document.querySelectorAll('div, li')) {
      if (el.matches(selector) || !visible(el) || !inOverlay(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.height < 16 || rect.height > 64 || rect.width < 24) continue;
      const style = window.getComputedStyle(el);
      const siblings = el.parentElement
        ? [...el.parentElement.children].filter((child) => child.tagName === el.tagName).length
        : 0;
      if (style.cursor !== 'pointer' && el.tagName !== 'LI' && siblings < 2) continue;
      const text = (el.innerText || '').replace(/\\s+/g, ' ').trim();
      if (!text || text.length > 60) continue;
      const parentText = el.parentElement ? (el.parentElement.innerText || '').replace(/\\s+/g, ' ').trim() : '';
      if (parentText === text) continue;
      const selectorPath = cssPath(el);
      if (!selectorPath || seen.has(selectorPath)) continue;
      seen.add(selectorPath);
      items.push({
        selector: selectorPath,
        role: 'option',
        name: text.slice(0, 80),
        gesture: '点击选中',
        inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth,
        disabled: el.getAttribute('aria-disabled') === 'true',
      });
    }
    return items;
  `,
) as (selector: string) => RawElement[];

const readCover = new Function(`
  function isBar(el) {
    return !el || el.id === 'cui-chrome-bar' || (el.closest && el.closest('#cui-chrome-bar'));
  }
  function shown(el) {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width >= 8 && rect.height >= 8 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
  }
  function labelOf(el) {
    const name = el.getAttribute('aria-label') || '';
    const text = (el.innerText || '').replace(/\\s+/g, ' ').trim();
    return (name || text).slice(0, 40);
  }
  const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"]')].filter((el) => shown(el) && !isBar(el));
  let layer = dialogs.length ? dialogs[dialogs.length - 1] : null;
  if (!layer) {
    const hit = document.elementFromPoint(Math.round(window.innerWidth / 2), Math.round(window.innerHeight / 2));
    let node = hit;
    while (node && node !== document.body && node !== document.documentElement) {
      if (isBar(node)) break;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      const floating = style.position === 'fixed' || style.position === 'absolute';
      const full = rect.width >= window.innerWidth * 0.96 && rect.height >= window.innerHeight * 0.96;
      const big = rect.width >= window.innerWidth * 0.3 && rect.height >= window.innerHeight * 0.22;
      if (floating && big && !full && shown(node)) layer = node;
      node = node.parentElement;
    }
  }
  if (!layer) return '';
  const name = labelOf(layer);
  const hint = '先关掉这层或按 Escape，再操作被挡住的内容。';
  return name ? '遮挡：「' + name + '」。' + hint : '遮挡：页面上有一层挡住下面的内容。' + hint;
`) as () => string;

const readBody = new Function(`
  const root = document.querySelector('main') || document.body;
  const text = root && root.innerText ? root.innerText : '';
  return text.replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 2000);
`) as () => string;

type Collected = RawElement & { frameRef?: FrameRef };

function sketch(text: string, max = 36): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export async function takeSnapshot(page: Page, store: RefStore): Promise<string> {
  const frames = page.frames();
  const main = page.mainFrame();
  // 分桶：主文档视口内、主文档视口外、iframe 视口内、iframe 视口外。
  const buckets: Collected[][] = [[], [], [], []];

  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    if (!frame) continue;
    let raw: RawElement[];
    try {
      raw = await frame.evaluate(collectElements, INTERACTIVE_SELECTOR);
    } catch {
      // iframe 还在加载或已销毁时读不到，跳过，不影响主文档。
      continue;
    }
    const frameRef: FrameRef | undefined =
      frame === main ? undefined : { index, url: frame.url(), name: frame.name() };
    for (const item of raw) {
      const bucket = frameRef ? (item.inViewport ? 2 : 3) : item.inViewport ? 0 : 1;
      buckets[bucket]!.push({ ...item, frameRef });
    }
  }

  const ordered = buckets.flat();
  const shown = ordered.slice(0, MAX_REFS);
  store.refs.clear();
  store.refUrl = page.url();

  const lines = shown.map((item, index) => {
    const ref = `e${index + 1}`;
    store.refs.set(ref, {
      selector: item.selector,
      role: item.role,
      name: item.name,
      gesture: item.gesture,
      frame: item.frameRef,
    });
    const role = ROLE_LABEL[item.role] ?? item.role;
    const name = item.name ? `「${item.name}」` : '「未命名」';
    const where = item.inViewport ? '视口内' : '视口外';
    const disabled = item.disabled ? ' 禁用' : '';
    const inFrame = item.frameRef
      ? ` 在iframe(${sketch(item.frameRef.url || item.frameRef.name || 'about:blank')})`
      : '';
    return `- ${ref} ${role}${name} ${where}${disabled}${inFrame} 操作：${item.gesture}`;
  });

  const body = await page.evaluate(readBody);
  const cover = await page.evaluate(readCover);
  const title = await page.title();
  const hidden = ordered.length - shown.length;
  const tail = hidden > 0 ? `\n其余 ${hidden} 个元素未列出，滚动后再 snapshot。` : '';
  const list = lines.length > 0 ? lines.join('\n') : '（没有可操作元素。若这块内容本该有，刷新一次再读。）';
  const blocks = [`标题：${title || '（无标题）'}`, `网址：${page.url()}`];
  if (cover) blocks.push('', cover);
  const frameTotal = frames.length - 1;
  const frameNote =
    frameTotal > 0
      ? `\n页面含 ${frameTotal} 个 iframe；iframe 内的可操作元素已一并编号（标「在iframe」）。`
      : '';
  blocks.push('', '元素：', list + tail + frameNote, '', '正文：', body || '（没有正文）');
  return blocks.join('\n');
}

/** 把记录下来的 iframe 找回当前页面里的实际 frame，位置、网址、名字都可能变。 */
function resolveFrame(page: Page, target: FrameRef): Frame {
  const frames = page.frames();
  const exact = frames[target.index];
  if (exact && exact.url() === target.url && exact.name() === target.name) return exact;
  const byName = frames.find((frame) => frame.url() === target.url && frame.name() === target.name);
  if (byName) return byName;
  const byUrl = frames.find((frame) => frame.url() === target.url);
  if (byUrl) return byUrl;
  throw new Error('编号所在的 iframe 已经变化，请重新 snapshot');
}

export async function locatorFor(page: Page, store: RefStore, ref: string): Promise<Locator> {
  if (!store.refs.size) throw new Error('还没有页面快照，请先调用 browser_snapshot');
  if (page.url() !== store.refUrl) {
    throw new Error(`编号 ${ref} 已过期，页面已经离开 ${store.refUrl}，请重新 snapshot`);
  }
  const entry = store.refs.get(ref);
  if (!entry) throw new Error(`没有编号 ${ref}，请先 snapshot`);
  const frame = entry.frame ? resolveFrame(page, entry.frame) : page.mainFrame();
  const locator = frame.locator(entry.selector);
  if ((await locator.count()) === 0) throw new Error(`编号 ${ref} 已过期，请重新 snapshot`);
  return locator.first();
}

/** CSS 选择器命中后的定位结果，带控件类型和位置，供工具反馈和输入校验用。 */
export type SelectorTarget = {
  locator: Locator;
  label: string;
  gesture: string;
};

const inspectElement = new Function(
  'el',
  `
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    let role = (el.getAttribute('role') || '').split(/\\s+/)[0] || '';
    if (!role) {
      if (tag === 'a') role = 'link';
      else if (tag === 'button' || tag === 'summary' || (tag === 'input' && ['button','submit','reset','image'].includes(type))) role = 'button';
      else if (tag === 'textarea' || (tag === 'input' && !['checkbox','radio','range','file','hidden'].includes(type)) || el.getAttribute('contenteditable') === 'true') role = 'textbox';
      else if (tag === 'input' && type === 'checkbox') role = 'checkbox';
      else if (tag === 'input' && type === 'radio') role = 'radio';
      else if (tag === 'input' && type === 'range') role = 'slider';
      else if (tag === 'select') role = 'combobox';
    }
    let gesture = '点击';
    if (role === 'textbox' || role === 'searchbox') gesture = '输入文字';
    else if (role === 'slider') gesture = '拖动';
    else if (role === 'checkbox' || role === 'radio' || role === 'switch') gesture = '点击切换';
    else if (role === 'combobox' || role === 'listbox') gesture = '点开后点选一项，不要输入文字';
    else if (['option','menuitem','treeitem'].includes(role)) gesture = '点击选中';
    const name = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || (el.innerText || el.textContent || '').trim() || el.getAttribute('title') || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
    return {
      role,
      gesture,
      name,
      disabled: el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true',
    };
  `,
) as (el: Element) => { role: string; gesture: string; name: string; disabled: boolean };

/**
 * 按 CSS 选择器定位。主文档和所有 iframe 都会搜，命中按 frame 顺序排列。
 * 编号方式失效时的后备手段：不依赖快照，也不要求元素出现在可操作元素列表里。
 */
export async function locatorForSelector(page: Page, selector: string, nth = 0): Promise<SelectorTarget> {
  const query = selector.trim();
  if (!query) throw new Error('CSS 选择器不能为空');
  const main = page.mainFrame();
  const hits: Array<{ frame: Frame; index: number; where: string }> = [];
  let syntaxError = '';

  for (const frame of page.frames()) {
    let count = 0;
    try {
      count = await frame.locator(query).count();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!syntaxError) syntaxError = message.replace(/\s+/g, ' ').trim().slice(0, 200);
      continue;
    }
    const where = frame === main ? '' : ` 在iframe(${sketch(frame.url() || frame.name() || 'about:blank')})`;
    for (let i = 0; i < count; i += 1) hits.push({ frame, index: i, where });
  }

  if (hits.length === 0) {
    if (syntaxError) throw new Error(`CSS 选择器「${query}」无效：${syntaxError}`);
    throw new Error(`CSS 选择器「${query}」没有匹配到元素。先 snapshot 看页面结构，或换个选择器。`);
  }
  if (nth >= hits.length) {
    throw new Error(`CSS 选择器「${query}」只匹配到 ${hits.length} 个元素，没有第 ${nth} 个。`);
  }
  if (hits.length > 1 && nth === 0 && !query.includes(':nth-match')) {
    const samples: string[] = [];
    for (const hit of hits.slice(0, 5)) {
      const info = await hit.frame.locator(query).nth(hit.index).evaluate(inspectElement).catch(() => null);
      samples.push(`第 ${hit.index} 个${info?.name ? `「${sketch(info.name)}」` : ''}${hit.where}`);
    }
    const rest = hits.length > 5 ? `，另有 ${hits.length - 5} 个` : '';
    throw new Error(
      `CSS 选择器「${query}」匹配到 ${hits.length} 个元素：${samples.join('；')}${rest}。请写更精确的选择器，或传 nth 指定第几个（从 0 开始）。`,
    );
  }

  const hit = hits[nth]!;
  const target = hit.frame.locator(query).nth(hit.index);
  const info = await target.evaluate(inspectElement).catch(() => null);
  const label = `CSS「${sketch(query, 40)}」${info?.name ? `「${sketch(info.name, 30)}」` : ''}${info?.disabled ? ' 禁用' : ''}${hit.where}`;
  return { locator: target, label, gesture: info?.gesture ?? '' };
}

/* ---------------- 读取元素信息（对标 Selenium 的 Web Element 信息读取） ---------------- */

export type ElementDetails = {
  tag: string;
  innerText: string;
  textContent: string;
  /** 穿透 closed shadow DOM 读到的文字，普通脚本读不到时用 CDP 补上。 */
  shadowText: string;
  attributes: Record<string, string>;
  state: {
    visible: boolean;
    enabled: boolean;
    checked: boolean;
    selected: boolean;
    focused: boolean;
  };
  box: { x: number; y: number; width: number; height: number } | null;
  styles: Record<string, string>;
};

/** 页面内执行：读取元素的标签、文字、属性、状态、位置、指定样式。 */
const readElementCore = new Function(
  'el',
  'cssProps',
  `
    const tag = el.tagName.toLowerCase();
    const innerText = (el.innerText || '').trim();
    const textContent = (el.textContent || '').trim();
    const attributes = {};
    for (const attr of el.attributes || []) attributes[attr.name] = attr.value;
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const state = {
      visible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden',
      enabled: !el.matches(':disabled') && el.getAttribute('aria-disabled') !== 'true',
      checked: el.checked === true || el.getAttribute('aria-checked') === 'true',
      selected: el.selected === true || el.getAttribute('aria-selected') === 'true',
      focused: document.activeElement === el || (el.contains && el.contains(document.activeElement)),
    };
    const styles = {};
    for (const prop of cssProps) {
      if (!prop) continue;
      styles[prop] = style.getPropertyValue(prop);
    }
    return {
      tag,
      innerText,
      textContent,
      attributes,
      state,
      box: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      styles,
    };
  `,
) as (el: Element, cssProps: string[]) => Omit<ElementDetails, 'shadowText'>;

/** 从一段 HTML 里去掉标签、还原实体，抽出可见文字。 */
function htmlToText(html: string): string {
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 读取元素完整信息。普通属性用 locator 读；文字若为空，再用 CDP 的 pierce 能力
 * 穿透 closed shadow DOM 补读（Playwright 的 >>> 选择器对 closed shadow 无效）。
 */
export async function readElementDetails(
  page: Page,
  locator: Locator,
  selector: string | undefined,
  cssProps: string[],
): Promise<ElementDetails> {
  const core = await locator.first().evaluate(readElementCore, cssProps);

  let shadowText = '';
  if (selector && selector.trim() && !core.innerText && !core.textContent) {
    let cdp: CDPSession | null = null;
    try {
      cdp = await page.context().newCDPSession(page);
      await cdp.send('DOM.enable');
      const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: selector.trim() });
      if (nodeId) {
        const { node } = await cdp.send('DOM.describeNode', { nodeId, pierce: true });
        const htmlParts: string[] = [];
        const { outerHTML } = await cdp.send('DOM.getOuterHTML', { nodeId });
        if (outerHTML) htmlParts.push(outerHTML);
        // describeNode 只给出 shadowRoots 的节点头，子节点不展开；用它们的 nodeId 单独取 HTML。
        const roots = (node as unknown as { shadowRoots?: Array<{ nodeId: number }> }).shadowRoots ?? [];
        for (const sr of roots) {
          try {
            const part = await cdp.send('DOM.getOuterHTML', { nodeId: sr.nodeId });
            if (part.outerHTML) htmlParts.push(part.outerHTML);
          } catch {
            /* 某个影子根取不到不影响其它部分。 */
          }
        }
        shadowText = htmlToText(htmlParts.join(' '));
      }
    } catch {
      /* CDP 不可用时保留空值，不影响常规信息返回。 */
    } finally {
      if (cdp) await cdp.detach().catch(() => undefined);
    }
  }

  return { ...core, shadowText };
}
