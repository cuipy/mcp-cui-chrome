#!/usr/bin/env node
process.env.REBROWSER_PATCHES_RUNTIME_FIX_MODE ??= 'addBinding';

const { McpServer } = await import('@modelcontextprotocol/server');
const { serveStdio } = await import('@modelcontextprotocol/server/stdio');
const { registerTools } = await import('./tools.js');
const { session } = await import('./session.js');
const { packageVersion } = await import('./stealth.js');

const INSTRUCTIONS = [
  '这是用户本机上单独的一个 Chrome，窗口左下角有黄色 cui-chrome 标签，不是 IDE 里内置的浏览器。',
  '用户说打开 Chrome、打开网页、访问网站、登录、点击、输入、滚动、看页面或刷新时，用本服务的工具，不要改用其他浏览器工具。',
  '先 browser_navigate 或 browser_snapshot，再按快照里的编号操作。相同地址的标签已经开着就切换过去。',
  '本该有的内容不在快照里时，用 browser_reload 刷新一次再读。快照写了遮挡，或点击报告被挡住，先关掉那一层或按 Escape。',
  '这些工具只做通用的浏览器操作，不要当成某个网站的专用流程。',
].join('');

function createServer(): InstanceType<typeof McpServer> {
  const server = new McpServer({ name: 'mcp-cui-chrome', version: packageVersion() || '0.1.0' }, { instructions: INSTRUCTIONS });
  registerTools(server);
  return server;
}

async function shutdown(): Promise<void> {
  await session.close();
}

process.on('SIGINT', () => {
  void shutdown().finally(() => process.exit(0));
});
process.on('SIGTERM', () => {
  void shutdown().finally(() => process.exit(0));
});

void serveStdio(createServer);
console.error('mcp-cui-chrome MCP server running on stdio');
