// repo/mcp-server/src/index.js
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { bridgeDir } from '@firefox-bridge/native-host/src/bridge-dir.js';
import { BridgeClient } from './bridge-client.js';
import { registerTools } from './tools.js';

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
