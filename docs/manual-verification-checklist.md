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
- [ ] `type` on an input field that already has existing text confirms the existing text is fully replaced (not appended to) — matches the tool description's "ALWAYS overwrites" claim
- [ ] 對一個沒有 `href`、點擊後不會觸發任何導覽或其他效果的連結（例如 `<a href="#">`）呼叫 `click`，確認 `navigated: false`、`dialogOpened: false`
- [ ] 對一個點擊後會觸發 `window.location.href` 導覽（不是 `<a>` 標籤，是 JS 導覽）的按鈕呼叫 `click`，確認 `navigated: true` 且 `newUrl` 是導覽後的網址
- [ ] 已知的 false negative（非 bug，勿回報）：對上一項的 JS 導覽按鈕呼叫 `click` 時，若導覽在 background 讀取 `tabAfter`（點擊後約 600ms 內）當下還沒完成、`tab.url` 尚未更新，`navigated` 可能回報 `false`。這是 `extension/background.js` `handleClick` 註解中記載、已知且可接受的限制，不需要額外用 `wait_for` 之類的機制去 poll 才能拿到最終值——若觀察到這個現象請視為預期行為，不要當成 bug 回報
- [ ] 構造一個點擊後會同步呼叫 `window.confirm(...)` 的測試頁面（`onclick="confirm('...')"`），呼叫 `click`，確認在約 600ms 內收到回應且 `dialogOpened: true`（不是整個 MCP 呼叫卡住等到對話框被關掉才回應）——這是驗證本設計核心假設的關鍵測試，之後手動在 Firefox 視窗上把測試用的 `confirm()` 對話框關掉，確認擴充功能沒有崩潰或留下無法清除的狀態
- [ ] 對一個完全正常、沒有任何對話框的按鈕連續呼叫 `click` 多次（例如 10 次），確認沒有任何一次被誤判成 `dialogOpened: true`——驗證 background 600ms 逾時跟 content-script 300ms 觀察窗之間的緩衝夠用，不會被正常的訊息往返延遲誤觸發
- [ ] **背景分頁迴歸測試（真實踩到過的 bug，不是假設情境）**：對一個目前不是使用者正在看的分頁（切到別的分頁、分頁失焦、或整個 Firefox 視窗失焦——例如把焦點切到別的應用程式）呼叫 `click`（一個沒有對話框、完全正常的按鈕），連續呼叫至少 5 次，確認沒有任何一次誤判 `dialogOpened: true`。背景：Firefox 對非可見分頁的 `setTimeout` 有節流（實測 content-script 自己的 300ms 計時器在背景分頁會延遲到 1000ms+ 才觸發），這曾經讓幾乎每一次對背景分頁的 `click` 都誤報 `dialogOpened: true`（點擊其實成功了，`read_page` 可證實 DOM 真的變了）——修法是 `handleClick` 讀 `tabBefore.active` 跟該分頁所在視窗的 `focused` 狀態（`browser.windows.get`）動態調整逾時（分頁可見時 600ms、其餘情況 3000ms）。**特別要測「分頁本身是 active，但整個 Firefox 視窗沒有 OS focus」這個情境**（例如切到其他應用程式，不是切到 Firefox 裡的另一個分頁）——這是 use-codex review 抓到的落差：只看 `tab.active` 不夠，那只代表「這個視窗裡被選中的分頁」，不代表使用者真的在看這個視窗
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
- [ ] 在一個有 iframe 的頁面，用 `list_elements`（不傳 `frameId`，多 frame 聚合模式）拿到一個只存在於 iframe 裡的元素的 selector 跟 `frameId`，接著呼叫 `click({selector})`（**不傳** `frameId`），確認點擊成功——這是這次修復的核心迴歸測試
- [ ] 同樣情境但呼叫 `click({selector, frameId})`（**有傳**正確的 `frameId`），確認行為不變、一樣成功
- [ ] 對一個只存在於 top frame（frame 0）的元素呼叫 `click({selector})`（不傳 `frameId`），確認第一次嘗試就成功、耗時量級跟修改前相近（不需要跨 frame 搜尋）
- [ ] 對一個確定在任何 frame 都不存在的 selector 呼叫 `click({selector})`，確認最終回傳 `element_not_found`（不是卡住或拋出未預期例外）
- [ ] 在一個有多個（3 個以上）iframe、但沒有任何對話框的頁面，對一個只存在於「最後一個」被搜尋到的 frame 的元素呼叫 `click({selector})`（不傳 `frameId`），確認回應的 `dialogOpened` 是 `false`——這是驗證整個搜尋共用一個 timeout 這個 bug 已修好的直接迴歸測試：如果這個 bug 還在，多個 frame 依序嘗試的總耗時很可能超過 600ms，錯誤回報 `dialogOpened: true`
- [ ] 構造一個會同步呼叫 `window.confirm(...)` 的按鈕，放在**非 frame 0** 的某個 iframe 裡，用該按鈕的 selector 呼叫 `click({selector})`（不傳 `frameId`），確認最終回應 `dialogOpened: true`（驗證「每個 frame 各自 race」的機制對非 frame-0 的情況一樣有效）
- [ ] 構造一個超過 `FRAME_SEARCH_CAP`（20）個 iframe、目標元素確定不在前 20 個裡的頁面（如果能構造出這種測試頁），確認呼叫不會因為過多 frame 而無限期變慢或掛住，且最終回應包含 `frameSearchIncomplete: true`（驗證達到上限也算不窮盡，不是只有 policy 擋下才算）
- [ ] 對一個目標元素位於「這個 session 沒有權限存取（黑名單擋下）」的 iframe 裡的頁面呼叫 `click({selector})`（不傳 `frameId`），確認最終回應包含 `frameSearchIncomplete: true`，不是誤導性地暗示「窮盡搜尋後真的找不到」
- [ ] 構造一個「frame 0 的 content script 需要重新注入（例如剛過 reload、還沒收到過任何訊息）而導致明顯延遲」的情境，觀察 `dialogOpened: true` 是否可能在沒有任何對話框的情況下出現——這是驗證「timeout 不是 el.click() 已派送的證明，只是 best-effort 推測」這個限制確實存在、且已經在文件/描述裡誠實揭露，不是要求修掉它（這輪的設計選擇是接受這個已知的不確定性，不引入新機制去消除它）
- [ ] `type` 比照上面「iframe 元素成功」「frameId 不變」「element_not_found」三項 `click` 的測試
- [ ] 對一個 iframe 元素呼叫 `click({selector, expectedDomEpoch: <該 iframe 的 domEpoch>})`（不傳 `frameId`），確認 `stale_selector`/`domEpoch` 相關邏輯在跨 frame 搜尋出的正確 frame 上正常運作（即 `expectedDomEpoch` 是跟「實際找到元素的那個 frame」比對，不是跟 frame 0 比對）——這是驗證 `stale_selector` 也要觸發搜尋這個修正的直接迴歸測試
- [ ] `navigate` 到另一個網址（讓所有 frame 的 `domEpoch` 都換新），用舊的、已經不對應任何 frame 的 `expectedDomEpoch` 呼叫 `click({selector})`（不傳 `frameId`），確認最終回傳 `stale_selector`（不是誤判成 `element_not_found`，也不是卡在某個中間狀態）
- [ ] `wait_for` 對一個只存在於 iframe 的 selector、不傳 `frameId` 呼叫，確認行為維持不變（`timedOut: true`，因為 `wait_for` 明確不在這輪修復範圍內）——這是確認範圍限定正確的迴歸測試

