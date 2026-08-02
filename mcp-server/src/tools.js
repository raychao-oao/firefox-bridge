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
      description:
        'Click an element in a leased tab, identified by a CSS selector. Pass `frameId` to target a specific frame (get it from `list_frames` or a `list_elements` entry) — defaults to the top frame (0), which does NOT reach into iframes.',
      inputSchema: { tabId: z.number(), selector: z.string(), frameId: z.number().optional() },
    },
    async ({ tabId, selector, frameId }) => {
      const result = await bridgeClient.call({ type: 'click', tabId, selector, frameId });
      return toolResult(result);
    }
  );

  server.registerTool(
    'type',
    {
      description:
        'Type text into an element in a leased tab, identified by a CSS selector. Pass `frameId` to target a specific frame (get it from `list_frames` or a `list_elements` entry) — defaults to the top frame (0), which does NOT reach into iframes.',
      inputSchema: { tabId: z.number(), selector: z.string(), text: z.string(), frameId: z.number().optional() },
    },
    async ({ tabId, selector, text, frameId }) => {
      const result = await bridgeClient.call({ type: 'type', tabId, selector, text, frameId });
      return toolResult(result);
    }
  );

  server.registerTool(
    'read_page',
    {
      description:
        "Read the visible text content of a leased tab's page. Pass `frameId` (from `list_frames`) to read one specific frame. Omit it to read every frame at once — the response is then `{ok, frames: [{frameId, parentFrameId, url, text, ...}], frameErrors: [...]}` grouped per frame, NOT a single merged string, since a page's iframes are separate documents (e.g. a settings panel that renders inside an iframe won't show up unless you read its frame).",
      inputSchema: { tabId: z.number(), frameId: z.number().optional() },
    },
    async ({ tabId, frameId }) => {
      const result = await bridgeClient.call({ type: 'read_page', tabId, frameId });
      return toolResult(result);
    }
  );

  server.registerTool(
    'list_elements',
    {
      description:
        "List interactive elements (links, buttons, inputs, selects, textareas, ARIA button/link/menuitem/tab roles) currently visible in a leased tab. Each entry includes a `selector` and `frameId` you can pass directly to `click`/`type` — guaranteed to target exactly the inspected element, no guessing required. Capped at 300 elements per frame; `truncated: true` on a frame's entry means some were dropped there. Pass `frameId` (from `list_frames`) to scan one specific frame. Omit it to scan every frame at once — the response is then `{ok, frames: [{frameId, parentFrameId, url, elements, ...}], frameErrors: [...]}` grouped per frame, so you can tell a page's real content frame apart from an unrelated ad/tracking iframe instead of everything being interleaved.",
      inputSchema: { tabId: z.number(), frameId: z.number().optional() },
    },
    async ({ tabId, frameId }) => {
      const result = await bridgeClient.call({ type: 'list_elements', tabId, frameId });
      return toolResult(result);
    }
  );

  server.registerTool(
    'list_frames',
    {
      description:
        "List every frame (top frame plus all iframes) in a leased tab: `{frameId, parentFrameId, url}` each. frameId 0 is always the top frame. Use this to find the frameId of an iframe whose content `read_page`/`list_elements`/`click`/`type` should target — most pages have only frame 0, but some (e.g. a settings panel or embedded widget) render their real content inside an iframe.",
      inputSchema: { tabId: z.number() },
    },
    async ({ tabId }) => {
      const result = await bridgeClient.call({ type: 'list_frames', tabId });
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

  server.registerTool(
    'search_history',
    {
      description:
        "Search the user's Firefox browsing history by keyword (matches against page URL and title). Searches the last year and returns at most 30 results (url, title, visitCount, lastVisitTime per entry), most relevant/recent first. This does NOT filter out blacklisted sites from results — history search is read-only and unrelated to the tab-based policy gate that other tools use.",
      inputSchema: { query: z.string() },
    },
    async ({ query }) => {
      const result = await bridgeClient.call({ type: 'search_history', query });
      return toolResult(result);
    }
  );

  server.registerTool(
    'add_bookmark',
    {
      description:
        'Add a Firefox bookmark. `folder` supports multi-level paths (e.g. "Tech/AI") — case/whitespace-insensitive segment matching, missing segments are created automatically. By default folders are resolved under Other Bookmarks; start `folder` with "Bookmarks Toolbar", "Bookmarks Menu", or "Mobile Bookmarks" (case-insensitive) to target those roots instead (e.g. folder: "Bookmarks Toolbar/Reading" creates/finds a "Reading" folder directly under the Bookmarks Toolbar). Before choosing a folder, prefer calling `list_bookmarks` first and reusing an existing folder that already fits, rather than creating a near-duplicate with a slightly different name (e.g. "Read Later" vs "稍後閱讀" vs "Reading List"). Write a concise, human-scannable `title` — do not copy the page\'s raw <title> verbatim (site-name suffixes and taglines make for a bad bookmark list). For private/LAN addresses (192.168.x.x, 10.x.x.x, localhost, etc.), the same URL can point at a different physical device at different times — `title` MUST identify which one (e.g. "Netgear router — home", not just "Router Login"). Deduplicates by exact URL match (skipped for private/LAN addresses, where the same URL can legitimately be a different device) — if a duplicate exists, no new bookmark is created and the response reports `duplicate: true` with the existing entry\'s real location.',
      inputSchema: { url: z.string(), title: z.string(), folder: z.string().optional() },
    },
    async ({ url, title, folder }) => {
      const result = await bridgeClient.call({ type: 'add_bookmark', url, title, folder });
      return toolResult(result);
    }
  );

  server.registerTool(
    'list_bookmarks',
    {
      description:
        'List Firefox bookmarks. Omit `folder` to list every bookmark, flattened across all four bookmark roots (Bookmarks Toolbar, Bookmarks Menu, Other Bookmarks, Mobile Bookmarks). Pass `folder` (supports multi-level paths like "Tech/AI", case/whitespace-insensitive; prefix with "Bookmarks Toolbar", "Bookmarks Menu", or "Mobile Bookmarks" to target those roots instead of the default Other Bookmarks) to list only that folder\'s direct bookmarks — does not include nested sub-folder content. Returns an empty list if the folder doesn\'t exist, not an error. Bookmarks in a non-default root have their `folder` value prefixed with that root\'s label (e.g. "Bookmarks Toolbar/Reading"). Results are capped at 1000 entries; the response includes `truncated: true` if the cap was hit.',
      inputSchema: { folder: z.string().optional() },
    },
    async ({ folder }) => {
      const result = await bridgeClient.call({ type: 'list_bookmarks', folder });
      return toolResult(result);
    }
  );

  server.registerTool(
    'search_bookmarks',
    {
      description:
        'Search Firefox bookmarks by keyword — matches against both URL and title, across all four bookmark roots (Bookmarks Toolbar, Bookmarks Menu, Other Bookmarks, Mobile Bookmarks). Bookmarks in a non-default root have their `folder` value prefixed with that root\'s label (e.g. "Bookmarks Toolbar/Reading"). Results are capped at 1000 entries; the response includes `truncated: true` if the cap was hit.',
      inputSchema: { query: z.string() },
    },
    async ({ query }) => {
      const result = await bridgeClient.call({ type: 'search_bookmarks', query });
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
