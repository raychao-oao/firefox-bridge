// repo/firefox-bridge-bot/index.js
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { connectBridge } from './lib/bridge.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.join(__dirname, 'scripts');

// Mirrors mcp-server/src/tools.js's toolResult() exactly -- not imported
// across packages, since it's a 6-line pure function and these two MCP
// servers are deliberately independent processes with no shared runtime
// dependency beyond @firefox-bridge/native-host.
function toolResult(result) {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    isError: result.ok === false,
  };
}

async function loadScripts() {
  const files = readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith('.js'));
  const scripts = [];
  for (const file of files) {
    const mod = await import(pathToFileURL(path.join(SCRIPTS_DIR, file)).href);
    scripts.push(mod.default);
  }
  return scripts;
}

async function main() {
  const server = new McpServer({ name: 'firefox-bridge-bot', version: '0.1.0' });

  for (const script of await loadScripts()) {
    server.registerTool(
      script.name,
      { description: script.description, inputSchema: script.inputSchema },
      async (input) => {
        // `bridge` starts undefined and is only assigned once connectBridge()
        // resolves -- if THAT itself fails (bad token, socket refused, auth
        // rejected), the outer catch below must still turn it into the
        // top-level {ok:false, error} contract instead of rejecting the MCP
        // callback directly. The `finally` guards on `bridge` being set,
        // since there is nothing to clean up if connectBridge() never
        // succeeded. (Found by use-codex plan review -- the first draft
        // called connectBridge() before the try, so a connect/auth failure
        // bypassed this contract entirely.)
        let bridge;
        try {
          bridge = await connectBridge();
          const outcome = await script.run(input, bridge);
          if (outcome && outcome.topLevelError) {
            return toolResult({ ok: false, error: outcome.topLevelError });
          }
          return toolResult({ ok: true, ...outcome });
        } catch (err) {
          return toolResult({ ok: false, error: `script_failed: ${err.message}` });
        } finally {
          // Best-effort cleanup sweep, then disconnect -- runs whether the
          // script succeeded, returned a topLevelError, or threw. Skipped
          // entirely if connectBridge() itself never succeeded.
          if (bridge) {
            await bridge.closeAllOpenedTabs();
            bridge.disconnect();
          }
        }
      }
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`firefox-bridge-bot fatal error: ${err.stack}\n`);
  process.exit(1);
});