### Frames (`content_scripts` is `all_frames: true`)
- [ ] `list_frames` on a page with no iframes returns exactly one frame (`frameId: 0`)
- [ ] `list_frames` on a page with a nested `<iframe><iframe>...` returns every frame with correct `parentFrameId` chains
- [ ] `read_page` / `list_elements` with no `frameId` on a page WITH iframes returns `{frames: [...], frameErrors: [...]}` grouped per frame, not a single merged blob — content that only exists inside an iframe (e.g. a settings panel embedded via `<iframe>`) shows up under its own frame entry
- [ ] `read_page` / `list_elements` with an explicit `frameId` returns that one frame's content in the pre-frame-work flat shape (no `frames` wrapper)
- [ ] `click` / `type` with an explicit non-zero `frameId` hits the element inside that iframe, not a same-selector match in the top frame
- [ ] `click` / `type` with `frameId` omitted defaults to the top frame (0) — does NOT reach into iframes
- [ ] A blacklisted URL loaded inside an iframe (top-level page itself NOT blacklisted) still triggers the confirmation gate when that specific frame is read/clicked — the top-level page being allowed must not leak the embedded frame
- [ ] An unreachable frame (e.g. `about:blank`, or one blocked by host permissions) appears in `frameErrors` with a real per-frame error, and does NOT fail the whole aggregate `read_page`/`list_elements` call for the other frames
- [ ] `screenshot` returns `{ok: true, path: "<absolute path>"}`; opening that file confirms it decodes to a valid PNG image
- [ ] `screenshot` of a large/retina full-page capture (>1 MiB PNG) still succeeds — this exercises the multi-chunk native-messaging path internally, even though the final tool response is now just a short file path
- [ ] 對一個已知內容的分頁呼叫 `screenshot({tabId})`，確認回應是 `{ok: true, path: "<絕對路徑>"}`，不是一大包 base64 文字
- [ ] 用回傳的路徑實際開啟該檔案（例如用 Claude Code 的 `Read` 工具，或直接用系統的圖片檢視器），確認內容是該分頁當下畫面的正確截圖
- [ ] 連續對同一個分頁呼叫 `screenshot` 兩次，確認兩次回傳的路徑不同（檔名不會撞在一起），且兩個檔案都存在、內容分別對應各自呼叫當下的畫面
- [ ] 確認 `SCREENSHOT_DIR`（`os.tmpdir()/firefox-bridge-screenshots`）在檔案系統上被建立，且權限合理（不是對所有使用者可讀寫）
- [ ] 對一個不存在的 `tabId`（或沒有 lease 的分頁）呼叫 `screenshot`，確認既有的錯誤處理路徑不變（回傳原本的結構化錯誤，不會嘗試寫入任何檔案）
- [ ] 用某種方式讓檔案寫入失敗（例如暫時把 `SCREENSHOT_DIR` 所在的磁碟設成唯讀，或用權限阻擋寫入），確認回傳 `{ok: false, error: 'screenshot_file_write_failed: ...'}`，不是未處理的例外讓整個 MCP 呼叫掛掉；確認沒有殘留 `.tmp` 檔案卡在目錄裡
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
- [ ] `to_be_deleted` called with `target` giving both `id` and `folder`, or neither, or an empty/whitespace-only string for either — all return `invalid_target`
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

