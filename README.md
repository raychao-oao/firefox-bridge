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
      ↕ Unix domain socket / Windows named pipe (token-authenticated)
[Native Host] ←(Native Messaging, stdio)→ [Firefox Extension] → your real tabs
```

- **Tab-lease concurrency**: multiple CLI sessions can each hold their own tab(s) without
  stepping on each other.
- **Policy gate**: every privileged operation (read, click, screenshot, ...) checks a
  user-configurable blacklist; a blacklisted site triggers a one-time confirmation popup
  (allow once / allow for session / deny) rather than silently proceeding.
- **Payload handles**: large data (screenshots) goes through a temp-file + opaque-handle
  path instead of inline in messages, keeping under the native-messaging size cap.
  `screenshot` itself writes the captured PNG to a local file and returns its absolute
  path — read the file directly rather than expecting image bytes in the tool response.
  Pass `fullPage: true` to capture the entire scrollable page in one shot instead of just
  the current viewport.
- **Frame-aware**: `click`/`type`/`select_option`/`read_page`/`list_elements`/`scroll_to`/
  `hover`/`upload_file`/`drag_and_drop`/`press_key` can target a specific `<iframe>` (discovered
  via `list_frames`); each frame is gated by its own blacklist policy independently, so an
  allowed top-level page can't become a path to read a blacklisted embedded frame.

## Tools

`navigate`, `click`, `type`, `select_option`, `read_page`, `read_article`, `list_elements`, `list_frames`, `screenshot`,
`scroll_to`, `press_key`, `hover`, `drag_and_drop`, `upload_file`, `start_console`/`get_console`, `start_network`/`get_network`,
`acquire_tab`/`release_tab`, `open_private_window`, `close_tab`, `discard_tab`, `go_back`, `go_forward`, `list_tabs`,
`search_history`, `add_bookmark`, `list_bookmarks`, `search_bookmarks`, `to_be_deleted`,
`list_containers`, `create_container`, `wait_for`, `list_dialogs`, `respond_dialog`,
`add_dialog_whitelist`, `remove_dialog_whitelist`, `request_tab_selection`, `get_tab_selection`.

`list_elements` discovers real CSS selectors for interactive elements instead of guessing
blindly — each one is guaranteed to match exactly the inspected element on a follow-up
`click`/`type`.

`list_tabs` also returns each tab's `index` (0-based position in its own window's tab
order) and `active` (true for the one active tab per window), plus a top-level
`focusedWindowId` (`null` whenever Firefox itself lacks OS focus) — enough to identify
"the tab the user is currently looking at" without asking. When that still isn't enough to
tell two candidate tabs apart (e.g. the same URL open twice in the same window and
container), call `request_tab_selection` with a `reason`; it returns immediately with a
`requestId` and shows a pending-count badge on the toolbar button. The user right-clicks
whichever tab they mean and picks it from the "Firefox Bridge" submenu in Firefox's tab
context menu (one row per pending request, labelled with its `reason`). Poll
`get_tab_selection(requestId)` for the result — `resolved` (with the chosen `tabId`),
`timedOut` (after 120s), or `uiUnavailable` (the menu itself failed to render); a terminal
status is delivered at most once. The toolbar button and badge only ever show a pending
count — they aren't clickable to resolve a request.

`click` returns an effect summary (`navigated`, `dialogOpened`, `domChanged`, `newUrl`) so
an agent can tell what happened without a separate `read_page` round-trip. `ok: true` only
means the click event was dispatched — it is not a guarantee that the effect you expected
actually happened (e.g. a JS-initiated navigation may not be reflected in `navigated` yet;
see `wait_for` for polling a page to a target state).

## Install

### 1. Firefox extension

Grab the signed `.xpi` from the [latest release](https://github.com/raychao-oao/firefox-bridge/releases/latest)
and either drag it into a Firefox window, or `about:addons` → gear icon → "Install Add-on
From File...". This installs permanently (survives restarts) — unlike loading
`extension/manifest.json` as a Temporary Add-on via `about:debugging`, which Firefox wipes
every time it restarts.

To build and sign your own `.xpi` from source: get an API key/secret from
[AMO](https://addons.mozilla.org/en-US/developers/addon/api/key/), then either export them and
run
```
AMO_API_KEY=... AMO_API_SECRET=... npm run sign
```
or put them in a repo-root `.env` file (already gitignored) — `AMO_API_KEY=...` /
`AMO_API_SECRET=...`, one per line — and just run `npm run sign`; the script loads `.env`
automatically if present. (`npm run sign` is equivalent to `node scripts/sign-extension.js`
directly, just shorter to remember/re-run after each change to `extension/`.)

### 2. Native messaging host

```
npm install
node scripts/install-native-manifest.js
```
Registers the native messaging manifest so Firefox can spawn the native host. Restart
Firefox after this and after installing the extension.

On Windows, the installer creates a `.cmd` launcher and registers the manifest under
`HKCU\Software\Mozilla\NativeMessagingHosts`, so administrator rights are not required.

### 3. MCP server

Register with Claude Code (or any MCP-capable CLI):
```
claude mcp add firefox-bridge -s user -- node mcp-server/src/index.js
```
`-s user` makes it available in every session, not just one project. Verify with
`claude mcp list` — should show `firefox-bridge: ... - ✔ Connected` once the extension is
loaded and the native host is running.

**Codex CLI:**
```
codex mcp add firefox-bridge -- node /absolute/path/to/firefox-bridge/repo/mcp-server/src/index.js
```

**agy (Antigravity CLI), macOS/Linux:** no `mcp add` subcommand exists — edit
`~/.gemini/config/mcp_config.json` directly:
```json
{
  "mcpServers": {
    "firefox-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/firefox-bridge/repo/mcp-server/src/index.js"]
    }
  }
}
```

Replace `/absolute/path/to/firefox-bridge/repo` with this repo's actual location on your
machine (run `pwd` from inside `repo/` to get it) in all three examples above.

### 4. firefox-bridge-bot MCP server (optional, separate registration)

`firefox-bridge-bot` is a **second, independent** MCP server, not a feature of the main
`firefox-bridge` server above. It runs fast, deterministic "combo scripts" over the same
Firefox bridge — a script does a whole multi-step job (e.g. open a private window, visit
several URLs, extract each page's content, close the window) in one tool call with no AI
judgment mid-script, in contrast to `firefox-bridge`'s step-by-step tools, where the calling
model decides what to do next after every step. It must be registered separately from
`firefox-bridge` — both can be enabled at once, or just one:
```
claude mcp add firefox-bridge-bot -s user -- node /absolute/path/to/firefox-bridge/repo/firefox-bridge-bot/index.js
```
Replace `/absolute/path/to/firefox-bridge/repo` with this repo's actual location on your
machine (run `pwd` from inside `repo/` to get it). Unlike some other `claude mcp add`
invocations, a relative path here gets stored verbatim rather than resolved automatically —
if the MCP server ever fails to start, an unresolved relative path is the first thing to
check.

Same pattern for Codex CLI (`codex mcp add firefox-bridge-bot -- node
/absolute/path/to/firefox-bridge/repo/firefox-bridge-bot/index.js`) and agy on macOS/Linux
(add a second entry alongside `firefox-bridge` in `~/.gemini/config/mcp_config.json`'s
`mcpServers`, pointing `args` at
`/absolute/path/to/firefox-bridge/repo/firefox-bridge-bot/index.js` instead).

Currently ships one tool: `read_url_fast` — reads up to 10 URLs' content in a single call.

`scripts/` is extensible: any file exported with `{name, description, inputSchema, run}`
is auto-registered as its own MCP tool at startup. The intended workflow is to prove a
multi-step path works via live `firefox-bridge` interaction first, then encode that
winning path as a script here so future runs skip the AI-judgment cost. Not every
`firefox-bridge` action is wired into a script's `bridge` object yet — see the
Known limitations section below.

### Windows

firefox-bridge supports Windows natively: Firefox and the native messaging host run on
Windows, and any of the three client types below can connect to the MCP server.

**Prerequisite for all three:** keep the repo in a Windows-visible path (e.g.
`C:\Users\<WindowsUser>\Documents\Codex\firefox-bridge`), then from Windows
PowerShell/cmd:

```powershell
cd C:\Users\<WindowsUser>\Documents\Codex\firefox-bridge
npm ci
node scripts/install-native-manifest.js
```

This creates the `.cmd` launcher and the `HKCU` native-messaging registration described
above. Restart Firefox and load the extension.

#### WSL CLI clients

From inside WSL, per CLI:

**Codex:**
```bash
codex mcp add firefox-bridge -- \
  "/mnt/c/Program Files/nodejs/node.exe" \
  'C:\Users\<WindowsUser>\Documents\Codex\firefox-bridge\mcp-server\src\index.js'
