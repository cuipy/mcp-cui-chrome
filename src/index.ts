process.env.REBROWSER_PATCHES_RUNTIME_FIX_MODE ??= 'addBinding';

const { McpServer } = await import('@modelcontextprotocol/server');
const { serveStdio } = await import('@modelcontextprotocol/server/stdio');
const { registerTools } = await import('./tools.js');
const { session } = await import('./session.js');

function createServer(): InstanceType<typeof McpServer> {
  const server = new McpServer({ name: 'mcp-cui-chrome', version: '0.1.0' });
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