### Viewport tools (scroll_to, screenshot fullPage, list_elements tr/th)

- [ ] On a page taller than the viewport, call `screenshot({fullPage: true})` and confirm the image includes content that was below the fold, uncropped
- [ ] On the same page, call `screenshot({fullPage: false})` (or omit `fullPage`) and confirm behavior is unchanged from before this batch — only the current viewport is captured
- [ ] On a page constructed to exceed 32767px in one dimension, call `screenshot({fullPage: true})` and confirm it returns `screenshot_too_large` rather than throwing or returning a corrupt image
- [ ] Use `list_elements` to find the selector of a `<tr>` currently scrolled out of view, and confirm it appears in the candidate list (verifies `tr` was added to `CANDIDATE_SELECTOR`)
- [ ] Call `scroll_to` with the selector from the previous step, and confirm the element is now within the visible viewport (cross-check with `screenshot({fullPage: false})` before/after, or `read_page`/`list_elements`)
- [ ] Call `scroll_to` with a selector that matches nothing, and confirm it returns `element_not_found`
- [ ] On a page with more than 300 interactive elements (e.g. a link-heavy homepage), call `list_elements` and confirm `truncated: true` when the cap is actually hit
- [ ] Call `list_elements` with an explicit `frameId` and again with `frameId` omitted (aggregate mode), and confirm both response shapes are correct in each mode

