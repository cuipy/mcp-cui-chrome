import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const child = spawn(process.execPath, ['dist/index.js'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  stdio: ['pipe', 'pipe', 'inherit'],
});

const lines = createInterface({ input: child.stdout });
const buffer = [];
const resolvers = [];
lines.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  const resolve = resolvers.shift();
  if (resolve) resolve(trimmed);
  else buffer.push(trimmed);
});

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function nextLine() {
  const queued = buffer.shift();
  if (queued !== undefined) return Promise.resolve(queued);
  return new Promise((resolve) => resolvers.push(resolve));
}

send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'list-tools', version: '0.0.1' },
  },
});

const init = JSON.parse(await nextLine());
if (init.error) {
  console.error(init.error);
  process.exit(1);
}
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
const listed = JSON.parse(await nextLine());
if (listed.error) {
  console.error(listed.error);
  process.exit(1);
}
const names = listed.result.tools.map((tool) => tool.name);
console.log(names.join('\n'));
child.kill();
process.exit(0);
