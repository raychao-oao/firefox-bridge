# firefox-bridge

Lets MCP-capable CLIs (Claude Code, Codex, etc.) operate your **real, already-logged-in
Firefox tabs** — a [claude-in-chrome](https://github.com/anthropics/claude-code)-style
bridge, but for Firefox, and without any OS-level input simulation.

## Why

Browser-automation tools built on CDP/Playwright either drive a fresh, logged-out browser
instance (so they can't touch your real session) or, on Firefox, hit a known issue where
headed-mode mouse events get dispatched through the OS input layer and can hijack the real
cursor ([anthropics/claude-code#45552](https://github.com/anthropics/claude-code/issues/45552)).

firefox-bridge takes a different approach: a WebExtension that talks to your browser's own
`browser.tabs`/`browser.scripting` APIs directly, the same way `claude-in-chrome` does via
`chrome.debugger`. No simulated input, no separate browser profile — it operates the tabs
you're already using, logged into whatever you're logged into.

## Architecture

```
[MCP Server] ←(stdio)→ [CLI]
      ↕ Unix domain socket (token-authenticated)
[Native Host] ←(Native Messaging, stdio)→ [Firefox Extension] → your real tabs
```

- **Tab-lease concurrency**: multiple CLI sessions can each hold their own tab(s) without
  stepping on each other.
- **Policy gate**: every privileged operation (read, click, screenshot, ...) checks a
  user-configurable blacklist; a blacklisted site triggers a one-time confirmation popup
  (allow once / allow for session / deny) rather than silently proceeding.
- **Payload handles**: large data (screenshots) goes through a temp-file + opaque-handle
  path instead of inline in messages, keeping under the native-messaging size cap.
- **Frame-aware**: `click`/`type`/`read_page`/`list_elements` can target a specific
  `<iframe>` (discovered via `list_frames`); each frame is gated by its own blacklist
  policy independently, so an allowed top-level page can't become a path to read a
  blacklisted embedded frame.

## Tools

`navigate`, `click`, `type`, `read_page`, `list_elements`, `list_frames`, `screenshot`,
`start_console`/`get_console`, `start_network`/`get_network`, `acquire_tab`/`release_tab`,
`list_tabs`.

`list_elements` discovers real CSS selectors for interactive elements instead of guessing
blindly — each one is guaranteed to match exactly the inspected element on a follow-up
`click`/`type`.

## Install

### 1. Firefox extension

Grab the signed `.xpi` from the [latest release](https://github.com/raychao-oao/firefox-bridge/releases/latest)
and either drag it into a Firefox window, or `about:addons` → gear icon → "Install Add-on
From File...". This installs permanently (survives restarts) — unlike loading
`extension/manifest.json` as a Temporary Add-on via `about:debugging`, which Firefox wipes
every time it restarts.

To build and sign your own `.xpi` from source: get an API key/secret from
[AMO](https://addons.mozilla.org/en-US/developers/addon/api/key/), then run
```
AMO_API_KEY=... AMO_API_SECRET=... node scripts/sign-extension.js
```

### 2. Native messaging host

```
npm install
node scripts/install-native-manifest.js
```
Registers the native messaging manifest so Firefox can spawn the native host. Restart
Firefox after this and after installing the extension.

### 3. MCP server

Register with Claude Code (or any MCP-capable CLI):
```
claude mcp add firefox-bridge -s user -- node mcp-server/src/index.js
```
`-s user` makes it available in every session, not just one project. Verify with
`claude mcp list` — should show `firefox-bridge: ... - ✔ Connected` once the extension is
loaded and the native host is running.

## Development

```
npm test                                    # native-host + mcp-server unit tests
npx web-ext lint --source-dir extension     # extension manifest/lint check
```

The extension itself (`extension/*.js`) has no automated test harness — see
[`docs/manual-verification-checklist.md`](docs/manual-verification-checklist.md) for the
manual checklist to run through after changes there.

## Known limitations

- `list_tabs` isn't policy-gated yet (returns all tab URLs/titles, including blacklisted
  ones)
- Console/network capture is top-frame only, not frame-aware
- Text truncation is char-count-based, not byte-based (risk on CJK-heavy pages)
- WebMCP integration deferred to a future version

## License

[MIT](LICENSE)
