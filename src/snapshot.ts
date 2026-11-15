import type { Locator, Page } from 'rebrowser-playwright';
import type { RefEntry } from './session.js';

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

const MAX_REFS = 80;

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

const readBody = new Function(`
  const root = document.querySelector('main') || document.body;
  const text = root && root.innerText ? root.innerText : '';
  return text.replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 2000);
`) as () => string;

export async function takeSnapshot(page: Page, store: RefStore): Promise<string> {
  const raw = await page.evaluate(collectElements, INTERACTIVE_SELECTOR);
  const ordered = [...raw.filter((item) => item.inViewport), ...raw.filter((item) => !item.inViewport)];
  const shown = ordered.slice(0, MAX_REFS);
  store.refs.clear();
  store.refUrl = page.url();

  const lines = shown.map((item, index) => {
    const ref = `e${index + 1}`;
    store.refs.set(ref, { selector: item.selector, role: item.role, name: item.name, gesture: item.gesture });
    const role = ROLE_LABEL[item.role] ?? item.role;
    const name = item.name ? `「${item.name}」` : '「未命名」';
    const where = item.inViewport ? '视口内' : '视口外';
    const disabled = item.disabled ? ' 禁用' : '';
    return `- ${ref} ${role}${name} ${where}${disabled} 操作：${item.gesture}`;
  });

  const body = await page.evaluate(readBody);
  const title = await page.title();
  const hidden = ordered.length - shown.length;
  const tail = hidden > 0 ? `\n其余 ${hidden} 个元素未列出，滚动后再 snapshot。` : '';
  const list = lines.length > 0 ? lines.join('\n') : '（没有可操作元素）';
  return [`标题：${title || '（无标题）'}`, `网址：${page.url()}`, '', '元素：', list + tail, '', '正文：', body || '（没有正文）'].join('\n');
}

export async function locatorFor(page: Page, store: RefStore, ref: string): Promise<Locator> {
  if (!store.refs.size) throw new Error('还没有页面快照，请先调用 browser_snapshot');
  if (page.url() !== store.refUrl) {
    throw new Error(`编号 ${ref} 已过期，页面已经离开 ${store.refUrl}，请重新 snapshot`);
  }
  const entry = store.refs.get(ref);
  if (!entry) throw new Error(`没有编号 ${ref}，请先 snapshot`);
  const locator = page.locator(entry.selector);
  if ((await locator.count()) === 0) throw new Error(`编号 ${ref} 已过期，请重新 snapshot`);
  return locator.first();
}
