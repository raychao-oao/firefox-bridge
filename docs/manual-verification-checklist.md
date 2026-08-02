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
- [ ] `acquire_tab({url: '<一個會正常載入的網址>'})` 開新分頁，確認回應的 `url` 就是傳入的目標網址（不是 `about:blank`），且沒有 `urlPending` 欄位
- [ ] `acquire_tab({url: '<一個載入極快的本機測試頁面，例如 localhost 上的靜態 HTML>'})` 連續呼叫多次，確認沒有任何一次意外等滿 3000ms 才回應——這是驗證 use-codex review 抓到的「監聽器裝晚了、錯過快速 commit」問題的直接迴歸測試
- [ ] `acquire_tab()`（不傳 `url`）開新分頁，確認回應立刻回來（沒有等待延遲），`url` 是 `about:blank`
- [ ] `acquire_tab({url: 'about:blank'})`（明確傳入 `about:blank`，不是省略）開新分頁，確認行為跟不傳 `url` 一樣立刻回應，不觸發等待邏輯
- [ ] `acquire_tab({url: '<一個會逾時/連不上的網址，例如指向一個關掉的本機 port>'})`，確認在約 3000ms 後回應，`ok: true`，`urlPending: true`
- [ ] `acquire_tab({url: '<一個會被伺服器端 redirect 到另一個網址的網址>'})`，確認回應的 `url` 是 redirect 後的網址（可能跟傳入的 `msg.url` 不同），而不是誤報 `urlPending: true` 或回傳跟請求不一致的值——驗證「commit 不保證等於 msg.url」這個文件化的限制
- [ ] `acquire_tab({tabId: <一個已存在、目前正在導覽中的分頁 id>})`，確認立刻回應（不等待），行為跟修改前一致——這是確認範圍限定正確、沒有意外影響到 tabId 路徑的迴歸測試
- [ ] `acquire_tab({url, cookieStoreId})`（container 變體）開新分頁，確認同樣會等到導覽 commit，行為跟不帶 `cookieStoreId` 的路徑一致
- [ ] `acquire_tab({url: '<一個 Firefox 會直接拒絕的 data:/javascript: 網址，如果能構造出這種案例>'})`，確認 `browser.tabs.create` 的例外正常往外拋、變成通用的 `{ok: false, error: ...}` 回應，而不是讓監聽器/計時器卡住或讓整個呼叫掛住
- [ ] `list_tabs` returns all open tabs (id, url, title) including lease status, matching actual browser state (open a couple of tabs manually, acquire a lease on one via another tool call, and confirm list_tabs reflects both the full tab list and the correct leasedBy status)
- [ ] `navigate` to a normal (non-blacklisted) URL succeeds
- [ ] `click` on a known selector (test against a simple local HTML page) actually clicks
- [ ] `type` on an input field sets its value and fires `input`/`change` (verify via a page that echoes input state)
- [ ] 對一個沒有 `href`、點擊後不會觸發任何導覽或其他效果的連結（例如 `<a href="#">`）呼叫 `click`，確認 `navigated: false`、`dialogOpened: false`
- [ ] 對一個點擊後會觸發 `window.location.href` 導覽（不是 `<a>` 標籤，是 JS 導覽）的按鈕呼叫 `click`，確認 `navigated: true` 且 `newUrl` 是導覽後的網址
- [ ] 已知的 false negative（非 bug，勿回報）：對上一項的 JS 導覽按鈕呼叫 `click` 時，若導覽在 background 讀取 `tabAfter`（點擊後約 600ms 內）當下還沒完成、`tab.url` 尚未更新，`navigated` 可能回報 `false`。這是 `extension/background.js` `handleClick` 註解中記載、已知且可接受的限制，不需要額外用 `wait_for` 之類的機制去 poll 才能拿到最終值——若觀察到這個現象請視為預期行為，不要當成 bug 回報
- [ ] 構造一個點擊後會同步呼叫 `window.confirm(...)` 的測試頁面（`onclick="confirm('...')"`），呼叫 `click`，確認在約 600ms 內收到回應且 `dialogOpened: true`（不是整個 MCP 呼叫卡住等到對話框被關掉才回應）——這是驗證本設計核心假設的關鍵測試，之後手動在 Firefox 視窗上把測試用的 `confirm()` 對話框關掉，確認擴充功能沒有崩潰或留下無法清除的狀態
- [ ] 對一個完全正常、沒有任何對話框的按鈕連續呼叫 `click` 多次（例如 10 次），確認沒有任何一次被誤判成 `dialogOpened: true`——驗證 background 600ms 逾時跟 content-script 300ms 觀察窗之間的緩衝夠用，不會被正常的訊息往返延遲誤觸發
- [ ] 對一個點擊後會用 `element.textContent = ...`、`element.appendChild(...)` 等方式改動 DOM 的按鈕呼叫 `click`，確認 `domChanged: true`
- [ ] 對一個點擊後完全沒有任何後續效果（一個 `<div>` 只有 `cursor:pointer` 沒有任何 handler）的元素呼叫 `click`，確認四個欄位都反映「什麼都沒發生」（`navigated: false`、`dialogOpened: false`、`domChanged: false`）
- [ ] `wait_for({selector})` 對一個目前不存在、但 2 秒後會被 JS 動態插入的元素呼叫，確認在插入後立即返回 `matched: true`、`timedOut: false`，而不是等到 `timeoutMs` 上限
- [ ] `wait_for({selector})` 對一個永遠不會出現的 selector 呼叫（`timeoutMs: 1000`），確認在約 1 秒後返回 `matched: false`、`timedOut: true`，不是拋出例外或永遠 pending
- [ ] `wait_for({textGone})` 對一個目前顯示「載入中...」、稍後會被替換掉的頁面呼叫，確認文字消失後立即返回
- [ ] `wait_for({networkIdle: true})` 對一個會連續發出幾個 XHR/fetch 請求、之後安靜下來的頁面呼叫，確認在最後一個請求完成後的安靜視窗內返回，而不是提早在請求還在進行時返回——且不需要先呼叫 `start_network`（驗證這批改用的獨立 listener，不依賴既有訂閱）
- [ ] `wait_for` 同時傳 `selector` 和 `textGone`（或三個條件都不傳）呼叫，確認回傳 `invalid_wait_condition`
- [ ] `wait_for({selector: ''})`（空字串）或 `wait_for({networkIdle: false})` 呼叫，確認都回傳 `invalid_wait_condition`，不是被誤判成「有效條件」（`use-codex` review 發現的驗證邏輯漏洞——空字串跟 `networkIdle: false` 都必須被當成「沒設」，不是「設了但值是空/false」）
- [ ] 在一個有 iframe 的頁面上，`wait_for({selector})` 不傳 `frameId` 呼叫，確認走的是單一 frame（top frame）路徑、回傳 `{matched, timedOut}` 形狀，而不是意外落入 `read_page`/`list_elements` 的多 frame 聚合路徑回傳 `{frames: [...]}`（`use-codex` review 抓到的唯一一個確定性 bug，這是它的直接迴歸測試）
- [ ] 同時對同一個 tab 發起兩個 `wait_for({networkIdle: true})` 呼叫（例如兩個平行的 MCP 呼叫），確認兩者各自獨立正確運作，不會互相干擾或提早釋放彼此的計時
- [ ] 對一個有請求失敗（如 404）或請求長時間掛著不結束的頁面呼叫 `wait_for({networkIdle: true})`，確認理解並接受這個已知限制：只追蹤 `onCompleted`，一個掛著不結束的請求不會被算進「還在忙」，可能提早回報 `matched: true`
- [ ] 呼叫 `wait_for({networkIdle: true})` 後立刻切到背景分頁（不切回來），確認呼叫本身不會掛住或崩潰，會在 `timeoutMs` 內以某種方式結束（`matched` 或 `timedOut`）
- [ ] 呼叫 `wait_for` 後在等待期間手動關閉該分頁，確認整個 MCP server 不會崩潰或掛住，呼叫最終有某種方式結束（可能回傳錯誤，也可能等到 timeout——不要求特定行為，只確認不是永遠 pending 或讓 server 掛掉）
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
- [ ] `list_elements` on a page with fewer candidates than `MAX_ELEMENTS` (300) but with some hidden/detached elements filtered out — `truncated` reports `false` (regression guard: previously always reported `true` whenever any element was filtered, not just when the 300-cap was actually hit)
- [ ] `list_elements` on a page with more than 300 candidate elements — `truncated` reports `true`, and `elements.length === 300`
- [ ] `list_elements` on a custom checkbox built as `<div role="checkbox" aria-checked="true">` (no native `<input>`) — the element now appears in the results at all (regression guard: `CANDIDATE_SELECTOR` previously never matched `role="checkbox"`/`role="radio"`/`role="switch"`, so `state.ariaChecked` was documented but unreachable), and `state.ariaChecked === "true"`
- [ ] Same check with `role="radio"` and `role="switch"` elements — both now appear in `list_elements` results

