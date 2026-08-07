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
    const script = mod.default;
    // Guard against a malformed script silently reaching registerTool() and
    // crashing later with a confusing error -- name the offending file up
    // front instead.
    if (
      !script ||
      typeof script.name !== 'string' ||
      typeof script.run !== 'function'
    ) {
      throw new Error(
        `firefox-bridge-bot/scripts/${file} does not export a valid script (expected default export with name/run)`
      );
    }
    scripts.push(script);
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
        // Measured across the WHOLE call -- connect, script execution, and
        // cleanup -- since that's the latency the caller actually
        // experiences waiting on this tool. Results are assembled into
        // `result` rather than returned directly from each branch, so a
        // single return point at the end can stamp startedAt/finishedAt/
        // durationMs onto every outcome (success, topLevelError, or thrown
        // exception) after cleanup has actually finished running.
        const startedAt = Date.now();

        // `bridge` starts undefined and is only assigned once connectBridge()
        // resolves -- if THAT itself fails (bad token, socket refused, auth
        // rejected), the catch below must still turn it into the
        // top-level {ok:false, error} contract instead of rejecting the MCP
        // callback directly. The `finally` guards on `bridge` being set,
        // since there is nothing to clean up if connectBridge() never
        // succeeded. (Found by use-codex plan review -- the first draft
        // called connectBridge() before the try, so a connect/auth failure
        // bypassed this contract entirely.)
        let bridge;
        let result;
        try {
          bridge = await connectBridge();
          const outcome = await script.run(input, bridge);
          result =
            outcome && 'topLevelError' in outcome
              ? { ok: false, error: outcome.topLevelError }
              : { ...outcome, ok: true };
        } catch (err) {
          result = { ok: false, error: `script_failed: ${err.message}` };
        } finally {
          // Best-effort cleanup sweep, then disconnect -- runs whether the
          // script succeeded, returned a topLevelError, or threw. Skipped
          // entirely if connectBridge() itself never succeeded.
          if (bridge) {
            await bridge.closeAllOpenedTabs();
            bridge.disconnect();
          }
        }

        const finishedAt = Date.now();
        return toolResult({
          ...result,
          startedAt: new Date(startedAt).toISOString(),
          finishedAt: new Date(finishedAt).toISOString(),
          durationMs: finishedAt - startedAt,
        });
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
