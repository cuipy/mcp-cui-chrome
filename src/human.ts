import type { Locator, Page } from 'rebrowser-playwright';

export type Point = { x: number; y: number; synced?: boolean };

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

async function pauseBetween(): Promise<void> {
  await sleep(rand(200, 700));
}

function cubic(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

const readViewport = new Function('return { w: window.innerWidth, h: window.innerHeight };') as () => {
  w: number;
  h: number;
};

async function viewportOf(page: Page): Promise<{ w: number; h: number }> {
  return page.evaluate(readViewport);
}

/** 从上次坐标沿三次贝塞尔曲线走到目标，并记住落点。 */
export async function humanMove(page: Page, pointer: Point, target: Point): Promise<void> {
  const start = { ...pointer };
  const dx = target.x - start.x;
  const dy = target.y - start.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 3) {
    await page.mouse.move(target.x, target.y);
    pointer.x = target.x;
    pointer.y = target.y;
    pointer.synced = true;
    return;
  }
  const spread = Math.min(140, dist * 0.35);
  const control1 = {
    x: start.x + dx * 0.3 + (Math.random() - 0.5) * spread,
    y: start.y + dy * 0.1 + (Math.random() - 0.5) * spread,
  };
  const control2 = {
    x: start.x + dx * 0.7 + (Math.random() - 0.5) * spread,
    y: start.y + dy * 0.9 + (Math.random() - 0.5) * spread,
  };
  const steps = clamp(Math.round(dist / 12), 8, 36);
  for (let i = 1; i <= steps; i += 1) {
    const point = cubic(start, control1, control2, target, i / steps);
    await page.mouse.move(point.x, point.y);
    pointer.x = point.x;
    pointer.y = point.y;
    pointer.synced = true;
    await sleep(rand(4, 16));
  }
}

const readScrollY = new Function('return window.scrollY;') as () => number;

async function ensurePointerOnPage(page: Page, pointer: Point): Promise<void> {
  const view = await viewportOf(page);
  const inside = pointer.synced && pointer.x >= 0 && pointer.y >= 0 && pointer.x <= view.w && pointer.y <= view.h;
  if (!inside) {
    await humanMove(page, pointer, {
      x: clamp(view.w * 0.5, 20, Math.max(20, view.w - 20)),
      y: clamp(view.h * 0.55, 20, Math.max(20, view.h - 20)),
    });
  }
}

export async function humanScrollBy(page: Page, pointer: Point, deltaY: number): Promise<void> {
  if (Math.abs(deltaY) < 1) return;
  await ensurePointerOnPage(page, pointer);
  const sign = Math.sign(deltaY);
  let left = Math.abs(deltaY);
  const steps = 4 + Math.floor(Math.random() * 5);
  for (let i = 0; i < steps && left > 0; i += 1) {
    const portion = i === steps - 1 ? left : Math.max(30, left * rand(0.15, 0.35));
    const chunk = Math.min(left, portion);
    left -= chunk;
    await page.mouse.wheel(0, sign * chunk);
    await sleep(rand(40, 120));
  }
}

async function bringIntoView(
  page: Page,
  pointer: Point,
  locator: Locator,
): Promise<{ x: number; y: number; width: number; height: number }> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const box = await locator.boundingBox();
    if (!box || box.width < 2 || box.height < 2) break;
    const view = await viewportOf(page);
    const margin = 12;
    const visible =
      box.y >= margin &&
      box.x >= 0 &&
      box.y + Math.min(box.height, 40) <= view.h - margin &&
      box.x + Math.min(box.width, 40) <= view.w;
    if (visible) return box;
    const before = await page.evaluate(readScrollY);
    const deltaY = box.y < margin ? box.y - 120 : box.y + Math.min(box.height, 80) - view.h + 120;
    await humanScrollBy(page, pointer, deltaY);
    const after = await page.evaluate(readScrollY);
    if (Math.abs(after - before) < 1) break;
  }
  await locator.scrollIntoViewIfNeeded().catch(() => undefined);
  await sleep(rand(120, 240));
  const box = await locator.boundingBox();
  if (!box || box.width < 2 || box.height < 2) {
    throw new Error('元素不在可见区域，请滚动后重新 snapshot');
  }
  return box;
}

