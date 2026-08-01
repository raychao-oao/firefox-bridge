// repo/mcp-server/src/index.js
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import path from 'node:path';
import os from 'node:os';
import { BridgeClient } from './bridge-client.js';
import { registerTools } from './tools.js';

function bridgeDir() {
  const base = process.env.XDG_RUNTIME_DIR || os.homedir();
  return process.env.XDG_RUNTIME_DIR
    ? path.join(base, 'firefox-bridge')
    : path.join(base, '.firefox-bridge');
}

async function main() {
  const bridgeClient = new BridgeClient({ socketDir: bridgeDir() });
  await bridgeClient.connect();

  const server = new McpServer({ name: 'firefox-bridge', version: '0.1.0' });
  registerTools(server, bridgeClient);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`mcp-server fatal error: ${err.stack}\n`);
  process.exit(1);
});