### Interaction gaps (press_key, hover, drag_and_drop, upload_file)

- [ ] `press_key` with a `selector` targeting a real input, key `"Enter"` -- confirm any JS keydown/keyup listener on that field fires (e.g. a search box that submits on Enter via JS, not native form submission)
- [ ] `press_key` with no `selector`, key `"Escape"`, on a page with a DOM-based (div+CSS) modal that closes via a JS keydown listener -- confirm it closes
- [ ] `press_key` with `modifiers: {ctrl: true}` (or similar) on a page with a keyboard shortcut bound to that combination -- confirm the shortcut fires
- [ ] `press_key` with a `selector` that matches nothing -- confirm `element_not_found`
- [ ] `hover` on an element whose dropdown/tooltip is implemented via a JS `mouseenter`/`pointerenter` listener -- confirm it opens
- [ ] `hover` on an element whose dropdown is implemented via pure CSS `:hover` -- confirm it does NOT open (this is the documented limitation, not a bug)
- [ ] `drag_and_drop` on a page using native HTML5 DnD (`draggable="true"`) -- confirm the drop succeeds and `dragoverAccepted`/`dropHandled` are both `true`
- [ ] `drag_and_drop` on a page using a mouse-simulated drag library -- confirm `ok: true` but `dragoverAccepted`/`dropHandled` are both `false` (documented limitation)
- [ ] `drag_and_drop` with a `sourceSelector`/`targetSelector` that doesn't match anything -- confirm `source_not_found`/`target_not_found` respectively
- [ ] `upload_file` with a small real file (under 700KB) targeting a real `<input type="file">` -- confirm the page sees the file (filename/preview visible) after the call
- [ ] `upload_file` with a file over 700KB -- confirm `file_too_large`
- [ ] `upload_file` targeting a selector that matches something other than a file input -- confirm `not_a_file_input`
- [ ] `upload_file` with a nonexistent `filePath` -- confirm `file_read_failed`, not a hang or unhandled exception

### Windows support

- [ ] From a WSL shell, run the Codex `mcp add` command from the README's Windows section, then confirm `codex mcp list` shows `firefox-bridge` connected and a `list_tabs` call succeeds
- [ ] Edit `%APPDATA%\Claude\claude_desktop_config.json` per the README, restart Claude Desktop, and confirm `firefox-bridge` shows as connected with a working `list_tabs` call
- [ ] Set the `[desktop]` and `[mcp_servers.firefox-bridge]` entries in `%USERPROFILE%\.codex\config.toml` per the README, restart Codex Desktop App, and confirm a `list_tabs` call succeeds
- [ ] On macOS or Linux, run `npm test` at the repo root after pulling this change and confirm it is still 100% green (regression guard — the Windows branches must not affect non-Windows behavior)

### Tab lifecycle (close_tab, go_back, go_forward)

- [ ] `close_tab` without a lease on the target `tabId` — confirm `not_leased`
- [ ] `close_tab` on a tab leased by a *different* session — confirm `conflict`
- [ ] `close_tab` on a tab this session has leased — confirm the tab actually closes
      and the tool returns `ok: true`
- [ ] `close_tab` on the last remaining tab in a window — confirm the whole window
      closes (expected, not a bug)
- [ ] Start `start_console`/`start_network` capture on a leased tab, then `close_tab`
      it; `acquire_tab` a fresh tab afterward and confirm no stale capture data from
      the closed tab leaks into `get_console`/`get_network` on the new tab
- [ ] `go_back`/`go_forward` without a lease on the target `tabId` — confirm
      `not_leased`
- [ ] Navigate a leased tab A → B (e.g. via `navigate`), then `go_back` — confirm the
      tab returns to A; then `go_forward` — confirm it returns to B
- [ ] `go_back` on a tab with no earlier history, and `go_forward` on a tab with no
      later history — record the ACTUAL observed behavior (silent no-op vs. an error)
      since this is not documented by Firefox; update this checklist item with the
      finding once observed