const hitCover = new Function(
  'el',
  'point',
  `
    if (point.x < 0 || point.y < 0 || point.x > window.innerWidth || point.y > window.innerHeight) return '';
    const hit = document.elementFromPoint(point.x, point.y);
    if (!hit || hit === el || el.contains(hit) || hit.contains(el)) return '';
    if (hit.closest && hit.closest('#cui-chrome-bar')) return '';
    const text = (hit.innerText || hit.getAttribute('aria-label') || hit.getAttribute('title') || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
    return text || hit.tagName.toLowerCase();
  `,
) as (el: Element, point: { x: number; y: number }) => string;

function clickPoint(
  box: { x: number; y: number; width: number; height: number },
  view: { w: number; h: number },
): Point {
  const left = Math.max(box.x + 1, 2);
  const right = Math.min(box.x + box.width - 1, view.w - 2);
  const top = Math.max(box.y + 1, 2);
  const bottom = Math.min(box.y + box.height - 1, view.h - 2);
  if (right - left < 2 || bottom - top < 2) {
    throw new Error('元素不在可见区域，请滚动后重新 snapshot');
  }
  return {
    x: left + (right - left) * rand(0.35, 0.65),
    y: top + (bottom - top) * rand(0.35, 0.65),
  };
}

export async function humanClick(
  page: Page,
  pointer: Point,
  locator: Locator,
  button: 'left' | 'right' | 'middle' = 'left',
  pause = true,
): Promise<void> {
  if (pause) await pauseBetween();
  const box = await bringIntoView(page, pointer, locator);
  const view = await viewportOf(page);
  const point = clickPoint(box, view);
  await humanMove(page, pointer, point);
  await sleep(rand(40, 180));
  const covered = await locator.evaluate(hitCover, point);
  if (covered) {
    throw new Error(`点击位置被挡住了：「${covered}」。先关闭这层遮挡或按 Escape，不要点穿过去。`);
  }
  await page.mouse.down({ button });
  await sleep(rand(30, 90));
  await page.mouse.up({ button });
}

export async function humanHover(page: Page, pointer: Point, locator: Locator): Promise<void> {
  await pauseBetween();
  const box = await bringIntoView(page, pointer, locator);
  const view = await viewportOf(page);
  await humanMove(page, pointer, clickPoint(box, view));
}

/** 按下后沿轨迹拖到另一个点，再松开。用于滑块、排序和需要拖拽的控件。 */
export async function humanDrag(page: Page, pointer: Point, locator: Locator, target: Point): Promise<void> {
  await pauseBetween();
  const box = await bringIntoView(page, pointer, locator);
  const view = await viewportOf(page);
  const start = clickPoint(box, view);
  await humanMove(page, pointer, start);
  await sleep(rand(40, 120));
  await page.mouse.down();
  await sleep(rand(40, 110));
  const end = {
    x: clamp(target.x, 2, view.w - 2),
    y: clamp(target.y, 2, view.h - 2),
  };
  await humanMove(page, pointer, end);
  await sleep(rand(40, 120));
  await page.mouse.up();
}

export async function humanType(
  page: Page,
  pointer: Point,
  locator: Locator,
  text: string,
  clear: boolean,
): Promise<void> {
  await pauseBetween();
  await humanClick(page, pointer, locator, 'left', false);
  if (clear) {
    await sleep(rand(40, 120));
    await page.keyboard.press('Control+A');
    await sleep(rand(30, 80));
    await page.keyboard.press('Backspace');
  }
  const scale = text.length > 200 ? 0.45 : 1;
  for (const char of text) {
    await page.keyboard.type(char);
    let delay = rand(40, 140) * scale;
    if (Math.random() < 0.03) delay += rand(200, 500);
    await sleep(delay);
  }
}

export async function humanScroll(
  page: Page,
  pointer: Point,
  direction: 'up' | 'down',
  pixels?: number,
): Promise<void> {
  await pauseBetween();
  const total = pixels ?? Math.round(rand(480, 760));
  const sign = direction === 'up' ? -1 : 1;
  await humanScrollBy(page, pointer, sign * total);
}

export async function humanPress(page: Page, key: string): Promise<void> {
  await pauseBetween();
  await page.keyboard.press(key, { delay: rand(30, 80) });
}
