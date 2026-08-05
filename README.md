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
- **Frame-aware**: `click`/`type`/`read_page`/`list_elements`/`scroll_to`/`hover`/
  `upload_file`/`drag_and_drop`/`press_key` can target a specific `<iframe>` (discovered
  via `list_frames`); each frame is gated by its own blacklist policy independently, so an
  allowed top-level page can't become a path to read a blacklisted embedded frame.

## Tools

`navigate`, `click`, `type`, `read_page`, `list_elements`, `list_frames`, `screenshot`,
`scroll_to`, `press_key`, `hover`, `drag_and_drop`, `upload_file`, `start_console`/`get_console`, `start_network`/`get_network`,
`acquire_tab`/`release_tab`, `close_tab`, `go_back`, `go_forward`, `list_tabs`,
`search_history`, `add_bookmark`, `list_bookmarks`, `search_bookmarks`, `to_be_deleted`,
`list_containers`, `create_container`, `wait_for`.

`list_elements` discovers real CSS selectors for interactive elements instead of guessing
blindly — each one is guaranteed to match exactly the inspected element on a follow-up
`click`/`type`.

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
- Console/network capture is top-frame only, not frame-aware
- Text truncation is char-count-based, not byte-based (risk on CJK-heavy pages)
- WebMCP integration deferred to a future version

## License

[MIT](LICENSE)
