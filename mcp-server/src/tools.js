// repo/mcp-server/src/tools.js
import { z } from 'zod';

export function registerTools(server, bridgeClient) {
  server.registerTool(
    'navigate',
    {
      description: "Navigate a leased Firefox tab to a URL. Blocked (with a structured error) if the URL hits the blacklist and the user has not confirmed.",
      inputSchema: { tabId: z.number(), url: z.string() },
    },
    async ({ tabId, url }) => {
      const result = await bridgeClient.call({ type: 'navigate', tabId, url });
      return toolResult(result);
    }
  );

  server.registerTool(
    'click',
    {
      description: 'Click an element in a leased tab, identified by a CSS selector.',
      inputSchema: { tabId: z.number(), selector: z.string() },
    },
    async ({ tabId, selector }) => {
      const result = await bridgeClient.call({ type: 'click', tabId, selector });
      return toolResult(result);
    }
  );

  server.registerTool(
    'type',
    {
      description: 'Type text into an element in a leased tab, identified by a CSS selector.',
      inputSchema: { tabId: z.number(), selector: z.string(), text: z.string() },
    },
    async ({ tabId, selector, text }) => {
      const result = await bridgeClient.call({ type: 'type', tabId, selector, text });
      return toolResult(result);
    }
  );

  server.registerTool(
    'read_page',
    {
      description: "Read the visible text content of a leased tab's page.",
      inputSchema: { tabId: z.number() },
    },
    async ({ tabId }) => {
      const result = await bridgeClient.call({ type: 'read_page', tabId });
      return toolResult(result);
    }
  );

  server.registerTool(
    'list_elements',
    {
      description:
        "List interactive elements (links, buttons, inputs, selects, textareas, ARIA button/link/menuitem/tab roles) currently visible in a leased tab. Each entry includes a `selector` you can pass directly to `click`/`type` — it targets exactly the inspected element, no guessing required. Capped at 300 elements per call; `truncated: true` means some were dropped.",
      inputSchema: { tabId: z.number() },
    },
    async ({ tabId }) => {
      const result = await bridgeClient.call({ type: 'list_elements', tabId });
      return toolResult(result);
    }
  );

  server.registerTool(
    'screenshot',
    {
      description: 'Capture a screenshot of a leased tab. Returns PNG bytes (base64) fetched via the payload-handle path.',
      inputSchema: { tabId: z.number() },
    },
    async ({ tabId }) => {
      const captureResult = await bridgeClient.call({ type: 'screenshot', tabId });
      if (!captureResult.ok) return toolResult(captureResult);
      const payload = await bridgeClient.call({ type: 'payload-read', handle: captureResult.handle });
      return toolResult(payload);
    }
  );

  server.registerTool(
    'get_console',
    {
      description: 'Get console messages captured since console monitoring was started for this tab (start_console must be called first, otherwise this returns not_subscribed). Only the most recent 500 messages are retained.',
      inputSchema: { tabId: z.number() },
    },
    async ({ tabId }) => {
      const result = await bridgeClient.call({ type: 'get_console', tabId });
      return toolResult(result);
    }
  );

  server.registerTool(
    'start_console',
    {
      description: 'Start capturing console.* calls in a leased tab (page-world injection). Only messages logged after this call are captured.',
      inputSchema: { tabId: z.number() },
    },
    async ({ tabId }) => {
      const result = await bridgeClient.call({ type: 'start_console', tabId });
      return toolResult(result);
    }
  );

  server.registerTool(
    'start_network',
    {
      description: 'Start capturing webRequest-level network activity for a leased tab. Must be called before get_network — call it BEFORE navigating if you want to observe the page load.',
      inputSchema: { tabId: z.number() },
    },
    async ({ tabId }) => {
      const result = await bridgeClient.call({ type: 'start_network', tabId });
      return toolResult(result);
    }
  );

  server.registerTool(
    'get_network',
    {
      description: 'Get webRequest-level network activity observed for a leased tab since start_network was called (URL, method, status, timing — not full response bodies). Returns not_subscribed if start_network was never called. Only the most recent 500 requests are retained.',
      inputSchema: { tabId: z.number() },
    },
    async ({ tabId }) => {
      const result = await bridgeClient.call({ type: 'get_network', tabId });
      return toolResult(result);
    }
  );

  server.registerTool(
    'acquire_tab',
    {
      description: 'Lease a new or existing Firefox tab for this session. Pass a url to open a new tab, or a tabId to lease an existing one.',
      inputSchema: { url: z.string().optional(), tabId: z.number().optional() },
    },
    async ({ url, tabId }) => {
      const result = await bridgeClient.call({ type: 'acquire_tab', url, tabId });
      return toolResult(result);
    }
  );

  server.registerTool(
    'release_tab',
    {
      description: 'Release the lease on a tab this session previously acquired.',
      inputSchema: { tabId: z.number() },
    },
    async ({ tabId }) => {
      const result = await bridgeClient.call({ type: 'release_tab', tabId });
      return toolResult(result);
    }
  );

  server.registerTool(
    'list_tabs',
    {
      description: 'List all open Firefox tabs (id, url, title) and which are currently leased.',
      inputSchema: {},
    },
    async () => {
      const result = await bridgeClient.call({ type: 'list_tabs' });
      return toolResult(result);
    }
  );
}

function toolResult(result) {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    isError: result.ok === false,
  };
}
