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
- [ ] `screenshot` returns base64 PNG bytes that decode to a valid image
- [ ] `screenshot` of a large/retina full-page capture (>1 MiB PNG) still succeeds — this exercises the multi-chunk native-messaging path
- [ ] `start_console` + a page `console.log(...)` + `get_console` returns that message
- [ ] `get_console` / `get_network` before their `start_*` call returns `not_subscribed` (not an empty list)
- [ ] `start_network` *then* `navigate` — `get_network` includes the page-load requests (traffic before `start_network` is not captured, by design)
- [ ] `get_network` returns observed requests for that tab only (open a second leased tab making different requests, confirm no cross-tab leakage)
- [ ] `release_tab` then `acquire_tab` from a second simulated session on the same `tabId` succeeds (no stale conflict)
- [ ] `release_tab` on a tab this session does NOT own returns `conflict`/`not_leased` rather than silently succeeding
- [ ] After `release_tab` + re-`acquire_tab` by a second session, `get_console`/`get_network` return `not_subscribed` — no leftover data from the first session

## Policy gate / blacklist
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