```

**Claude Code:**
```bash
claude mcp add firefox-bridge -s user -- \
  "/mnt/c/Program Files/nodejs/node.exe" \
  "C:\Users\<WindowsUser>\Documents\Codex\firefox-bridge\mcp-server\src\index.js"
```

**agy (Antigravity CLI):** no `mcp add` subcommand exists — edit
`~/.gemini/config/mcp_config.json` directly:
```json
{
  "mcpServers": {
    "firefox-bridge": {
      "command": "/mnt/c/Program Files/nodejs/node.exe",
      "args": ["C:\\Users\\<WindowsUser>\\Documents\\Codex\\firefox-bridge\\mcp-server\\src\\index.js"]
    }
  }
}
```

All three point at the same Windows `node.exe` and the same Windows path to
`mcp-server/src/index.js` — the MCP server and the Windows native host must share the
same Windows runtime directory so both sides derive the same named-pipe path and read the
same token file.

#### Claude Desktop (Windows native app)

Edit `%APPDATA%\Claude\claude_desktop_config.json` directly:

```json
{
  "mcpServers": {
    "firefox-bridge": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\Users\\<WindowsUser>\\Documents\\Codex\\firefox-bridge\\mcp-server\\src\\index.js"]
    }
  }
}
```

Restart Claude Desktop. (MSIX/Microsoft-Store installs of Claude Desktop put this file at
a different `Packages\Claude_*\LocalCache\Roaming\Claude\` path instead.)

#### Codex Desktop App (Windows native app)

Shares `%USERPROFILE%\.codex\config.toml` with Codex CLI. Confirm the `[desktop]` section
contains:

```toml
[desktop]
runCodexInWindowsSubsystemForLinux = false
integratedTerminalShell = "powershell"
```

Keep any other existing keys in `[desktop]` — only add/edit these two.
`runCodexInWindowsSubsystemForLinux = false` is required so Codex Desktop runs natively on
Windows (not inside WSL) and can reach the Windows-native host over the same named pipe.

Then add or update the MCP server entry in the same file:

```toml
[mcp_servers.firefox-bridge]
command = 'C:\Program Files\nodejs\node.exe'
args = ['C:\Users\<WindowsUser>\Documents\Codex\firefox-bridge\mcp-server\src\index.js']
```

Only one `[mcp_servers.firefox-bridge]` section may exist — replace `command`/`args` in
place if it's already there. After saving: fully quit Codex Desktop App, confirm Firefox
is running with the extension enabled, relaunch, and verify with a `list_tabs` call.

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
- `search_history` isn't policy-gated either — history results include blacklisted sites (deliberate for now, see the history-search design spec)
- `add_bookmark`/`list_bookmarks`/`search_bookmarks` aren't policy-gated either, and results
  aren't filtered for blacklisted sites — same deliberate reasoning as `search_history` (see
  the bookmarks design spec)
- `to_be_deleted` never permanently deletes anything — it only moves items into a
  fixed "Pending Deletion" folder. There is no tool to empty that folder or to truly delete
  bookmarks; that step is always manual, in Firefox's own bookmark manager (deliberate, see
  the bookmark-cleanup design spec)
- Multi-Account Container support (`list_containers`/`create_container`/`acquire_tab`'s
  `cookieStoreId`) is read + create only — there is no tool to delete or modify a container.
  Deleting a container is deliberately out of scope for now: Firefox's own
  `contextualIdentities.remove()` does not close the container's open tabs, which would need
  extra design work this batch didn't need to do (see the containers design spec)
- `list_containers`/`create_container` aren't policy-gated either — opening a tab inside a
  container via `acquire_tab`'s `cookieStoreId` gives the agent that container's logged-in
  session, and the URL blacklist remains the only control surface; there is no separate
  per-container opt-out
- `discard_tab` isn't policy-gated and doesn't require a lease — any session can unload any
  tab in any window, including tabs no session has acquired (deliberate; that's the primary
  use case)
- `open_private_window` requires the user to manually enable "Run in Private Windows" for
  this extension in `about:addons` first — Firefox gives extensions no API to do this
  themselves. Without it, the call fails outright with `private_window_access_denied`; no
  window is created. The same toggle also gates visibility, not just action: without it,
  `list_tabs` can't see private tabs at all — they're omitted from the list entirely, not
  merely present-but-unreachable — so an absence of `incognito: true` entries doesn't mean
  no private tabs are open, and `acquire_tab`'s `windowId` can't target a private window
  either, reporting `window_not_found` rather than a private-specific error
- `list_dialogs`/`respond_dialog` dialog state is shared across all connected MCP
  sessions, not scoped per-session — `DialogServer` has no tab/session concept by design
  (see the dialog-interception design spec's "Why no tabId" section), so a whitelisted
  hostname's dialogs are visible/answerable by any connected session, not only the one
  whose leased tab triggered the dialog. `add_dialog_whitelist` cross-checks the existing
  navigation blacklist and refuses (`{ ok: false, error: 'blacklisted' }`) to whitelist a
  hostname that's already blacklisted there
- Console/network capture is top-frame only, not frame-aware
- Text truncation is char-count-based, not byte-based (risk on CJK-heavy pages)
- WebMCP integration deferred to a future version
- The toolbar button added for `request_tab_selection` uses Firefox's generic
  puzzle-piece icon — no dedicated icon asset was designed for this feature
- `firefox-bridge-bot`'s scripts don't have `screenshot` or `upload_file` available on
  their `bridge` object yet, even though both exist on the main `firefox-bridge` server —
  wiring them in is a `firefox-bridge-bot/lib/bridge.js` change, not just a new script
- `firefox-bridge-bot` has no automated tests and no manual verification checklist file
  (unlike the main extension's `docs/manual-verification-checklist.md`) — verifying a new
  or changed script is currently ad hoc

## License

[MIT](LICENSE)
