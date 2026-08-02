<!-- repo/docs/manual-verification-checklist.md -->
# firefox-bridge MVP — Manual Verification Checklist

Run through this after any change to `extension/`, `native-host/`, or `mcp-server/`
that automated unit tests can't cover (real Firefox + real process spawning).

## Setup
- [ ] `node scripts/install-native-manifest.js` completed without error
- [ ] Firefox restarted
- [ ] Extension loaded via `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → `repo/extension/manifest.json`
- [ ] Extension's background page console (Inspect) shows `firefox-bridge: native port connected` with no errors

## Native host lifecycle
- [ ] Reload the extension from `about:debugging` — background console shows a reconnect, no crash
- [ ] Kill the native host process manually (`pkill -f native-host/src/index.js`) — extension logs a disconnect and a reconnect attempt within ~1s
- [ ] After reconnect, confirm a previously-acquired tab lease from an MCP client is no longer honored (expect `not_leased`, not silent success)

## MCP server + tools (run mcp-server manually: `cd repo/mcp-server && node src/index.js`, drive it with any MCP-capable client or a small manual JSON-RPC script over stdio)
- [ ] `acquire_tab` with a `url` opens a new tab and returns a `tabId`
- [ ] `list_tabs` returns all open tabs (id, url, title) including lease status, matching actual browser state (open a couple of tabs manually, acquire a lease on one via another tool call, and confirm list_tabs reflects both the full tab list and the correct leasedBy status)
- [ ] `navigate` to a normal (non-blacklisted) URL succeeds
- [ ] `click` on a known selector (test against a simple local HTML page) actually clicks
- [ ] `type` on an input field sets its value and fires `input`/`change` (verify via a page that echoes input state)
- [ ] `read_page` returns the page's visible text
- [ ] `list_elements` returns interactive elements with working `selector`s; a follow-up `click`/`type` using one of those selectors hits exactly the inspected element
- [ ] `list_elements` on a page whose clickable targets are plain `li`/`span`/`div` with a JS-bound (not inline `onclick`) handler still finds them via the `cursor: pointer` heuristic
- [ ] `list_elements` / `click` / `type` work on a plain-`http://` (non-HTTPS, non-localhost) page, e.g. a LAN device admin UI — this is an insecure context, which previously broke id generation (`crypto.randomUUID` throws there; fixed by switching to `crypto.getRandomValues`)
- [ ] A tool call against a Firefox session-restore tab that hasn't been visited yet (e.g. right after a Firefox restart, before clicking into the tab) returns `tab_not_loaded`, not a generic injection-failure error
- [ ] `type` against a `<select>` sets the option matching `text` (by `value`, falling back to visible text) and fires `change` — verify against a real multi-option dropdown, not just a text input
- [ ] `list_elements` on a `<select>` includes an `options: [{value, text}]` array matching the page's real `<option>` list

### Frames (`content_scripts` is `all_frames: true`)
- [ ] `list_frames` on a page with no iframes returns exactly one frame (`frameId: 0`)
- [ ] `list_frames` on a page with a nested `<iframe><iframe>...` returns every frame with correct `parentFrameId` chains
- [ ] `read_page` / `list_elements` with no `frameId` on a page WITH iframes returns `{frames: [...], frameErrors: [...]}` grouped per frame, not a single merged blob — content that only exists inside an iframe (e.g. a settings panel embedded via `<iframe>`) shows up under its own frame entry
- [ ] `read_page` / `list_elements` with an explicit `frameId` returns that one frame's content in the pre-frame-work flat shape (no `frames` wrapper)
- [ ] `click` / `type` with an explicit non-zero `frameId` hits the element inside that iframe, not a same-selector match in the top frame
- [ ] `click` / `type` with `frameId` omitted defaults to the top frame (0) — does NOT reach into iframes
- [ ] A blacklisted URL loaded inside an iframe (top-level page itself NOT blacklisted) still triggers the confirmation gate when that specific frame is read/clicked — the top-level page being allowed must not leak the embedded frame
- [ ] An unreachable frame (e.g. `about:blank`, or one blocked by host permissions) appears in `frameErrors` with a real per-frame error, and does NOT fail the whole aggregate `read_page`/`list_elements` call for the other frames
- [ ] `screenshot` returns base64 PNG bytes that decode to a valid image
- [ ] `screenshot` of a large/retina full-page capture (>1 MiB PNG) still succeeds — this exercises the multi-chunk native-messaging path
- [ ] `start_console` + a page `console.log(...)` + `get_console` returns that message
- [ ] `console.log()`ing a very long string (>2000 chars) or large object results in a `get_console` entry truncated to ~2000 chars with a `...[truncated, N chars total]` marker, not the full original length
- [ ] Navigating to a page whose script requests have very long URLs (e.g. `pagespeed.web.dev`) results in `get_network` entries with `url` truncated to ~2000 chars with the same marker
- [ ] `get_console` / `get_network` before their `start_*` call returns `not_subscribed` (not an empty list)
- [ ] `start_network` *then* `navigate` — `get_network` includes the page-load requests (traffic before `start_network` is not captured, by design)
- [ ] `get_network` returns observed requests for that tab only (open a second leased tab making different requests, confirm no cross-tab leakage)
- [ ] `release_tab` then `acquire_tab` from a second simulated session on the same `tabId` succeeds (no stale conflict)
- [ ] `release_tab` on a tab this session does NOT own returns `conflict`/`not_leased` rather than silently succeeding
- [ ] After `release_tab` + re-`acquire_tab` by a second session, `get_console`/`get_network` return `not_subscribed` — no leftover data from the first session