### Filter and domEpoch
- [ ] `list_elements({filter: {text: '<某個已知元素的 label 子字串>'}})`，確認只回傳 label 包含該子字串的元素（大小寫不敏感——用一個大小寫不同的子字串再測一次）
- [ ] `list_elements({filter: {text: '<一個只出現在某元素 label 第 100 個字元之後的子字串，需要構造一個 label 很長的測試元素>'}})`，確認該元素被正確匹配到——驗證 filter 比對的是完整 label，不是已經截斷成 100 字元的 `text` 欄位
- [ ] `list_elements({filter: {tag: 'input', type: 'checkbox'}})`，確認只回傳 checkbox 類型的 input，其他 tag/type 都被排除
- [ ] `list_elements({filter: {text: '', tag: '', type: ''}})`，確認行為跟完全不傳 `filter` 的 `list_elements()` 一致——空字串應被視為「沒有限制條件」，不是「什麼都不匹配」
- [ ] `list_elements({filter: {container: '<一個已知只包含少數幾個元素的容器 selector>', text: '<容器內某元素 label 的子字串>'}})`（container 與 text 同時給），確認只回傳「同時滿足在容器內、且 label 符合 text」的元素——驗證 container 也正確參與 AND 組合，不是只有 text/tag/type 三者之間才有 AND 邏輯
- [ ] `list_elements({filter: {container: '<一個已知只包含少數幾個元素的容器 selector>'}})`，確認只回傳該容器底下的元素，容器外的元素（即使同樣符合 `CANDIDATE_SELECTOR`）不出現；如果容器元素本身也符合 `CANDIDATE_SELECTOR`（例如容器剛好是個 `<a>`），確認容器本身不算在結果裡，只有它「底下」的子孫算
- [ ] `list_elements({filter: {container: '<一個合法 CSS 語法、但確定目前頁面上不存在的 selector，例如 "#definitely-not-here">'}})`，確認回傳空結果，不是錯誤（實際形狀依有沒有帶 `frameId` 而不同：帶 `frameId` 時是 `{ok: true, elements: []}`；不帶時是 `{ok: true, frames: [{..., elements: [], totalCandidates: 0}]}`——兩種情境都測一次）
- [ ] `list_elements({filter: {container: '<一個語法上就不合法的 CSS selector，例如 ">>>invalid<<<">'}})`，確認回傳結構化錯誤，不是未處理的例外或讓整個呼叫掛掉（實際形狀依有沒有帶 `frameId` 而不同：帶 `frameId` 時是頂層 `{ok: false, error: 'invalid_container_selector'}`；不帶時整體呼叫仍是 `ok: true`，錯誤出現在該 frame 對應的 `frameErrors[]` 項目裡——兩種情境都測一次）
- [ ] 在一個候選元素數量明顯超過 300 的頁面，用 `filter` 縮小到一個已知在候選清單「後段」的元素（不加 filter 時會被 300 上限砍掉），確認加了 filter 後這個元素出現在結果裡——驗證 filter 是在候選階段生效、且在 `MAX_ELEMENTS` 判斷之前
- [ ] 同一個 `list_elements` 呼叫兩次（沒有中間發生導覽），確認兩次回傳的 `domEpoch` 相同
- [ ] 呼叫 `list_elements` → `navigate` 到另一個網址 → 再呼叫 `list_elements`，確認前後兩次 `domEpoch` 不同
- [ ] 在一個有 iframe 的頁面上呼叫 `list_elements`（不傳 `frameId`，多 frame 聚合模式），確認每個 frame 各自回傳自己的 `domEpoch`，而且彼此不同
- [ ] 對一個頁面呼叫 `list_elements` 拿到 `domEpoch`，在該分頁上用瀏覽器的「上一頁」導覽出去再導覽回來（觸發 bfcache 復原，不是重新整理），確認 `domEpoch` 有換新值
- [ ] 用第一次 `list_elements` 拿到的 `domEpoch`（連同某個 selector）在 `navigate` 之後呼叫 `click({selector, expectedDomEpoch: <舊值>, frameId: <對應的 frameId>})`，確認回傳 `stale_selector`，且對應元素**沒有**被點擊到
- [ ] 同樣情境但呼叫 `click({selector})`（不傳 `expectedDomEpoch`），確認行為跟修改前一致（不會是 `stale_selector`）
- [ ] 用當下正確的 `domEpoch` 呼叫 `click({selector, expectedDomEpoch: <正確值>, frameId: <對應的 frameId>})`，確認正常執行，不被誤判成 stale
- [ ] `type` 比照上面兩項 `click` 的測試（正確 epoch 正常執行、錯誤 epoch 回傳 `stale_selector` 且不設值）

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
