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
- [ ] `list_elements` on a page with a `type="password"` input that has a real value in it (type one in manually, or trigger Firefox's password-manager autofill) never includes that value in the element's `text` field — confirm the field is empty/omitted, not the plaintext password
- [ ] A tool call against a Firefox session-restore tab that hasn't been visited yet (e.g. right after a Firefox restart, before clicking into the tab) returns `tab_not_loaded`, not a generic injection-failure error
- [ ] `type` against a `<select>` sets the option matching `text` (by `value`, falling back to visible text) and fires `change` — verify against a real multi-option dropdown, not just a text input
- [ ] `list_elements` on a `<select>` includes an `options: [{value, text}]` array matching the page's real `<option>` list
- [ ] `list_elements` on a known-checked and a known-unchecked checkbox reports `state.checked` as `true`/`false` matching what Firefox actually shows
- [ ] Same check for radio buttons (a selected one and an unselected one) — tested independently, not assumed covered by the checkbox case
- [ ] `list_elements` on a text input with pre-filled text reports `state.value` matching the displayed text
- [ ] `list_elements` on a `type="password"` field with a real value (typed, or autofilled by Firefox's password manager) has NO `value` key in `state` at all — not an empty string, the key itself is absent
- [ ] Same check with `type="PASSWORD"` (uppercase) — confirms the case-insensitive type check fix; `state.value` is still absent and the `text` label also doesn't leak the value
- [ ] `list_elements` on a `type="hidden"` field with a value has no `state.value` key
- [ ] `list_elements` on a `type="file"` input has no `state.value` key
- [ ] `list_elements` on a `type="file"` input's `text` label does NOT contain the local filename/fake path — confirms the label-building logic excludes file inputs the same way it excludes password inputs, not just `state.value`
- [ ] `list_elements` on a disabled button/field reports `state.disabled === true`; the same element type enabled reports `state.disabled === false` (always an explicit boolean when the element type applies, never omitted for being `false`)
- [ ] An `input` inside a `<fieldset disabled>` also reports `state.disabled === true` (this falls out of `el.disabled` for free — no special-case code needed, just confirm it actually happens)
- [ ] A readonly text input and a readonly textarea both report `state.readonly === true`
- [ ] A readonly `<input readonly>` with **no** `type` attribute at all still reports `state.readonly === true` (regression guard for the typeless-input readonly fix)
- [ ] A checkbox (where `readonly` has no meaning) has no `readonly` key in `state` at all — confirms the scope restriction to text-like input types
- [ ] An element with `aria-expanded="true"` reports `state.ariaExpanded === "true"` (string); after it collapses, a fresh call reports `"false"`; an element with no `aria-expanded` attribute at all has no `ariaExpanded` key (not the string `"false"`)
- [ ] An element with `aria-checked="mixed"` (e.g. a partially-selected tree node) reports `state.ariaChecked === "mixed"` verbatim — not coerced to `true` or `false`
- [ ] A `<select>`'s `state.value` matches its currently-selected `<option>`'s value and is consistent with the existing `options` array; after using `type` to change the selection, a fresh `list_elements` call reflects the new value
- [ ] A plain `<a>` link (no form semantics, no relevant ARIA attributes) has `state: {}` — present as an empty object, not an exception and not a missing `state` field entirely
- [ ] On a page with iframes, calling `list_elements` without `frameId` (multi-frame aggregation mode) — every element in every frame's entry still carries a correct `state` object, not dropped or overwritten during aggregation

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
- [ ] `list_bookmarks()` (no `folder`) lists every bookmark, fields correct, no folder nodes in the results
- [ ] `list_bookmarks(folder)` returns only that folder's direct bookmarks, not nested sub-folder content
- [ ] `list_bookmarks(folder)` on a folder that doesn't exist returns `{ok: true, results: []}`, not an error
- [ ] `search_bookmarks(query)` finds a bookmark by a keyword in its `title`
- [ ] `search_bookmarks(query)` finds a bookmark by a keyword in its `url`
- [ ] A blacklisted site's bookmark still appears in both `list_bookmarks` and `search_bookmarks` results (verifies the deliberate no-filtering design, not an oversight)
- [ ] A bookmark manually placed in the Bookmarks Toolbar (not Other Bookmarks) is reported by `list_bookmarks()`/`search_bookmarks` with `folder` starting with `"Bookmarks Toolbar"`; calling `add_bookmark`/`list_bookmarks(folder: "Bookmarks Toolbar/<same subfolder>")` with that exact string round-trips to the same location, not a new one under Other Bookmarks
- [ ] With a very large number of bookmarks (or by temporarily lowering `MAX_BOOKMARK_RESULTS` for testing, then reverting), `list_bookmarks()`/`search_bookmarks` results are capped and the response includes `truncated: true` when the cap is hit

## Bookmark cleanup
- [ ] `move_to_pending_deletion` called with `target` giving both `id` and `folder`, or neither, or an empty/whitespace-only string for either — all return `invalid_target`
- [ ] Called with `target.folder` set to `"/"` or `"//"` (non-empty raw string, but zero real path segments) — returns `invalid_target`
- [ ] Called with a real bookmark's `id` — that bookmark disappears from its original folder and appears under "Pending Deletion"; `from`/`to` fields are correct
- [ ] Called with a real folder path (containing sub-bookmarks) via `target.folder` — the entire folder, with all its contents, moves under "Pending Deletion"; nothing inside is lost
- [ ] Called with a `target.folder` path that doesn't exist — returns `folder_not_found`
- [ ] Called with `target.folder: "Bookmarks Toolbar"` (a root label alone, no sub-path) — returns `cannot_move_root`
- [ ] Called with `target.folder: "Pending Deletion"` (after it already exists) — returns `cannot_move_ancestor_of_destination`
- [ ] Called twice in a row on a bookmark already inside "Pending Deletion" — the second call succeeds (not an error), `from`/`to` both read "Pending Deletion"
- [ ] With two same-named folders manually created at the same level in Firefox, calling `target.folder` with that name moves the one with the earlier `dateAdded`, not an unpredictable one
- [ ] First call ever (no "Pending Deletion" folder exists yet) auto-creates it; a second call reuses the same folder rather than creating a duplicate
- [ ] Moving a bookmark that has Tags/Keyword set (visible in Firefox's bookmark manager) — after the move, confirm in the bookmark manager that Tags/Keyword are still present (this is the spec's stated "inference, not a verified guarantee" — this check is what turns it into a verified fact)
- [ ] Called with a nonexistent/already-deleted `id` — returns a structured error, not a hang or unhandled exception
- [ ] Moving a bookmark that was sitting directly in Other Bookmarks (not in any sub-folder) reports `from: ""` (the established unprefixed-default-root convention used elsewhere in this tool set — see `list_bookmarks`), not `"Other Bookmarks"` or any other string — this is expected, not a bug

## Multi-Account Containers
- [ ] `list_containers()` returns a `containers` array matching what's shown in Firefox's `about:preferences#general` → Tab Containers section (name/color/icon for each)
- [ ] `create_container({name, color, icon})` with valid values creates a real new container visible in Firefox, and the returned `cookieStoreId` is usable in a later `acquire_tab` call
- [ ] `create_container` with an unsupported `color` or `icon` value returns `{ok: false, error: ...}` with Firefox's own rejection message, not a silent success or an unhandled exception
- [ ] Creating two containers with the same `name` succeeds both times, with two different `cookieStoreId` values (verifies the deliberate no-dedup-by-name decision)
- [ ] `acquire_tab({cookieStoreId})` (no `url`) opens a new `about:blank` tab that visually belongs to that container, and the response's `cookieStoreId` matches
- [ ] `acquire_tab({cookieStoreId, url})` opens a new tab at that URL that also belongs to that container — both conditions hold at once, not just one
- [ ] `acquire_tab({tabId, cookieStoreId})` together (any values) returns `cookie_store_requires_new_tab`, not a silently-ignored parameter
- [ ] `acquire_tab({cookieStoreId: "<random nonexistent string>"})` returns `container_not_found`, not an unhandled exception or a tab opened in the default container
- [ ] `create_container` called with an empty string `name` (`""`) either succeeds with an empty/unnamed container or returns a structured error — confirm which, so this isn't a silently untested assumption (no local validation is deliberate; Firefox is the authority)
- [ ] `acquire_tab({cookieStoreId: "firefox-default"})` (a reserved, non-container Firefox store id) also returns `container_not_found` — this is a distinct check from the random-string case above, confirming reserved stores aren't mistaken for real containers
- [ ] Manually open a tab inside a container in Firefox's UI, then `acquire_tab({tabId})` (no `cookieStoreId`) to lease it — confirm the response's `cookieStoreId` correctly reflects that tab's actual container, not just the "open new tab" path
- [ ] `list_tabs()` reports the correct `cookieStoreId` for every open tab, including ordinary (non-container) tabs, which should report Firefox's default store id (e.g. `firefox-default`)

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
