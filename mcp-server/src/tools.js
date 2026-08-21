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
        "Type text into an element in a leased tab, identified by a CSS selector. This ALWAYS overwrites the element's existing value with `text` — there is no append/insert-at-cursor mode, whatever was there before is replaced. Also works on `contenteditable` elements (e.g. rich-text chat inputs like Gemini's) — existing content is fully replaced the same as an `<input>`/`<textarea>`, via `document.execCommand('insertText', ...)`, so framework-bound widgets listening for native `beforeinput`/`input` events with `inputType:'insertText'` observe it correctly. `list_elements`'s `state.contentEditable: true` on an element indicates `type` will use this path for it (this tool itself will also use this path for any genuinely editable element, even one only editable by inheriting from an ancestor — `state.contentEditable` specifically marks direct editable roots, a narrower set used for candidate labeling — EXCEPT a native `<input>`/`<textarea>` nested inside an editable ancestor: Firefox reports such a control's `isContentEditable` as `true` too, but this tool always routes it through the normal `<input>`/`<textarea>` setter path below instead, so its own value is what actually changes, not the surrounding editing host's text). Fails with `contenteditable_insert_failed` if the browser reports the insertion itself did not succeed (this can also happen if the frame this ran in has no active selection object to work with, e.g. an unrendered iframe). Fails with `not_typable` if `selector` resolves to an element that is none of: a `<select>`, a native `<input>`/`<textarea>`, or `contenteditable` (e.g. a plain `<div>`/`<span>` with no editable semantics) — previously this threw an unhandled \"Illegal invocation\" error instead of returning a clean failure, now fixed to report `not_typable` explicitly. Pass `frameId` to target a specific frame (get it from `list_frames` or a `list_elements` entry) — defaults to the top frame (0). If you omit `frameId` AND the element is not found in the top frame, this tool automatically falls back to searching up to 19 other accessible frames for the first one where the selector resolves — you do NOT need to pass `frameId` just because an element came from an iframe. The response includes `frameSearchIncomplete: true` only alongside an ultimately unsuccessful result (`element_not_found`/`stale_selector`) when that omitted-`frameId` search could NOT be exhaustive (a frame was policy-blocked, the 20-frame cap was hit, or frame enumeration failed) — never alongside a successful type. Optionally pass `expectedDomEpoch` (from a prior `list_elements` call, same `frameId`) to guard against acting on a stale selector — if the page has since changed (navigation, bfcache restoration), this returns `stale_selector` and does NOT type anything. For `<select>` elements, prefer `select_option` instead — it supports substring matching, ambiguity detection, and matches the same displayed text `list_elements` reports; this tool's `<select>` handling only matches an exact `value` or the option's raw trimmed text CONTENT (not its `label` attribute, and not Unicode-whitespace-normalized) — which can differ from what `list_elements` reports for that option (its `options` field uses the `label` attribute when set, else normalized text) — kept for backward compatibility with existing callers.",
      inputSchema: { tabId: z.number(), selector: z.string(), text: z.string(), frameId: z.number().optional(), expectedDomEpoch: z.string().optional() },
    },
    async ({ tabId, selector, text, frameId, expectedDomEpoch }) => {
      const result = await bridgeClient.call({ type: 'type', tabId, selector, text, frameId, expectedDomEpoch });
      return toolResult(result);
    }
  );

  server.registerTool(
    'select_option',
    {
      description:
        "Select an <option> in a <select> element in a leased tab, identified by a CSS selector for the SELECT itself (not the option). Unlike `type`, this bypasses the browser's native OS-level dropdown popup entirely by directly setting the select's selection and dispatching the same `input`+`change` event pair a real user interaction produces -- necessary because a native <select>'s open dropdown is rendered outside the DOM, so `click` can open it but can never click an option inside it. Matching against `text` (the option's DISPLAYED text -- its `label` attribute if set, else its normalized text content, matching what `list_elements`'s `options` field reports for this select) proceeds in two tiers, each checked for ambiguity before falling through: first an exact match (if exactly one option's text equals `text` exactly, select it; if more than one, fail with `ambiguous_match` without trying substring matching), then if no exact match, a substring match (if exactly one option's text contains `text`, select it; if more than one, fail with `ambiguous_match`; if none, fail with `option_not_found`). Matching is case-sensitive. `ambiguous_match` includes a `matches` array (each entry `{index, value, text, disabled}`, capped at 20 with `matchesTruncated: true` if more existed) so you can retry with more specific text. Fails with `not_a_select` if `selector` matches something other than a <select>, `multiple_select_not_supported` for a <select multiple> (not supported in this version -- fails before any selection is attempted, so an existing multi-selection is never touched), `select_disabled`/`option_disabled` if the select or the uniquely-matched option is disabled (including via an ancestor <fieldset disabled>/<optgroup disabled>), `empty_text` if `text` normalizes to an empty string, `element_not_found` if the selector is syntactically valid but matches nothing, `invalid_selector` if the selector itself has a CSS syntax error. If the matched option is already selected, this is a no-op: returns `{ok:true, value, text, changed:false}` without dispatching any events, same as a real user re-selecting the current option. Otherwise selects it and dispatches `input` then `change` (both bubbling, matching the HTML standard's select update notifications -- sufficient for React, Vue, and legacy onchange handlers; these are untrusted synthetic events, isTrusted:false, so a page that specifically checks e.isTrusted will not accept the change), then re-reads the actual resulting selection and returns `{ok:true, value, text, changed:true}` describing what's ACTUALLY selected afterward -- in the rare case a synchronous change handler cleared the selection entirely (or replaced the select's options) before this returns, `value`/`text` are `null` rather than reporting the option this tool originally selected. Pass `frameId` to target a specific frame; omit it for the same frame-fallback search as `click`/`type` -- the response includes `frameSearchIncomplete: true` only alongside an ultimately unsuccessful result when that omitted-`frameId` search could NOT be exhaustive (a frame was policy-blocked, the 20-frame cap was hit, or frame enumeration failed). Optionally pass `expectedDomEpoch` (from a prior `list_elements` call, same `frameId`) to guard against acting on a stale selector -- note this only detects navigation/bfcache staleness, not an SPA replacing this select's option list within the same document.",
      inputSchema: { tabId: z.number(), selector: z.string(), text: z.string(), frameId: z.number().optional(), expectedDomEpoch: z.string().optional() },
    },
    async ({ tabId, selector, text, frameId, expectedDomEpoch }) => {
      const result = await bridgeClient.call({ type: 'select_option', tabId, selector, text, frameId, expectedDomEpoch });
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
        "List interactive elements (links, buttons, inputs, selects, textareas, contenteditable text containers, ARIA button/link/menuitem/tab roles, table rows/header cells) currently visible in a leased tab. `<tr>`/`<th>` are included as scroll/reference targets (e.g. for `scroll_to`) even though a bare table row usually isn't clickable itself. Each entry includes a `selector` and `frameId` you can pass directly to `click`/`type`/`select_option` — guaranteed to target exactly the inspected element, no guessing required. Capped at 300 elements per frame; `truncated: true` on a frame's entry means some were dropped there. Pass `frameId` (from `list_frames`) to scan one specific frame — response is flat: `{ok, elements, totalCandidates, truncated, domEpoch}`. Omit `frameId` to scan every frame at once — the response is then `{ok, frames: [{frameId, parentFrameId, url, elements, totalCandidates, truncated, domEpoch, ...}], frameErrors: [...]}` grouped per frame, so you can tell a page's real content frame apart from an unrelated ad/tracking iframe instead of everything being interleaved; each frame carries its own `domEpoch`, there is no single top-level value when `frameId` is omitted. Each element also carries a `state` object (always present, `{}` if nothing applies) so you can read current form-control state without a screenshot: `checked` (checkbox/radio only), `value` (input/textarea/select/contenteditable, but NEVER for password/hidden/file inputs — that key is deliberately absent for those, not an empty string; for a contenteditable element this is its `.innerText`, which is not a strict round-trip of text `type` writes into it — multi-line content in particular can come back with different newline handling than what was sent), `disabled`/`readonly` (booleans, only on applicable control types), `contentEditable` (boolean `true`, only present on an element whose OWN `contenteditable` attribute is directly set to an editable value AND that the browser confirms is actually live-editable — e.g. absent on an element that merely inherits editability by sitting inside an editable ancestor (a nested `<button>` there stays a plain button, not a text field); an element's OWN `contenteditable=\"true\"`/`\"plaintext-only\"` always governs regardless of an ancestor's `contenteditable=\"false\"` — it is NOT overridden by an outer `\"false\"` (live-verified: a `\"false\"` container does not suppress an inner element's own explicit `\"true\"`) — use this to tell a text-entry container like a chat input apart from an ordinary clickable element, and pass its `selector` to `type` the same as any input), `ariaExpanded`/`ariaChecked` (raw ARIA attribute strings, e.g. `\"true\"`/`\"false\"`/`\"mixed\"` — not coerced to boolean, only present when the attribute exists on the element). Pass `filter` to narrow the result set: `container` (a CSS selector — only scans descendants of the first matching element; this is the only field that actually reduces scan work, since it limits the underlying DOM query and the heuristic cursor:pointer walk, which is capped at 3000 candidates before filtering) — an invalid `container` selector returns `invalid_container_selector` (as the call's top-level `error` when you pass an explicit `frameId`; inside that frame's `frameErrors[]` entry when you don't, with the overall call still `ok: true`), a valid-but-unmatched `container` returns a normal empty result (`{ok:true, elements: []}` with `frameId`; `{ok:true, frames:[{..., elements: [], totalCandidates: 0}]}` without it). `text` (case-insensitive substring match against the full element label), `tag` (case-insensitive exact tag match), and `type` (case-insensitive exact `type` attribute match) instead filter the already-gathered candidate array — they narrow the response, not the scan cost. When `filter` is used, `totalCandidates` reflects the already-filtered candidate count, not the whole page/frame's total interactive-element count. In aggregate (no-`frameId`) mode, `filter.container` is resolved independently per frame, so a generic selector can match something in an unrelated iframe — read results as frame-local matches, not page-wide. Filtering narrows the candidate set BEFORE the 300-element cap, so a filtered-for element on a large page won't be dropped by the cap. `domEpoch` changes on real navigation and on bfcache restoration (but NOT on same-page SPA route changes), for use with `click`/`type`'s `expectedDomEpoch` parameter to detect a stale cached selector.",
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
        'Lease a new or existing Firefox tab for this session. Pass a url to open a new tab, or a tabId to lease an existing one. Pass `cookieStoreId` (from `list_containers`/`create_container`) to open the new tab inside that container — only valid when opening a NEW tab (no `tabId`); combining `tabId` with `cookieStoreId` returns `cookie_store_requires_new_tab`, since an existing tab\'s container was fixed when it was created and cannot be changed. An unrecognized `cookieStoreId` (including Firefox\'s reserved, non-container stores) returns `container_not_found`. Pass `windowId` (from `list_tabs`\'s per-tab `windowId` field, `acquire_tab`\'s own response, or `open_private_window`\'s returned `windowId`) to open the new tab inside a specific existing window — e.g. a private window opened via `open_private_window` — instead of whatever window Firefox considers "current"; only valid when opening a NEW tab (no `tabId`), combining them returns `window_id_requires_new_tab`. A `windowId` that isn\'t an accessible open window (doesn\'t exist, or exists but this session\'s extension can\'t access it -- e.g. a private window without "Run in Private Windows" enabled) returns `window_not_found`. Firefox\'s Multi-Account Containers don\'t exist in private windows — passing both `windowId` (pointing to a private window) and `cookieStoreId` together returns `container_unavailable_in_private_window`. The response always includes `cookieStoreId` and `windowId` for the tab you got, whether or not you passed either — a normal (non-container) tab reports Firefox\'s default store id, and a tab you didn\'t target with `windowId` still reports whichever window it actually landed in. When opening a new tab with a real `url` (not omitted, not `about:blank`), this tool waits up to 3s for the navigation to commit (not for the page to finish loading) before responding, so `url` reflects the currently observed committed URL rather than a stale `about:blank` — but that\'s still not guaranteed to equal what you passed, since a server-side redirect can commit to a different address, and the 3s bound is on the navigation wait itself, not on this tool\'s total latency (an unusually slow tab creation adds on top). If the wait times out, the response includes `urlPending: true` and `url` may still be stale; follow up with `wait_for` or `read_page` if you need certainty.',
      inputSchema: {
        url: z.string().optional(),
        tabId: z.number().optional(),
        cookieStoreId: z.string().optional(),
        windowId: z.number().optional(),
      },
    },
    async ({ url, tabId, cookieStoreId, windowId }) => {
      const result = await bridgeClient.call({ type: 'acquire_tab', url, tabId, cookieStoreId, windowId });
      return toolResult(result);
    }
  );

  server.registerTool(
    'open_private_window',
    {
      description:
        'Open a new Firefox private browsing window and lease its initial tab to this session (like acquire_tab -- no separate acquire_tab call needed). Pass url to navigate there immediately; omitted or "about:blank" opens a blank private tab. Unlike acquire_tab, this does not wait for the navigation to commit and does not return url; follow up with wait_for/read_page if you need the destination loaded. Requires the extension\'s "Run in Private Windows" toggle to be enabled by the user in about:addons -- Firefox gives extensions no API to enable this themselves, and without it this call fails outright with private_window_access_denied (no window is created). May also fail with private_browsing_create_failed, which is not only returned when private browsing is disabled by policy but also fires for an ordinary invalid, malformed, or privileged url argument (e.g. about:config) -- read the appended message for the real cause. Subject to the same URL blacklist confirmation flow as acquire_tab/navigate (blacklisted_denied on decline). Returns `windowId` and `tabId`; pass that `windowId` to `acquire_tab`\'s `windowId` parameter to open further tabs in the same private window.',
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
        'List all open Firefox tabs (id, url, title, cookieStoreId, discarded, lastAccessed, incognito, windowId, index, active) and which are currently leased, plus a top-level `focusedWindowId`. `cookieStoreId` identifies which Multi-Account Container (if any) the tab belongs to -- see `list_containers`. `discarded` is true if Firefox has already unloaded the tab from memory. `lastAccessed` is a millisecond epoch timestamp of when the tab was last focused. `incognito` is true if the tab belongs to a private browsing window -- private tabs appear in this list only if the user has enabled "Run in Private Windows" for this extension in about:addons; without it they are omitted from list_tabs entirely (not merely unreachable), so an absence of incognito: true entries does not mean no private tabs are open. `windowId` identifies which browser window the tab belongs to -- pass it to acquire_tab\'s `windowId` parameter to open a new tab inside that same window instead of whatever window Firefox considers "current". `index` is the tab\'s 0-based position within its OWN window\'s tab order -- useful for describing a tab by position ("the 3rd GitHub tab") but NOT a guaranteed visual left-to-right count (Firefox vertical tabs, hidden tabs) and NOT a stable identifier across calls, always re-read it fresh. `active` is true only for the one currently-active tab in its own window (every open window has exactly one -- `active` alone never identifies a single tab across multiple windows). Combine `active`, `windowId`, and the response\'s top-level `focusedWindowId` to find "the tab the user is currently looking at": the tab where `windowId === focusedWindowId && active === true` -- well-defined (exactly one match) only when `focusedWindowId` is non-null; it is `null` whenever Firefox itself does not currently have OS focus (e.g. the user is in another application), meaning no tab should be treated as the one they\'re looking at. If duplicate/ambiguous tabs of the same site can\'t be resolved from these fields, use `request_tab_selection`.',
      inputSchema: {},
    },
    async () => {
      const result = await bridgeClient.call({ type: 'list_tabs' });
      return toolResult(result);
    }
  );

  server.registerTool(
    'request_tab_selection',
    {
      description:
        "Ask the user to manually pick a specific Firefox tab, for when list_tabs's index/active/cookieStoreId/windowId fields aren't enough to disambiguate 2+ candidate tabs (e.g. the same URL open in 2+ tabs, same container, same window). Returns immediately with { ok: true, requestId } -- it does NOT wait for the user. Right after this call, right-clicking any tab in Firefox's tab strip shows a \"Firefox Bridge\" submenu with one row per pending request, labelled by that request's `reason`. Poll with get_tab_selection(requestId) to find out once the user has picked one. `reason` is required -- with 2+ requests pending (e.g. a concurrent CLI session also has one open), the row label is the only way the user can tell which request is which, so make it specific to what you're about to do.",
      inputSchema: { reason: z.string() },
    },
    async ({ reason }) => {
      const result = await bridgeClient.call({ type: 'request_tab_selection', reason });
      return toolResult(result);
    }
  );

  server.registerTool(
    'get_tab_selection',
    {
      description:
        "Poll for the result of a pending request_tab_selection call. Returns { ok: true, status: 'pending' } if the user hasn't picked a tab yet -- call again later. Returns { ok: true, status: 'resolved', tabId } once they have (only then is `tabId` present). Returns { ok: true, status: 'timedOut' } if 120 seconds passed with no pick, or { ok: true, status: 'uiUnavailable' } if the selection UI itself failed to render. A terminal status (anything other than 'pending') is delivered at most once -- calling again with the same requestId after that returns { ok: false, error: 'unknown_request' }, same as passing an unrecognized requestId or one that belongs to a different session.",
      inputSchema: { requestId: z.string() },
    },
    async ({ requestId }) => {
      const result = await bridgeClient.call({ type: 'get_tab_selection', selectionRequestId: requestId });
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

  server.registerTool(
    'list_dialogs',
    {
      description:
        "List all JS dialogs (alert/confirm/prompt) currently blocked and awaiting an answer, across every whitelisted page. Each entry: {id, url, type, message, defaultText, openedAt}. `type` is 'alert'|'confirm'|'prompt'. `url` is self-reported by the page (via location.href) for display purposes only -- it is NOT a trustworthy identifier and cannot disambiguate two tabs open on the identical URL; use `id` to resolve a specific one via `respond_dialog`, which always routes correctly regardless. A dialog only appears here if the page's synchronous request actually reached the local dialog server -- if the page's own CSP or Permissions-Policy blocked that request, the page instead shows a REAL native dialog that only a human can answer, and it never appears here at all. Requires the target hostname to already be on the dialog whitelist (`add_dialog_whitelist`) -- unwhitelisted pages never intercept their dialogs in the first place, and their alert/confirm/prompt calls behave exactly as if this feature didn't exist.",
      inputSchema: {},
    },
    async () => {
      const result = await bridgeClient.call({ type: 'list_dialogs' });
      return toolResult(result);
    }
  );

  server.registerTool(
    'respond_dialog',
    {
      description:
        "Answer a pending dialog from `list_dialogs` by id. `action` is 'accept' or 'dismiss'. For type 'confirm': accept->true, dismiss->false (matching clicking OK vs Cancel). For type 'prompt': accept returns `text` if given, else the dialog's own `defaultText`; dismiss always returns null regardless of `text` (matching Cancel, which discards any typed input). For type 'alert': either action just unblocks the page (alert has no return value either way). Returns {ok:false, error:'not_found'} if `id` no longer matches a pending dialog -- already resolved, timed out after 30s with a safe default (confirm->false, prompt->null), or never existed.",
      inputSchema: { id: z.string(), action: z.enum(['accept', 'dismiss']), text: z.string().optional() },
    },
    async ({ id, action, text }) => {
      const result = await bridgeClient.call({ type: 'respond_dialog', id, action, text });
      return toolResult(result);
    }
  );

  server.registerTool(
    'add_dialog_whitelist',
    {
      description:
        "Add a hostname to the dialog interception whitelist -- pages on this hostname (and its subdomains) will have their alert/confirm/prompt calls intercepted so this AI can see and answer them via list_dialogs/respond_dialog, instead of popping a real native dialog only a human can click. Only add hostnames you actually trust: the mechanism works by injecting an override into the page's own JavaScript execution context, and that page's own script can in principle read the internal auth token this feature uses to talk to its local helper server -- this is an accepted, documented tradeoff for hostnames the user explicitly opts in, not a bug. `hostname` is normalized the same way as the existing navigation blacklist (scheme/path stripped if present, e.g. \"https://example.com/\" and \"example.com\" both store as \"example.com\"). Already-loaded pages on this hostname are NOT retroactively hooked -- reload them (e.g. via `navigate` to the same URL) for interception to take effect.",
      inputSchema: { hostname: z.string() },
    },
    async ({ hostname }) => {
      const result = await bridgeClient.call({ type: 'add_dialog_whitelist', hostname });
      return toolResult(result);
    }
  );

  server.registerTool(
    'remove_dialog_whitelist',
    {
      description:
        "Remove a hostname from the dialog interception whitelist. Already-loaded pages on this hostname keep their override installed until reloaded (removal only stops FUTURE page loads on this hostname from getting the hook) -- reload the page for its alert/confirm/prompt to go back to real native dialogs.",
      inputSchema: { hostname: z.string() },
    },
    async ({ hostname }) => {
      const result = await bridgeClient.call({ type: 'remove_dialog_whitelist', hostname });
      return toolResult(result);
    }
  );

  server.registerTool(
    'add_webmcp_whitelist',
    {
      description:
        "Add a hostname to the WebMCP shim whitelist -- pages on this hostname (and its subdomains) get a compatibility shim for the experimental WebMCP API (document.modelContext.registerTool), letting this AI discover (webmcp_list_tools) and call (webmcp_call_tool) tools the page itself registers. Independent of the dialog-interception whitelist (add_dialog_whitelist) -- whitelisting a hostname here does NOT also enable dialog interception, and vice versa; the two grant different capabilities. Only add hostnames you actually trust: any tool a page registers runs with that page's own permissions, and this AI will be able to call it. Trusting a hostname also means trusting every script that hostname's pages load, not just the page's own first-party code -- the page-world messaging protocol uses window.postMessage(..., '*'), so any same-window script (e.g. a third-party ad/analytics tag) can observe or forge the WebMCP protocol's messages. `hostname` is normalized the same way as the dialog whitelist (scheme/path stripped if present). Already-loaded pages on this hostname are NOT retroactively hooked -- reload them (e.g. via `navigate` to the same URL) for the shim to take effect.",
      inputSchema: { hostname: z.string() },
    },
    async ({ hostname }) => {
      const result = await bridgeClient.call({ type: 'add_webmcp_whitelist', hostname });
      return toolResult(result);
    }
  );

  server.registerTool(
    'remove_webmcp_whitelist',
    {
      description:
        "Remove a hostname from the WebMCP shim whitelist. This revokes AI-callability IMMEDIATELY -- webmcp_list_tools/webmcp_call_tool re-check the whitelist on every call, so a still-open tab on this hostname is no longer listable or callable right away. What does NOT change immediately: an already-loaded page's shim script stays physically installed and keeps running until the page reloads or navigates away -- it just can no longer be discovered or called through this MCP server.",
      inputSchema: { hostname: z.string() },
    },
    async ({ hostname }) => {
      const result = await bridgeClient.call({ type: 'remove_webmcp_whitelist', hostname });
      return toolResult(result);
    }
  );

  server.registerTool(
    'webmcp_list_tools',
    {
      description:
        "List the WebMCP tools a whitelisted page has registered on the given tab (via document.modelContext.registerTool). Returns {documentId, tools: [{name, title, description, inputSchema, annotations}, ...]} -- `tools` is empty and `documentId` is null if the page hasn't registered anything (not whitelisted, hasn't loaded yet, or registered nothing). Pass the returned `documentId` to webmcp_call_tool -- it identifies exactly which page load this tool list belongs to, so a call made after the page navigates away fails cleanly (`stale_registration`) instead of silently reaching the wrong document. Only top-level-frame registrations are seen -- tools registered from inside an iframe are not supported and never appear here.",
      inputSchema: { tabId: z.number() },
    },
    async ({ tabId }) => {
      const result = await bridgeClient.call({ type: 'webmcp_list_tools', tabId });
      return toolResult(result);
    }
  );

  server.registerTool(
    'webmcp_call_tool',
    {
      description:
        "Call a WebMCP tool a whitelisted page has registered, by name (from webmcp_list_tools). Requires holding the tab's lease (acquire_tab) first, same as click/type/etc. -- fails with {ok:false, error:'not_leased'} if you haven't called acquire_tab, or {ok:false, error:'conflict'} if another session holds the lease. `documentId` must be the value webmcp_list_tools most recently returned for this tab; a mismatch (e.g. the page navigated away since) returns {ok:false, error:'stale_registration'} rather than silently calling into whatever page is now loaded. The whitelist is re-checked live on every call, not just at registration time -- if the hostname was removed from the whitelist since the page registered, this returns {ok:false, error:'not_whitelisted'} even though the registration itself is still otherwise valid. Calls time out after 20 seconds ({ok:false, error:'tool_call_timeout'}) -- WebMCP tools are expected to be fast, read-only-ish operations, not long-running ones. A tool that throws returns {ok:false, error:'tool_execution_error: <message>'}.",
      inputSchema: {
        tabId: z.number(),
        toolName: z.string(),
        documentId: z.string(),
        arguments: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async ({ tabId, toolName, documentId, arguments: args }) => {
      const result = await bridgeClient.call({ type: 'webmcp_call_tool', tabId, toolName, documentId, arguments: args });
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
