process.env.REBROWSER_PATCHES_RUNTIME_FIX_MODE ??= 'addBinding';

const { session } = await import('../src/session.js');
const { humanClick } = await import('../src/human.js');
const { locatorFor, takeSnapshot } = await import('../src/snapshot.js');

async function main(): Promise<void> {
  const page = await session.ensure();
  await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  const before = await takeSnapshot(page, session);
  console.log(before);
  const link = [...session.refs.entries()].find(([, entry]) => entry.role === 'link');
  if (!link) throw new Error('example.com 上没有找到链接');
  const [ref] = link;
  console.log(`点击 ${ref}`);
  const locator = await locatorFor(page, session, ref);
  await humanClick(page, session.pointer, locator);
  await page.waitForURL(/iana\.org/, { timeout: 20000 });
  console.log('点击后网址：', page.url());
  if (!page.url().includes('iana.org')) {
    throw new Error(`点击后网址不符合预期：${page.url()}`);
  }

  try {
    await page.goto('https://bot.sannysoft.com', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2500);
    const probe = await page.evaluate(
      new Function(`
        const webdriver = navigator.webdriver;
        const rows = [...document.querySelectorAll('tr')]
          .slice(0, 15)
          .map((row) => (row.innerText || '').replace(/\\s+/g, ' ').trim())
          .filter(Boolean);
        return { webdriver, rows };
      `) as () => { webdriver: boolean; rows: string[] },
    );
    console.log('navigator.webdriver =', probe.webdriver);
    console.log(probe.rows.join('\n'));
    if (probe.webdriver) throw new Error('navigator.webdriver 仍为真');
  } catch (error) {
    if (error instanceof Error && error.message.includes('webdriver')) throw error;
    console.error('检测页没有打开，点击流程本身已经通过。', error instanceof Error ? error.message : error);
  }
  await session.close();
}

main().catch(async (error: unknown) => {
  console.error(error);
  await session.close();
  process.exit(1);
});
