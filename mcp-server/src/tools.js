// repo/mcp-server/src/tools.js
import { z } from 'zod';
import { mkdir, writeFile, rename, unlink, stat, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

const SCREENSHOT_DIR = path.resolve(os.tmpdir(), 'firefox-bridge-screenshots');

// Raw-file-size fast-check, before even reading the file into memory.
const MAX_UPLOAD_FILE_BYTES = 700 * 1024;
// The REAL guarantee: measured against the actual encoded outbound message
// (JSON + base64, not just the raw file), leaving 4 KiB of headroom under
// native-host's MAX_MESSAGE_BYTES (1 MiB) for the native-messaging header
// and the message's other fields (selector, fileName, etc). Checking only
// the raw file size against MAX_UPLOAD_FILE_BYTES is a fast pre-check, not
// a mathematical guarantee -- base64 inflates by ~4/3, and an unusually long
// selector/fileName could still push an otherwise-under-the-cap file over
// the real limit. Found by use-codex spec review.
const MAX_ENCODED_UPLOAD_MESSAGE_BYTES = 1024 * 1024 - 4096;

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
        "Click an element in a leased tab, identified by a CSS selector. Pass `frameId` to target a specific frame (get it from `list_frames` or a `list_elements` entry) — defaults to the top frame (0). If you omit `frameId` AND the element is not found in the top frame, this tool automatically falls back to searching up to 19 other accessible frames for the first one where the selector resolves — you do NOT need to pass `frameId` just because an element came from an iframe. `ok: true` only means the click event was dispatched, NOT that its expected effect happened — check the response fields: `navigated` (tab URL changed by the time this returned — a navigation that started but had not yet updated the tab URL will read as false), `dialogOpened` (the frame whose click was attempted did not hear back within a budget that adapts to whether the tab is actually visible — ~600ms when the tab is both the active tab in its window AND that window is OS-focused, ~3000ms otherwise (background tab, or a focused-but-backgrounded window such as when Firefox itself isn't the focused application), since Firefox throttles a non-visible tab's own timers to a ~1000ms minimum interval and this tool's own effect-detection window would otherwise misfire on nearly every click to a tab you aren't actively looking at — a native confirm()/alert() blocking the page is the most likely cause of a genuine timeout, but a slow click handler, a debugger breakpoint, or content-script injection latency before any click was actually dispatched can still look identical; this is a best-effort heuristic, not proof a click occurred, and this tool cannot read or dismiss a dialog either way), `domChanged` (a coarse, best-effort signal that SOMETHING in the DOM changed, not a precise diff), `newUrl` (present only when `navigated` is true), and `frameSearchIncomplete` (present and `true` only alongside an ultimately unsuccessful result — `element_not_found` or `stale_selector` — when the omitted-`frameId` frame search could NOT be exhaustive: a frame was policy-blocked, the 20-frame search cap was hit, or frame enumeration itself failed. Never present alongside a successful click, even if an earlier frame in the search was skipped — it means \"this failure doesn't prove the element isn't on the page,\" not \"the element is somewhere unsearched\"). For a real change that may take longer than an instant, follow up with `wait_for`. Optionally pass `expectedDomEpoch` (from a prior `list_elements` call, same `frameId`) to guard against acting on a stale selector — if the page has since changed (navigation, bfcache restoration), this returns `stale_selector` and does NOT click anything, instead of clicking whatever now happens to match the old selector.",
      inputSchema: { tabId: z.number(), selector: z.string(), frameId: z.number().optional(), expectedDomEpoch: z.string().optional() },
    },
    async ({ tabId, selector, frameId, expectedDomEpoch }) => {
      const result = await bridgeClient.call({ type: 'click', tabId, selector, frameId, expectedDomEpoch });
      return toolResult(result);
    }
  );

  server.registerTool(
    'wait_for',
    {
      description:
        "Wait in a leased tab for a condition: `selector` appears, `textGone` disappears from the page, or `networkIdle` (no new requests for a beat). Exactly one of selector/textGone/networkIdle must be set. Returns immediately once matched, or after `timeoutMs` (default 5000) with timedOut: true -- this never throws on timeout.",
      inputSchema: {
        tabId: z.number(),
        selector: z.string().optional(),
        textGone: z.string().optional(),
        networkIdle: z.boolean().optional(),
        timeoutMs: z.number().optional(),
        frameId: z.number().optional(),
      },
    },
    async ({ tabId, selector, textGone, networkIdle, timeoutMs, frameId }) => {
      const result = await bridgeClient.call({ type: 'wait_for', tabId, selector, textGone, networkIdle, timeoutMs, frameId });
      return toolResult(result);
    }
  );

  server.registerTool(
    'type',
    {
      description:
        "Type text into an element in a leased tab, identified by a CSS selector. This ALWAYS overwrites the element's existing value with `text` — there is no append/insert-at-cursor mode, whatever was there before is replaced. Pass `frameId` to target a specific frame (get it from `list_frames` or a `list_elements` entry) — defaults to the top frame (0). If you omit `frameId` AND the element is not found in the top frame, this tool automatically falls back to searching up to 19 other accessible frames for the first one where the selector resolves — you do NOT need to pass `frameId` just because an element came from an iframe. The response includes `frameSearchIncomplete: true` only alongside an ultimately unsuccessful result (`element_not_found`/`stale_selector`) when that omitted-`frameId` search could NOT be exhaustive (a frame was policy-blocked, the 20-frame cap was hit, or frame enumeration failed) — never alongside a successful type. Optionally pass `expectedDomEpoch` (from a prior `list_elements` call, same `frameId`) to guard against acting on a stale selector — if the page has since changed (navigation, bfcache restoration), this returns `stale_selector` and does NOT type anything.",
      inputSchema: { tabId: z.number(), selector: z.string(), text: z.string(), frameId: z.number().optional(), expectedDomEpoch: z.string().optional() },
    },
    async ({ tabId, selector, text, frameId, expectedDomEpoch }) => {
      const result = await bridgeClient.call({ type: 'type', tabId, selector, text, frameId, expectedDomEpoch });
      return toolResult(result);
    }
  );

  server.registerTool(
    'hover',
    {
      description:
        "Dispatch pointerover/mouseover, pointerenter/mouseenter, and pointermove/mousemove events on an element in a leased tab, identified by a CSS selector -- useful for triggering JS-driven dropdown/tooltip components. Pass `frameId` to target a specific frame; omit it for the same frame-fallback search as `click`/`type`. IMPORTANT: this does NOT set the CSS `:hover` pseudo-class -- that's determined by the browser's internal pointer hit-testing based on the REAL cursor position, which this tool (and this whole project, by design) never moves. A component whose hover behavior is pure CSS (`:hover { display: block }`) will NOT respond to this tool; only components with JS listeners bound to the dispatched event types will. Returns `element_not_found` if the selector is valid but matches nothing, `invalid_selector` if the selector itself has a CSS syntax error.",
      inputSchema: { tabId: z.number(), selector: z.string(), frameId: z.number().optional() },
    },
    async ({ tabId, selector, frameId }) => {
      const result = await bridgeClient.call({ type: 'hover', tabId, selector, frameId });
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
    'read_article',
    {
      description:
        "Extract clean article content from a leased tab's page using Firefox's own " +
        "Reader View engine (Mozilla's Readability.js) -- strips nav/ads/sidebars, " +
        "returning just the article. Unlike `read_page`, this always targets a single " +
        "frame (`frameId` defaults to 0, the top frame, when omitted -- it does NOT scan " +
        "every frame). Returns `{ok, title, byline, siteName, excerpt, text, truncated, " +
        "totalLength}` on success. `text` is plain text (not HTML), truncated at the same " +
        "500,000-char cap `read_page` uses. Returns `{ok: false, error: 'not_an_article'}` " +
        "when the page isn't article-shaped (SPA shell, product listing, etc.) -- this is " +
        "a normal outcome, not a failure to retry. A page that hasn't finished loading " +
        "(slow SPA, paywall) can also produce a false `not_an_article` -- use `wait_for` " +
        "first if that's suspected. Content rendered inside a Shadow DOM is invisible to " +
        "this tool and will also surface as `not_an_article` -- this is structural (the " +
        "extraction never sees shadow trees) and `wait_for` will not help. Returns " +
        "`{ok: false, error: 'readability_inject_failed: ...'}` when the extraction " +
        "engine can't be injected into the page, e.g. a restricted/privileged page like " +
        "`about:*` or an extension store page -- this doesn't mean the tab is missing, " +
        "just that injection was blocked.",
      inputSchema: { tabId: z.number(), frameId: z.number().optional() },
    },
    async ({ tabId, frameId }) => {
      const result = await bridgeClient.call({ type: 'read_article', tabId, frameId });
      return toolResult(result);
    }
  );

  server.registerTool(
    'list_elements',
    {
      description:
        "List interactive elements (links, buttons, inputs, selects, textareas, ARIA button/link/menuitem/tab roles, table rows/header cells) currently visible in a leased tab. `<tr>`/`<th>` are included as scroll/reference targets (e.g. for `scroll_to`) even though a bare table row usually isn't clickable itself. Each entry includes a `selector` and `frameId` you can pass directly to `click`/`type` — guaranteed to target exactly the inspected element, no guessing required. Capped at 300 elements per frame; `truncated: true` on a frame's entry means some were dropped there. Pass `frameId` (from `list_frames`) to scan one specific frame — response is flat: `{ok, elements, totalCandidates, truncated, domEpoch}`. Omit `frameId` to scan every frame at once — the response is then `{ok, frames: [{frameId, parentFrameId, url, elements, totalCandidates, truncated, domEpoch, ...}], frameErrors: [...]}` grouped per frame, so you can tell a page's real content frame apart from an unrelated ad/tracking iframe instead of everything being interleaved; each frame carries its own `domEpoch`, there is no single top-level value when `frameId` is omitted. Each element also carries a `state` object (always present, `{}` if nothing applies) so you can read current form-control state without a screenshot: `checked` (checkbox/radio only), `value` (input/textarea/select, but NEVER for password/hidden/file inputs — that key is deliberately absent for those, not an empty string), `disabled`/`readonly` (booleans, only on applicable control types), `ariaExpanded`/`ariaChecked` (raw ARIA attribute strings, e.g. `\"true\"`/`\"false\"`/`\"mixed\"` — not coerced to boolean, only present when the attribute exists on the element). Pass `filter` to narrow the result set: `container` (a CSS selector — only scans descendants of the first matching element; this is the only field that actually reduces scan work, since it limits the underlying DOM query and the heuristic cursor:pointer walk, which is capped at 3000 candidates before filtering) — an invalid `container` selector returns `invalid_container_selector` (as the call's top-level `error` when you pass an explicit `frameId`; inside that frame's `frameErrors[]` entry when you don't, with the overall call still `ok: true`), a valid-but-unmatched `container` returns a normal empty result (`{ok:true, elements: []}` with `frameId`; `{ok:true, frames:[{..., elements: [], totalCandidates: 0}]}` without it). `text` (case-insensitive substring match against the full element label), `tag` (case-insensitive exact tag match), and `type` (case-insensitive exact `type` attribute match) instead filter the already-gathered candidate array — they narrow the response, not the scan cost. When `filter` is used, `totalCandidates` reflects the already-filtered candidate count, not the whole page/frame's total interactive-element count. In aggregate (no-`frameId`) mode, `filter.container` is resolved independently per frame, so a generic selector can match something in an unrelated iframe — read results as frame-local matches, not page-wide. Filtering narrows the candidate set BEFORE the 300-element cap, so a filtered-for element on a large page won't be dropped by the cap. `domEpoch` changes on real navigation and on bfcache restoration (but NOT on same-page SPA route changes), for use with `click`/`type`'s `expectedDomEpoch` parameter to detect a stale cached selector.",
      inputSchema: {
        tabId: z.number(),
        frameId: z.number().optional(),
        filter: z.object({
          text: z.string().optional(),
          tag: z.string().optional(),
          type: z.string().optional(),
          container: z.string().optional(),
        }).optional(),
      },
    },
    async ({ tabId, frameId, filter }) => {
      const result = await bridgeClient.call({ type: 'list_elements', tabId, frameId, filter });
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
    'scroll_to',
    {
      description:
        "Scroll an element into view within a leased tab, identified by a CSS selector -- useful before `screenshot`/`click` when the target is currently outside the visible viewport. Always targets exactly one frame (no cross-frame fallback search, unlike `click`/`type`): pass `frameId` (from `list_frames` or a `list_elements` entry) to target a specific frame, defaults to the top frame (0). Uses `block: 'center'` so the element lands away from likely sticky headers/footers, and scrolls instantly (no animation delay, matching this project's other operations). Returns `element_not_found` if the selector is syntactically valid but matches nothing in the target frame, or `invalid_selector` if the selector itself has a CSS syntax error.",
      inputSchema: { tabId: z.number(), selector: z.string(), frameId: z.number().optional() },
    },
    async ({ tabId, selector, frameId }) => {
      const result = await bridgeClient.call({ type: 'scroll_to', tabId, selector, frameId });
      return toolResult(result);
    }
  );

  server.registerTool(
    'drag_and_drop',
    {
      description:
        "Simulate a drag-and-drop from one element to another in a leased tab, identified by CSS selectors, via the native HTML5 Drag and Drop event sequence (dragstart/dragenter/dragover/drop/dragend). Single frame only (no cross-frame fallback search, unlike click/type) -- pass `frameId` to target a specific frame, defaults to the top frame (0). IMPORTANT: this only works for elements using the browser's NATIVE HTML5 Drag and Drop API (draggable=\"true\" + dragstart/dragover/drop listeners). Many modern UI libraries (especially ones supporting touch) implement drag-and-drop with mousedown/mousemove/mouseup instead, and those will NOT respond to this tool at all -- the response's `dragoverAccepted`/`dropHandled` booleans tell you whether anything actually handled the dispatched events (per the DnD spec, a valid drop target must call preventDefault() on dragover to accept the drop): both false means the events were dispatched but nothing responded, which usually means the target isn't using native DnD, not that this tool failed. All dispatched events are untrusted synthetic events (`isTrusted: false`) -- no real Gecko drag session is created, so behavior that depends on the browser's native drag session (drag images, OS-level drop targets outside the page) will not occur. Returns `source_not_found`/`target_not_found` if a selector is valid but matches nothing, `invalid_source_selector`/`invalid_target_selector` on a CSS syntax error.",
      inputSchema: {
        tabId: z.number(),
        sourceSelector: z.string(),
        targetSelector: z.string(),
        frameId: z.number().optional(),
      },
    },
    async ({ tabId, sourceSelector, targetSelector, frameId }) => {
      const result = await bridgeClient.call({ type: 'drag_and_drop', tabId, sourceSelector, targetSelector, frameId });
      return toolResult(result);
    }
  );

  server.registerTool(
    'press_key',
    {
      description:
        "Dispatch a single key-press sequence (keydown, then keyup, with keypress in between for single-character keys) in a leased tab. `key` follows DOM KeyboardEvent.key naming (\"Escape\", \"Enter\", \"Tab\", \"ArrowDown\", or a single character). Pass `selector` to target a specific element (frame-fallback search applies when `frameId` is omitted, same as `click`/`type`); omit `selector` to target whatever currently has focus in the frame (`frameId` defaults to 0, no fallback search in this case -- there's no way to know which frame should have focus). Optional `modifiers: {shift?, ctrl?, alt?, meta?}`. IMPORTANT: this dispatches an untrusted synthetic event -- Firefox does NOT run native keyboard default actions for it, so Enter will NOT trigger a form's native submission and Escape will NOT dismiss a native alert()/confirm() dialog (this tool cannot interact with native browser dialogs at all). It DOES fire any JS keydown/keyup listeners the page has bound, which covers most modern SPA keyboard shortcuts and custom (non-native) dialogs that close on Escape via their own JS. This is not a substitute for `type` -- it does not dispatch input/beforeinput, so a printable `key` will not make text appear in a field. `code`/`keyCode`/`which` are populated on a best-effort basis (common control keys like Enter/Escape/Tab/arrows/Space, plus single letters and digits) to support pages that branch on the legacy fields instead of `key` -- not exhaustive, other keys keep the browser's zeroed/empty defaults for those fields.",
      inputSchema: {
        tabId: z.number(),
        key: z.string(),
        selector: z.string().optional(),
        frameId: z.number().optional(),
        modifiers: z.object({
          shift: z.boolean().optional(),
          ctrl: z.boolean().optional(),
          alt: z.boolean().optional(),
          meta: z.boolean().optional(),
        }).optional(),
      },
    },
    async ({ tabId, key, selector, frameId, modifiers }) => {
      const result = await bridgeClient.call({ type: 'press_key', tabId, key, selector, frameId, modifiers });
      return toolResult(result);
    }
  );

  server.registerTool(
    'screenshot',
    {
      description: 'Capture a screenshot of a leased tab. Writes the PNG to a local file and returns its absolute path -- read the file directly (e.g. with a file-reading tool that supports images) rather than expecting image bytes in this response. Pass `fullPage: true` to capture the entire scrollable page instead of just the current viewport -- Firefox captures the full document area directly (best-effort; no scrolling or multi-shot stitching involved, and forced to 1x scale regardless of display DPI so the size check below stays accurate). Known limitation shared with `list_elements`: a fullPage capture only shows content the browser has actually rendered into the DOM -- virtualized/windowed UIs that only mount their visible rows will not "fill in" the rest. Fails with `screenshot_too_large` if either page dimension exceeds Firefox\'s ~32767px single-capture ceiling.',
      inputSchema: { tabId: z.number(), fullPage: z.boolean().optional() },
    },
    async ({ tabId, fullPage }) => {
      const captureResult = await bridgeClient.call({ type: 'screenshot', tabId, fullPage });
      if (!captureResult.ok) return toolResult(captureResult);
      const payload = await bridgeClient.call({ type: 'payload-read', handle: captureResult.handle });
      if (!payload.ok) return toolResult(payload);

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const id = randomUUID();
      const filePath = path.join(SCREENSHOT_DIR, `screenshot-${timestamp}-${id}.png`);
      const tmpPath = `${filePath}.tmp`;
      try {
        await mkdir(SCREENSHOT_DIR, { recursive: true, mode: 0o700 });
        const bytes = Buffer.from(payload.dataBase64, 'base64');
        // Write to a temp path first, then rename -- rename is atomic on the
        // same filesystem (SCREENSHOT_DIR and its .tmp sibling always are),
        // so a caller can never observe a partially-written PNG even if the
        // write itself fails partway through.
        await writeFile(tmpPath, bytes, { mode: 0o600 });
        await rename(tmpPath, filePath);
      } catch (err) {
        await unlink(tmpPath).catch(() => {}); // best-effort cleanup of a failed temp write
        return toolResult({ ok: false, error: `screenshot_file_write_failed: ${err.message}` });
      }
      return toolResult({ ok: true, path: filePath });
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
      description:
        'Lease a new or existing Firefox tab for this session. Pass a url to open a new tab, or a tabId to lease an existing one. Pass `cookieStoreId` (from `list_containers`/`create_container`) to open the new tab inside that container — only valid when opening a NEW tab (no `tabId`); combining `tabId` with `cookieStoreId` returns `cookie_store_requires_new_tab`, since an existing tab\'s container was fixed when it was created and cannot be changed. An unrecognized `cookieStoreId` (including Firefox\'s reserved, non-container stores) returns `container_not_found`. The response always includes `cookieStoreId` for the tab you got, whether or not you passed one — a normal (non-container) tab reports Firefox\'s default store id. When opening a new tab with a real `url` (not omitted, not `about:blank`), this tool waits up to 3s for the navigation to commit (not for the page to finish loading) before responding, so `url` reflects the currently observed committed URL rather than a stale `about:blank` — but that\'s still not guaranteed to equal what you passed, since a server-side redirect can commit to a different address, and the 3s bound is on the navigation wait itself, not on this tool\'s total latency (an unusually slow tab creation adds on top). If the wait times out, the response includes `urlPending: true` and `url` may still be stale; follow up with `wait_for` or `read_page` if you need certainty.',
      inputSchema: { url: z.string().optional(), tabId: z.number().optional(), cookieStoreId: z.string().optional() },
    },
    async ({ url, tabId, cookieStoreId }) => {
      const result = await bridgeClient.call({ type: 'acquire_tab', url, tabId, cookieStoreId });
      return toolResult(result);
    }
  );

  server.registerTool(
    'open_private_window',
    {
      description:
        'Open a new Firefox private browsing window and lease its initial tab to this session (like acquire_tab -- no separate acquire_tab call needed). Pass url to navigate there immediately; omitted or "about:blank" opens a blank private tab. Requires the extension\'s "Run in Private Windows" toggle to be enabled by the user in about:addons -- Firefox gives extensions no API to enable this themselves, and without it this call fails outright with private_window_access_denied (no window is created). Subject to the same URL blacklist confirmation flow as acquire_tab/navigate (blacklisted_denied on decline).',
      inputSchema: { url: z.string().optional() },
    },
    async ({ url }) => {
      const result = await bridgeClient.call({ type: 'open_private_window', url });
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
    'close_tab',
    {
      description:
        'Close a tab this session currently has leased. Closing the last remaining tab in a window closes the window. The lease and any active console/network capture on this tab are cleared automatically.',
      inputSchema: { tabId: z.number() },
    },
    async ({ tabId }) => {
      const result = await bridgeClient.call({ type: 'close_tab', tabId });
      return toolResult(result);
    }
  );

  server.registerTool(
    'discard_tab',
    {
      description:
        'Unload one or more background tabs from memory (browser.tabs.discard) to free resources. The tab and its history are preserved; Firefox reloads it automatically next time it is focused. Does not require acquire_tab first -- succeeds on any tab not currently leased by a different session, and is idempotent (already-discarded tab reports ok: true, no error). Firefox refuses to discard the window\'s active tab (cannot_discard_active_tab). cannot_discard_tab means the tab was still loaded when checked afterward and was not active -- most likely a page blocking unload (e.g. a beforeunload prompt), though a rare race can also produce this for a discard that briefly succeeded before the tab was reactivated. Returns a per-tabId result so partial batches (some succeed, some fail) are fully reported -- the top-level ok is always true if the call reached the extension; check results[].ok per tab. Discarding a tab you have start_console running on ends that capture -- call start_console again after the tab reloads if you need to keep watching it; any start_network capture on the tab is unaffected (it is background-side, not tied to the tab\'s execution context).',
      inputSchema: { tabIds: z.array(z.number().int()).min(1).max(50) },
    },
    async ({ tabIds }) => {
      const result = await bridgeClient.call({ type: 'discard_tab', tabIds });
      return toolResult(result);
    }
  );

  server.registerTool(
    'go_back',
    {
      description:
        'Navigate a leased tab back one entry in its browsing history, like the browser back button. If the resulting URL hits the blacklist, the tab is landed on it briefly then reverted, the same confirmation flow as `navigate` is triggered, and `blacklisted_denied` is returned on decline.',
      inputSchema: { tabId: z.number() },
    },
    async ({ tabId }) => {
      const result = await bridgeClient.call({ type: 'go_back', tabId });
      return toolResult(result);
    }
  );

  server.registerTool(
    'go_forward',
    {
      description:
        'Navigate a leased tab forward one entry in its browsing history, like the browser forward button. If the resulting URL hits the blacklist, the tab is landed on it briefly then reverted, the same confirmation flow as `navigate` is triggered, and `blacklisted_denied` is returned on decline.',
      inputSchema: { tabId: z.number() },
    },
    async ({ tabId }) => {
      const result = await bridgeClient.call({ type: 'go_forward', tabId });
      return toolResult(result);
    }
  );

  server.registerTool(
    'list_tabs',
    {
      description:
        'List all open Firefox tabs (id, url, title, cookieStoreId, discarded, lastAccessed, incognito) and which are currently leased. `cookieStoreId` identifies which Multi-Account Container (if any) the tab belongs to -- see `list_containers`. `discarded` is true if Firefox has already unloaded the tab from memory. `lastAccessed` is a millisecond epoch timestamp of when the tab was last focused. `incognito` is true if the tab belongs to a private browsing window -- other tools can only reach it if the user has enabled "Run in Private Windows" for this extension in about:addons.',
      inputSchema: {},
    },
    async () => {
      const result = await bridgeClient.call({ type: 'list_tabs' });
      return toolResult(result);
    }
  );

  server.registerTool(
    'list_containers',
    {
      description:
        "List Firefox Multi-Account Containers (browser.contextualIdentities). Each entry's `cookieStoreId` can be passed to `acquire_tab` to open a new tab inside that container — the same website can be logged into different accounts simultaneously across different containers.",
      inputSchema: {},
    },
    async () => {
      const result = await bridgeClient.call({ type: 'list_containers' });
      return toolResult(result);
    }
  );

  server.registerTool(
    'create_container',
    {
      description:
        "Create a new Firefox Multi-Account Container (browser.contextualIdentities). `color`/`icon` are passed straight through to Firefox — an unsupported value is rejected by Firefox itself and surfaced here as a plain error message (Firefox's own contextualIdentities.getSupportedColors()/getSupportedIcons() are the source of truth for legal values; this tool does not hardcode a list). Does NOT deduplicate by `name` — Firefox allows multiple containers with the same name, and each call creates a genuinely new one (`cookieStoreId`, returned here, is the real identity, not `name`). Pass the returned `cookieStoreId` to `acquire_tab` to open a tab inside this container.",
      inputSchema: { name: z.string(), color: z.string(), icon: z.string() },
    },
    async ({ name, color, icon }) => {
      const result = await bridgeClient.call({ type: 'create_container', name, color, icon });
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

  server.registerTool(
    'to_be_deleted',
    {
      description:
        'Move a bookmark or folder to a fixed "Pending Deletion" folder (created automatically under Other Bookmarks on first use) — this tool NEVER permanently deletes anything, it only relocates. Permanent deletion is always a manual step the user performs later in Firefox\'s own bookmark manager. Pass exactly one of `target.id` (a bookmark id, from add_bookmark/list_bookmarks/search_bookmarks results — NOT a folder id, folders aren\'t addressable by id) or `target.folder` (a folder path, same convention as add_bookmark\'s `folder` parameter, including the "Bookmarks Toolbar"/"Bookmarks Menu"/"Mobile Bookmarks" root-label prefixes). Moving a folder moves its entire contents with it. Returns the item\'s previous location as `from` and "Pending Deletion" as `to`.',
      inputSchema: { target: z.object({ id: z.string().optional(), folder: z.string().optional() }).optional() },
    },
    async ({ target }) => {
      const result = await bridgeClient.call({ type: 'to_be_deleted', target });
      return toolResult(result);
    }
  );

  server.registerTool(
    'upload_file',
    {
      description:
        "Upload a local file to a leased tab's <input type=\"file\"> element, identified by a CSS selector. `filePath` is a path on the MACHINE RUNNING THIS MCP SERVER (same trust model as `screenshot` writing files locally) -- the file's bytes are read here and sent through to the page. Pass `frameId` to target a specific frame; omit it for the same frame-fallback search as `click`/`type`. `mimeType` is optional (defaults to `application/octet-stream` if omitted). Returns `element_not_found` if the selector is valid but matches nothing, `invalid_selector` if the selector itself has a CSS syntax error, `not_a_file_input` if the selector matches something other than an <input type=\"file\">. Fails with `file_too_large` if the file exceeds roughly 700KB (large-file chunking isn't implemented yet), `file_read_failed` if `filePath` doesn't exist or can't be read. The `change`/`input` events dispatched on the input after setting its files are untrusted synthetic events (`isTrusted: false`) -- a widget that hardens against automation by checking `e.isTrusted` in its handler will not pick up the file.",
      inputSchema: {
        tabId: z.number(),
        selector: z.string(),
        filePath: z.string(),
        frameId: z.number().optional(),
        mimeType: z.string().optional(),
      },
    },
    async ({ tabId, selector, filePath, frameId, mimeType }) => {
      let fileStat;
      try {
        fileStat = await stat(filePath);
      } catch (err) {
        return toolResult({ ok: false, error: `file_read_failed: ${err.message}` });
      }
      if (fileStat.size > MAX_UPLOAD_FILE_BYTES) {
        return toolResult({ ok: false, error: 'file_too_large' });
      }
      let bytes;
      try {
        bytes = await readFile(filePath);
      } catch (err) {
        return toolResult({ ok: false, error: `file_read_failed: ${err.message}` });
      }
      const fileName = path.basename(filePath);
      const outbound = {
        type: 'upload_file',
        tabId,
        selector,
        frameId,
        fileName,
        mimeType,
        dataBase64: bytes.toString('base64'),
      };
      // The real, mathematically-sound check: measure the actual message
      // that's about to be sent, not just the raw file bytes (see the
      // MAX_ENCODED_UPLOAD_MESSAGE_BYTES comment above).
      if (Buffer.byteLength(JSON.stringify(outbound), 'utf8') > MAX_ENCODED_UPLOAD_MESSAGE_BYTES) {
        return toolResult({ ok: false, error: 'file_too_large' });
      }
      const result = await bridgeClient.call(outbound);
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