- [ ] `go_back`/`go_forward` onto a blacklisted URL triggers the confirmation popup
      and returns `blacklisted_denied` on deny, with the tab correctly navigated back
      to its original URL
- [ ] Confirm via the popup's "allow once"/"allow for session" option that a
      subsequent `go_back`/`go_forward` to that same URL is then allowed
- [ ] While `start_network` capture is active, deny a `go_back`/`go_forward` onto a
      blacklisted URL and check `get_network` — note whether any request from the
      denied page briefly appears despite the denial (expected, a pre-existing
      limitation of the capture buffer not being cleared on navigation, not a
      regression to fix here)

### Tab discard (discard_tab, list_tabs fields)

- [ ] Discard a background (non-active) tab this session has not acquired —
      `results[0].ok: true`; follow up with `list_tabs` and confirm that tab's
      `discarded: true` (don't rely on Firefox's UI appearance as the check).
- [ ] Discard a tab currently leased by a *different* session — confirm `conflict`
- [ ] Discard a tab currently leased by *this* session — succeeds, lease is
      untouched afterward (`list_tabs` still shows `leasedBy` for this session)
- [ ] Attempt to discard the active tab in its window — confirm
      `cannot_discard_active_tab`
- [ ] Discard an already-discarded tab (call it twice, or discard a tab Firefox
      itself already auto-discarded) — confirm the second call also reports
      `ok: true`, not an error
- [ ] Discard a batch of 3 `tabIds` where one is active, one is leased by another
      session, one is a normal idle tab — verify all three outcomes are
      individually correct in `results`
- [ ] Call `list_tabs` and confirm `discarded` and `lastAccessed` are present and
      correct (discarded tab from above shows `discarded: true`; a
      freshly-focused tab shows a recent `lastAccessed`)
- [ ] Discard a leased tab, then call `read_page` on it — confirm `tab_not_loaded`
- [ ] Call `start_console` on a tab, discard it, then call `get_console` on that
      tab — confirm `not_subscribed`, not stale cached messages

### Private windows (open_private_window, list_tabs incognito field)

- [ ] With "Run in Private Windows" left at its default (OFF) for this
      extension, call `open_private_window()` — confirm
      `private_window_access_denied` and that no new window actually opens
      (check the Firefox window list, not just the tool response)
- [ ] Enable "Run in Private Windows" for this extension in `about:addons`,
      restart Firefox if needed, then call `open_private_window()` with no
      `url` — confirm `ok: true`, a blank private window opens, and
      `list_tabs` shows the returned `tabId` with `leasedBy` set to this
      session and `incognito: true`
