import fs from 'node:fs/promises';
import path from 'node:path';
import { profileDir } from './stealth.js';

const WAIT_MS = 120_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function lockFile(): string {
  return path.join(path.dirname(profileDir()), 'action.lock');
}

async function clearIfStale(file: string): Promise<void> {
  try {
    const text = await fs.readFile(file, 'utf8');
    const pid = Number(text.split(/\r?\n/)[0]);
    if (!pidAlive(pid)) await fs.unlink(file);
  } catch {
    /* 锁刚被拿走时读或删都会失败，下一轮再试。 */
  }
}

/** 多个会话共用一个 Chrome 时，同一时间只让一个动作操作鼠标。 */
export async function withBrowserLock<T>(fn: () => Promise<T>): Promise<T> {
  const file = lockFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      const handle = await fs.open(file, 'wx');
      try {
        await handle.writeFile(`${process.pid}\n${Date.now()}\n`);
        return await fn();
      } finally {
        await handle.close();
        await fs.unlink(file).catch(() => undefined);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      await clearIfStale(file);
      if (Date.now() - started > WAIT_MS) {
        throw new Error('另一个会话正在操作这个 Chrome，等待超过 120 秒');
      }
      await sleep(80 + Math.random() * 140);
    }
  }
}