## History search
- [ ] `search_history` with a keyword that matches a page you've actually visited returns a result with correct `url`/`title`/`visitCount`/`lastVisitTime`
- [ ] Visit a page more than a year ago (or manually adjust `HISTORY_SEARCH_RANGE_MS` down for testing, then revert) — confirm it does NOT show up in `search_history` results, verifying the 1-year internal window is actually applied and not just documented
- [ ] Visit more than 30 distinct pages matching a common keyword — confirm `search_history` returns at most 30 results, not the API's default of 100
- [ ] Visit a URL on a blacklisted hostname (from the options page blacklist), then `search_history` for it — confirm the result DOES appear (this is the deliberate no-filtering design, not a bug — this check exists to catch a future accidental regression toward filtering)
- [ ] `search_history` does NOT trigger the blacklist confirmation popup, even when results include a blacklisted site — confirms it truly bypasses `privilegedGate()`

## Bookmarks
- [ ] `add_bookmark` on a new URL (with `title` and a new `folder`) succeeds; returned fields (`id`/`url`/`title`/`folder`/`folderCreated`) are correct and `folderCreated` is `true`
- [ ] `add_bookmark` again with the same `folder` (different URL) reuses the folder instead of creating a duplicate — `folderCreated` is `false`, and only one folder with that name exists in the Firefox bookmarks manager
- [ ] `add_bookmark` with a multi-level `folder` (e.g. `"A/B"`) creates a real nested folder structure, visible in the Firefox bookmarks manager
- [ ] `add_bookmark` on an already-bookmarked URL (non-private address) returns `duplicate: true` and does NOT create a new bookmark (count in the bookmarks manager doesn't change)
- [ ] `add_bookmark` on an already-bookmarked URL, passing a brand-new `folder` parameter, still returns `duplicate: true` — and that new folder is NOT created (verifies dedup happens before folder resolution)
- [ ] `add_bookmark` on a private-network URL (e.g. `http://192.168.1.1/`) called twice with different `title`s both succeed — not blocked by dedup, two separate bookmarks appear
- [ ] `add_bookmark` on a private-network URL with `title` left empty (or equal to the URL) returns a `titleWarning`, and the bookmark is still created successfully (not blocked)
- [ ] A blacklisted site's bookmark still appears via `list_bookmarks`/`search_bookmarks` with zero filtering (once those tools exist — see Task 3's checklist items)

## Policy gate / blacklist
- [ ] Pasting a full URL (e.g. `https://www.example.com/`) into the options page's hostname field gets normalized to a bare hostname (`www.example.com`) before being stored/listed — not silently stored as-is
- [ ] Pasting something that isn't a valid hostname (e.g. empty after stripping, or garbage input) shows an inline error and does NOT get added to the list
- [ ] Add a hostname via the options page; `navigate` to it triggers a confirmation popup and the target tab does NOT navigate before you respond
- [ ] Choosing "Allow once" navigates, and the next `navigate` call to that exact URL doesn't re-prompt, but a *different* URL on the same blacklisted host does
- [ ] Choosing "Allow for this session" lets any URL on that hostname through for the rest of the session without re-prompting
- [ ] Letting the popup time out (60s, no click) results in `navigate` returning `blacklisted_denied`, not hanging
- [ ] With a blacklisted site ALREADY open in a tab, `acquire_tab` by `tabId` prompts for confirmation (and returns `blacklisted_denied` if refused)
- [ ] On an already-leased blacklisted tab, each of `screenshot`, `read_page`, `click`, `type`, `start_console`, `get_console`, `start_network`, `get_network` triggers the confirmation gate — none of them bypass it

## Multi-session
- [ ] Run two separate `mcp-server` processes (two "sessions") concurrently; each `acquire_tab` on a *different* tab succeeds independently
- [ ] Both sessions attempting `acquire_tab` on the *same* existing `tabId` — second one gets `conflict`
- [ ] Kill session A's `mcp-server` process (Ctrl-C) while it holds a lease; session B can then `acquire_tab` that same `tabId` without a stale `conflict` (session_end reached the extension)
- [ ] Killing session A does NOT disturb session B's existing lease on a different tab