- [ ] Call `open_private_window(url)` with a real URL — confirm the new tab
      navigates there (check via `read_page` or `list_tabs`'s `url` field)
- [ ] Call `open_private_window(url)` with a blacklisted URL — confirm it
      triggers the same confirmation prompt as `navigate`/`acquire_tab`;
      decline it and confirm `blacklisted_denied`
- [ ] With the tab from a step above, run an ordinary tool against it
      (`click`, `navigate`, or `read_page`) and confirm it works — this is
      the real end-to-end proof that the toggle plus this feature together
      let the AI operate a private tab normally
- [ ] Call `list_tabs` and confirm a normal (non-private) tab reports
      `incognito: false`
- [ ] Close the private window (`close_tab` on its last tab, or close it
      manually) and confirm no dangling lease or state remains — a
      follow-up `list_tabs` no longer shows that tab

Not manually verified, documented as a known gap: `private_browsing_create_failed`
(private browsing disabled by enterprise/system policy) requires a
policy-managed Firefox profile to trigger, which isn't available in this
project's normal dev setup — the code path is confirmed correct against
Firefox's own source per the design spec's use-codex review, but not
live-tested.

### acquire_tab windowId, list_tabs windowId field

- [ ] Call `open_private_window()`, note its `windowId`. Call `list_tabs`
      and confirm that tab's `windowId` matches.
- [ ] Call `acquire_tab({url: "https://example.com", windowId: <that
      windowId>})` — confirm `ok: true`, the new tab's `url` reflects
      `example.com`, and a follow-up `list_tabs` shows the new tab with the
      *same* `windowId` as the private window from the step above (proving
      it landed in the right window, not wherever "current" happened to be)
- [ ] Call `acquire_tab({tabId: <any existing leased tab>, windowId: <any
      windowId>})` — confirm `window_id_requires_new_tab`
- [ ] Call `acquire_tab({windowId: 999999999})` (a `windowId` that doesn't
      exist) — confirm `window_not_found`
- [ ] Call `acquire_tab({windowId: <a private window's windowId>,
      cookieStoreId: <any real container's cookieStoreId from
      list_containers>})` — confirm `container_unavailable_in_private_window`,
      and confirm via `list_tabs` that no new tab was actually created
- [ ] Call `list_tabs` and confirm every tab (private and normal) reports a
      `windowId` that matches what Firefox's own window list shows for that
      tab

### Reader View (read_article)

- [ ] `read_article` on a real news/blog article page returns a sensible `title` and
      `text`, and the text is visibly cleaner than the same page's `read_page` output
      (no nav/ads/sidebar text)
- [ ] `read_article` on a non-article page (e.g. an app dashboard, a product listing)
      returns `not_an_article`
- [ ] `read_article` on a tab that predates the extension loading — open a tab, reload
      the extension, then call `read_article` on that pre-existing tab without
      navigating it first — still succeeds (confirms the on-demand `readability.js`
      injection covers this case)
- [ ] `read_article` without a lease on the target `tabId` — confirm `not_leased`
- [ ] `read_article` on a blacklisted URL triggers the same confirmation gate
      `read_page` does (confirms `privilegedGate` wiring, not just a lease check)
- [ ] A very long article triggers `truncated: true` with a correct `totalLength`
- [ ] `read_article` without `frameId` on a page with an iframe containing separate
      article-shaped content only reads the top frame (confirms the top-frame-only
      default, not an aggregate scan across frames)

### firefox-bridge-bot (read_url_fast)

- [ ] Call `read_url_fast` with a single real article URL — confirm
      `{ok:true, results:[{url, ok:true, source:'article', title, text}]}`,
      and that the private window opened and then closed automatically
      (check Firefox's actual window list, not just the tool response)
- [ ] Call `read_url_fast` with 3 URLs, all real articles — confirm all
      three result entries are `ok:true, source:'article'`, in the same
      order as the input, and that only one private window was used
      throughout (not one per URL — check via the Firefox window list
      mid-run if possible, or via timing)
- [ ] Call `read_url_fast` with a batch where one URL is a non-article page
      (e.g. a site's homepage) — confirm that entry falls back to
      `source:'page'` with `text` populated and no `title`, while the other
      URLs in the same batch still return normally
- [ ] Call `read_url_fast` with a batch where one URL is unreachable (bad
      domain, connection refused) — confirm that entry is `{ok:false,
      error}` and the other URLs in the batch still complete successfully
- [ ] Call `read_url_fast` with 11 URLs — confirm the call is rejected at
      the schema level (Zod's `max(10)`) before any window is opened
- [ ] With "Run in Private Windows" left OFF for this extension, call
      `read_url_fast` — confirm a top-level `{ok:false,
      error:'private_window_access_denied'}`, not a `results` array, and
      that no window opens
- [ ] After a successful run (steps above), confirm via `list_tabs` (using
      the regular `firefox-bridge` MCP, or Firefox's own window list) that
      no leftover private window or tab remains

Not manually verified, documented as a known gap: the best-effort cleanup
sweep's own failure mode (native-host process dying mid-script, or the
cleanup sweep's own `closeTab` calls failing) is not exercisable without
deliberately killing the host process mid-run — accepted as a known
limitation, not engineered around. Similarly, `open_private_window` can in
rare cases create a window and then fail with a `conflict` error without
ever returning a `tabId` — an edge case the cleanup sweep structurally
cannot see or close, since it never learns that tab's id.
