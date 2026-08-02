// repo/extension/background.js
// PolicyGate is available as a global here (loaded before this script in manifest.json).

let nativePort = null;
let reconnectTimer = null;

// Timeout ordering constraint (must hold across all three files or a slow-but-
// legitimate user response races the CLI-facing timeout and produces an
// orphaned reply — see native-host/src/index.js's REQUEST_TIMEOUT_MS comment):
//   confirmationTimeoutMs (here) < native-host REQUEST_TIMEOUT_MS < mcp-server
//   bridge-client REQUEST_TIMEOUT_MS
const policyGate = new PolicyGate({
  blacklist: [], // populated from browser.storage.local by loadBlacklist(), see options/options.js (Task 16)
  confirmationTimeoutMs: 60000,
});

// Console/network buffers are bounded ring buffers: an unbounded buffer on a
// chatty page would eventually make get_console/get_network responses exceed
// the 1 MiB native-messaging cap. Oldest entries are dropped first.
const MAX_BUFFER_ENTRIES = 500;

// Entry count alone doesn't bound total size: a single console.log of a large
// object/stack trace, or a script request URL with a long query string (seen
// live on pagespeed.web.dev — Google's module loader packs feature-flag lists
// into the URL itself), can each be tens of KB. Cap individual string fields
// too so one chatty entry can't dominate a get_console/get_network response.
const MAX_FIELD_LENGTH = 2000;

function truncateField(str) {
  if (typeof str !== 'string' || str.length <= MAX_FIELD_LENGTH) return str;
  return `${str.slice(0, MAX_FIELD_LENGTH)}...[truncated, ${str.length} chars total]`;
}

// Screenshot dataUrls routinely exceed the 1 MiB native-messaging cap, so they
// are sent to the host in chunks. 700 KiB leaves ample room for the JSON
// envelope inside the 1 MiB frame limit.
const SCREENSHOT_CHUNK_CHARS = 700 * 1024;

// Firefox has a known single-capture ceiling on each dimension -- exceeding
// it fails outright (not a silent clamp). Checked up front so a too-large
// fullPage capture gets a clear, structured error instead of an opaque
// native exception surfacing from browser.tabs.captureTab.
// https://bugzilla.mozilla.org/show_bug.cgi?id=1784915
const MAX_CAPTURE_DIMENSION = 32767;

// Per-session tab lease bookkeeping. Reset entirely whenever the native
// port reconnects (spec: "重連只恢復 transport，不恢復邏輯 session").
let leaseOwner = new Map(); // tabId -> sessionId
let onceGrants = new Map(); // sessionId -> Set<url> granted "allow once"
let sessionGrants = new Map(); // sessionId -> Set<hostname>

function connectToNativeHost() {
  nativePort = browser.runtime.connectNative('firefox_bridge_native_host');
  nativePort.onMessage.addListener((msg) => handleNativeMessage(msg));
  nativePort.onDisconnect.addListener((port) => {
    console.warn('firefox-bridge: native port disconnected', port.error);
    nativePort = null;
    onNativePortLost();
    scheduleReconnect();
  });
  console.log('firefox-bridge: native port connected');
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToNativeHost();
  }, 1000);
}

function onNativePortLost() {
  // Transport-reconnect-does-not-restore-session: drop ALL per-session state,
  // including captured page data. Leaving console/network buffers behind would
  // let the next session to acquire a tab read the previous session's capture.
  leaseOwner = new Map();
  onceGrants = new Map();
  sessionGrants = new Map();
  consoleBuffers.clear();
  networkBuffers.clear();
  console.log('firefox-bridge: logical session state cleared on port loss');
}

// A single CLI session ended (its control socket closed). Unlike port loss,
// only that session's state is dropped — other sessions keep their leases.
function onSessionEnded(sessionId) {
  if (sessionId == null) return;
  for (const [tabId, owner] of [...leaseOwner]) {
    if (owner === sessionId) releaseTabState(tabId);
  }
  onceGrants.delete(sessionId);
  sessionGrants.delete(sessionId);
  console.log(`firefox-bridge: cleared state for ended session ${sessionId}`);
}

// Dropping a lease also drops everything captured under it, so the next session
// to acquire the tab starts with clean buffers.
function releaseTabState(tabId) {
  leaseOwner.delete(tabId);
  consoleBuffers.delete(tabId);
  networkBuffers.delete(tabId);
}

async function loadBlacklist() {
  const stored = await browser.storage.local.get('blacklist');
  policyGate.blacklist = stored.blacklist || [];
}
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.blacklist) {
    policyGate.blacklist = changes.blacklist.newValue || [];
  }
});
loadBlacklist();

// Central policy gate — every privileged operation must go through this
// before touching scripting.executeScript / tabs.captureTab / DOM reads /
// webRequest subscriptions. See spec section "特權操作的中央 Policy Gate".
async function policyCheck(url, sessionId) {
  const sessionOnceGrants = onceGrants.get(sessionId) || new Set();
  const decision = policyGate.checkUrl(url, {
    onceGrants: sessionOnceGrants,
    sessionGrants,
    sessionId,
  });
  if (decision === 'allow') return { allowed: true };

  const userChoice = await requestUserConfirmation(url);
  if (userChoice === 'once') {
    if (!onceGrants.has(sessionId)) onceGrants.set(sessionId, new Set());
    onceGrants.get(sessionId).add(url);
    return { allowed: true };
  }
  if (userChoice === 'session') {
    const hostname = new URL(url).hostname;
    if (!sessionGrants.has(sessionId)) sessionGrants.set(sessionId, new Set());
    sessionGrants.get(sessionId).add(hostname);
    return { allowed: true };
  }
  return { allowed: false, error: 'blacklisted_denied' };
}

function requestUserConfirmation(url) {
  // Implemented in Task 16 (popup UI). Returns 'once' | 'session' | 'denied',
  // and resolves 'denied' automatically after the policy gate's configured
  // timeout if the user never responds (no indefinite CLI-side hang).
  return new Promise((resolve) => {
    let requestId;
    const timeout = setTimeout(() => {
      // User never responded (ignored the popup or closed it via the
      // window's own close button). Clean up the pending entry and the
      // orphaned popup window so they don't leak.
      const pending = pendingConfirmations.get(requestId);
      if (pending) {
        pendingConfirmations.delete(requestId);
        if (pending.windowId != null) {
          browser.windows.remove(pending.windowId).catch(() => {});
        }
      }
      resolve('denied');
    }, policyGate.confirmationTimeoutMs);
    requestId = openConfirmationPopup(url, (choice) => {
      clearTimeout(timeout);
      resolve(choice);
    });
  });
}

const pendingConfirmations = new Map(); // requestId -> { callback, windowId }

function openConfirmationPopup(url, callback) {
  const requestId = crypto.randomUUID();
  pendingConfirmations.set(requestId, { callback, windowId: null });
  const popupUrl = browser.runtime.getURL(
    `popup-confirm/confirm.html?url=${encodeURIComponent(url)}&requestId=${requestId}`
  );
  browser.windows.create({ url: popupUrl, type: 'popup', width: 360, height: 200 }).then((win) => {
    const pending = pendingConfirmations.get(requestId);
    if (pending) pending.windowId = win.id;
  });
  return requestId;
}

browser.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'confirmation-response') {
    const pending = pendingConfirmations.get(msg.requestId);
    if (pending) {
      pendingConfirmations.delete(msg.requestId);
      pending.callback(msg.choice);
    }
  }
});

function checkLease(sessionId, tabId) {
  const owner = leaseOwner.get(tabId);
  if (!owner) return { ok: false, error: 'not_leased' };
  if (owner !== sessionId) return { ok: false, error: 'conflict' };
  return { ok: true };
}

// THE gate. Every privileged handler — anything that reads page content,
// captures data, injects script, or subscribes to network events — funnels
// through here. Lease first, then the blacklist policy on the URL being
// touched (the tab's CURRENT url by default; callers that act on a different
// url, e.g. navigate, pass it explicitly via `url`).
//
// `frameId` scopes the URL lookup to a specific frame (0 = top frame, the
// default). This matters because a page's iframes are separate policy
// targets: an allowed top-level page must not become a back door into a
// blacklisted embedded frame, so each frame is gated on ITS OWN url, not the
// tab's.
async function privilegedGate(msg, { url, frameId = 0 } = {}) {
  const lease = checkLease(msg.sessionId, msg.tabId);
  if (!lease.ok) return lease;

  let target = url;
  if (target === undefined) {
    let tab;
    try {
      tab = await browser.tabs.get(msg.tabId);
    } catch (err) {
      return { ok: false, error: `unknown_tab: ${err.message}` };
    }
    // A discarded tab (Firefox unloaded its content -- most commonly a
    // session-restore tab that hasn't been visited since restart) has no
    // live document to inject into or read from. Fail with a distinct,
    // actionable error instead of the generic content-script-injection
    // failure this used to surface as; the caller should have the user
    // switch to the tab (or navigate it) to force a real load, then retry.
    if (tab.discarded) {
      return { ok: false, error: 'tab_not_loaded' };
    }
    if (frameId === 0) {
      target = tab.url;
    } else {
      let frames;
      try {
        frames = await browser.webNavigation.getAllFrames({ tabId: msg.tabId });
      } catch (err) {
        return { ok: false, error: `unknown_tab: ${err.message}` };
      }
      const frame = frames && frames.find((f) => f.frameId === frameId);
      if (!frame) return { ok: false, error: `unknown_frame: ${frameId}` };
      target = frame.url;
    }
  }

  const policy = await policyCheck(target, msg.sessionId);
  if (!policy.allowed) return { ok: false, error: policy.error };
  return { ok: true };
}

async function handleNativeMessage(msg) {
  const respond = (result) => {
    if (nativePort) nativePort.postMessage({ ...result, requestId: msg.requestId });
  };

  try {
    switch (msg.type) {
      case 'session_end':
        // Host-initiated notification, not a request: no response expected.
        return onSessionEnded(msg.sessionId);
      case 'acquire_tab':
        return respond(await handleAcquireTab(msg));
      case 'release_tab':
        return respond(handleReleaseTab(msg));
      case 'navigate':
        return respond(await handleNavigate(msg));
      case 'list_tabs':
        return respond(await handleListTabs());
      case 'list_containers':
        return respond(await handleListContainers());
      case 'create_container':
        return respond(await handleCreateContainer(msg));
      case 'search_history':
        return respond(await handleSearchHistory(msg));
      case 'add_bookmark':
        return respond(await handleAddBookmark(msg));
      case 'list_bookmarks':
        return respond(await handleListBookmarks(msg));
      case 'search_bookmarks':
        return respond(await handleSearchBookmarks(msg));
      case 'to_be_deleted':
        return respond(await handleToBeDeleted(msg));
      case 'click':
        return respond(await handleClick(msg));
      case 'type':
      case 'read_page':
      case 'list_elements':
        return respond(await forwardToContentScript(msg));
      case 'scroll_to':
        return respond(await forwardToContentScript(msg));
      case 'press_key':
        return respond(await forwardToContentScript(msg));
      case 'wait_for':
        return respond(await handleWaitFor(msg));
      case 'list_frames':
        return respond(await handleListFrames(msg));
      case 'screenshot':
        // Responds itself (chunked); see handleScreenshot.
        return await handleScreenshot(msg, respond);
      case 'start_console':
        return respond(await handleStartConsole(msg));
      case 'get_console':
        return respond(await handleGetConsole(msg));
      case 'start_network':
        return respond(await handleStartNetwork(msg));
      case 'get_network':
        return respond(await handleGetNetwork(msg));
      default:
        return respond({ ok: false, error: `unknown message type: ${msg.type}` });
    }
  } catch (err) {
    respond({ ok: false, error: err.message });
  }
}

// Creates a tab via createTab() and waits for its top-frame navigation to
// commit (URL finalized, page starting to load) -- NOT full page load
// (webNavigation.onCompleted would wait for every subresource too, which
// is unrelated to what this fixes: only the URL field being briefly
// stale).
//
// The onCommitted listener is armed BEFORE calling createTab(), not after
// it resolves -- a fast navigation can commit before tabs.create()'s
// promise resolves, and installing the listener only afterward would miss
// that commit entirely, making an ordinary fast navigation wait out the
// full timeout for no reason (a defect an earlier draft of this design had,
// caught by use-codex review). Because we don't know our own tab's id until
// createTab() resolves, commits seen before then are buffered by tabId and
// checked once the id is known.
//
// Returns { tab, committed }. `committed: true` means a matching commit was
// observed (either buffered before the tab id was known, or live
// afterward) -- the returned `tab` is still the pre-commit object from
// createTab() in that case; the caller re-fetches via browser.tabs.get()
// to see the post-commit url. `committed: false` means the timeout elapsed
// first. This function does not itself guarantee the committed url equals
// the requested one -- a server-side redirect can commit to a different
// url than msg.url; see the caller's url-field documentation.
//
// createTab() rejecting (e.g. Firefox refusing certain data:/javascript:
// URLs outright) propagates unchanged after cleaning up the listener/timer
// -- this function only wraps the waiting, not tab-creation error handling.
async function createTabAndWaitForCommit(createTab, timeoutMs = 3000) {
  let settled = false;
  let tabId = null;
  const pendingCommits = []; // tabIds of frameId-0 commits seen before tabId is known

  let timer;
  let resolveWait;
  const waitPromise = new Promise((resolve) => { resolveWait = resolve; });

  const cleanup = () => {
    try {
      browser.webNavigation.onCommitted.removeListener(onCommitted);
    } catch (err) {
      // removeListener should not throw in normal WebExtension operation;
      // swallow so a surprising failure here can't leave the wait
      // unresolved forever.
    }
    clearTimeout(timer);
  };

  const finish = (committed) => {
    if (settled) return;
    settled = true;
    cleanup();
    resolveWait(committed);
  };

  const onCommitted = (details) => {
    if (details.frameId !== 0) return;
    // A freshly created tab can fire an initial about:blank commit before
    // the real navigation commits. createTabAndWaitForCommit() is only ever
    // called when shouldWaitForCommit is true, which already guarantees the
    // requested destination is NOT about:blank -- so an about:blank commit
    // here is never the one we're waiting for. Treating it as satisfying
    // would resolve committed: true while the tab is still on about:blank,
    // reintroducing the stale-url bug this helper exists to fix (but now
    // without the urlPending signal that would otherwise flag it).
    if (details.url === 'about:blank') return;
    if (tabId === null) {
      pendingCommits.push(details.tabId);
      return;
    }
    if (details.tabId === tabId) finish(true);
  };

  browser.webNavigation.onCommitted.addListener(onCommitted);
  timer = setTimeout(() => finish(false), timeoutMs);

  let tab;
  try {
    tab = await createTab();
  } catch (err) {
    // Route through finish(false), not a bare cleanup() call -- keeps
    // cleanup reachable through exactly one settled-guarded path even in
    // the (harmless but possible) case where the timeout already fired
    // while createTab() was still pending. finish() is a no-op if already
    // settled, so this is always safe to call here.
    finish(false);
    throw err; // tab creation itself failed -- nothing to wait for
  }
  tabId = tab.id;
  if (pendingCommits.includes(tabId)) finish(true);

  const committed = await waitPromise;
  return { tab, committed };
}

async function handleAcquireTab(msg) {
  const sessionId = msg.sessionId;
  if (msg.tabId != null && msg.cookieStoreId != null) {
    return { ok: false, error: 'cookie_store_requires_new_tab' };
  }
  let tab;
  let urlPending = false;
  if (msg.tabId != null) {
    const owner = leaseOwner.get(msg.tabId);
    if (owner && owner !== sessionId) return { ok: false, error: 'conflict' };
    tab = await browser.tabs.get(msg.tabId);
    // Leasing an ALREADY-OPEN tab exposes whatever is on it, so the blacklist
    // applies before the lease is granted (no privilegedGate here: there is by
    // definition no lease to check yet).
    const policy = await policyCheck(tab.url, sessionId);
    if (!policy.allowed) return { ok: false, error: policy.error };
  } else {
    // Opening a NEW tab straight at a blacklisted URL must be gated too,
    // otherwise acquire_tab is a way around navigate's check.
    const url = msg.url || 'about:blank';
    if (msg.cookieStoreId != null) {
      // query({}) — not get() — because query() only fails when the
      // container feature itself is unavailable (e.g. the user disabled
      // Container Tabs via privacy.userContext.enabled), which must NOT be
      // reported as container_not_found — it should propagate to the
      // generic error path. A cookieStoreId simply not being in the list
      // (including reserved stores like "firefox-default", which never
      // appear in query() results) is the only case that becomes
      // container_not_found.
      //
      // This existence check runs before policyCheck (argument/target
      // validation before any user-facing gate) so a bogus cookieStoreId
      // doesn't trigger the blacklist confirmation dialog for a request
      // that was always going to fail anyway.
      const containers = await browser.contextualIdentities.query({});
      const found = containers.some((c) => c.cookieStoreId === msg.cookieStoreId);
      if (!found) return { ok: false, error: 'container_not_found' };
    }
    const policy = await policyCheck(url, sessionId);
    if (!policy.allowed) return { ok: false, error: policy.error };
    // Explicit about:blank behaves the same as the default -- there's no
    // real destination to wait for either way.
    const shouldWaitForCommit = Boolean(msg.url) && msg.url !== 'about:blank';
    const createTab = () =>
      msg.cookieStoreId != null
        ? browser.tabs.create({ url, cookieStoreId: msg.cookieStoreId })
        : browser.tabs.create({ url });

    if (shouldWaitForCommit) {
      const result = await createTabAndWaitForCommit(createTab);
      // Re-fetch on BOTH paths: even on timeout, a fresher url might be one
      // browser.tabs.get() call away (the commit event could simply have
      // been missed while the navigation actually completed). Guard against
      // the tab having closed during the wait -- browser.tabs.get() throws
      // in that case, and falling back to result.tab (rather than letting
      // the error propagate to a generic {ok: false}) preserves the normal
      // urlPending-on-timeout response with a lease still recorded.
      try {
        tab = await browser.tabs.get(result.tab.id);
      } catch {
        tab = result.tab; // tab closed during the wait
      }
      urlPending = !result.committed;
    } else {
      tab = await createTab();
    }
  }
  if (leaseOwner.get(tab.id) && leaseOwner.get(tab.id) !== sessionId) {
    return { ok: false, error: 'conflict' };
  }
  leaseOwner.set(tab.id, sessionId);
  return {
    ok: true,
    tabId: tab.id,
    url: tab.url,
    cookieStoreId: tab.cookieStoreId,
    ...(urlPending ? { urlPending: true } : {}),
  };
}

function handleReleaseTab(msg) {
  const lease = checkLease(msg.sessionId, msg.tabId);
  if (!lease.ok) return { ok: false, error: lease.error };
  releaseTabState(msg.tabId);
  return { ok: true };
}

async function handleNavigate(msg) {
  // Gate on the DESTINATION url — that is what the operation exposes.
  const gate = await privilegedGate(msg, { url: msg.url });
  if (!gate.ok) return gate;

  await browser.tabs.update(msg.tabId, { url: msg.url });
  return { ok: true };
}

async function handleListContainers() {
  const containers = await browser.contextualIdentities.query({});
  return {
    ok: true,
    containers: containers.map((c) => ({
      cookieStoreId: c.cookieStoreId,
      name: c.name,
      color: c.color,
      icon: c.icon,
    })),
  };
}

async function handleCreateContainer(msg) {
  const container = await browser.contextualIdentities.create({
    name: msg.name,
    color: msg.color,
    icon: msg.icon,
  });
  return {
    ok: true,
    container: {
      cookieStoreId: container.cookieStoreId,
      name: container.name,
      color: container.color,
      icon: container.icon,
    },
  };
}

async function handleListTabs() {
  const tabs = await browser.tabs.query({});
  return {
    ok: true,
    tabs: tabs.map((t) => ({
      id: t.id,
      url: t.url,
      title: t.title,
      leasedBy: leaseOwner.get(t.id) || null,
      cookieStoreId: t.cookieStoreId,
    })),
  };
}

const HISTORY_SEARCH_MAX_RESULTS = 30;
const HISTORY_SEARCH_RANGE_MS = 365 * 24 * 60 * 60 * 1000; // 1 year

async function handleSearchHistory(msg) {
  const items = await browser.history.search({
    text: msg.query,
    startTime: Date.now() - HISTORY_SEARCH_RANGE_MS,
    maxResults: HISTORY_SEARCH_MAX_RESULTS,
  });
  return {
    ok: true,
    results: items.map((item) => ({
      url: item.url,
      title: item.title,
      visitCount: item.visitCount,
      lastVisitTime: item.lastVisitTime,
    })),
  };
}

const BOOKMARKS_ROOT_IDS = new Set(['toolbar_____', 'menu________', 'unfiled_____', 'mobile______']);
const DEFAULT_BOOKMARKS_PARENT_ID = 'unfiled_____'; // "Other Bookmarks" — stable across Firefox versions

// Fixed, non-locale-dependent labels for the three non-default bookmark
// roots — NEVER use Firefox's own display title for these (that's
// locale-dependent and unreliable, the same problem DEFAULT_BOOKMARKS_
// PARENT_ID already avoids for "unfiled_____"). "unfiled_____" itself gets
// no label — it's the default root, folder strings for bookmarks there stay
// unprefixed for backward compatibility.
const ROOT_LABELS_BY_ID = {
  'toolbar_____': 'Bookmarks Toolbar',
  'menu________': 'Bookmarks Menu',
  'mobile______': 'Mobile Bookmarks',
};
const ROOT_ID_BY_LOWERCASE_LABEL = {
  'bookmarks toolbar': 'toolbar_____',
  'bookmarks menu': 'menu________',
  'mobile bookmarks': 'mobile______',
};

async function getDefaultBookmarksParentId() {
  // Throws (caught by handleNativeMessage's try/catch, becomes a structured
  // {ok:false, error} response) if this Firefox version doesn't have the
  // expected root id — see design spec's "固定的預設父節點" section.
  await browser.bookmarks.get(DEFAULT_BOOKMARKS_PARENT_ID);
  return DEFAULT_BOOKMARKS_PARENT_ID;
}

// If segments[0] matches one of the three special root labels
// (case-insensitive), route there and consume that segment; otherwise
// default to the "unfiled_____" root (Other Bookmarks), unchanged from
// prior behavior.
function resolveRootIdAndRemainingSegments(segments) {
  if (segments.length > 0) {
    const rootId = ROOT_ID_BY_LOWERCASE_LABEL[segments[0].toLowerCase()];
    if (rootId) return { rootId, remaining: segments.slice(1) };
  }
  return { rootId: DEFAULT_BOOKMARKS_PARENT_ID, remaining: segments };
}

// Walks `segments` (already parsed/trimmed by parseFolderPath) one level at
// a time from the resolved root (default "Other Bookmarks", or one of the
// three special roots if segments[0] matches a special root label — see
// resolveRootIdAndRemainingSegments). With create:true, missing segments
// are created (used by add_bookmark). With create:false, returns null the
// moment a segment isn't found (used by list_bookmarks, which must not
// create folders just by listing them). Returns the resolved `folder`
// string (real node titles, root-labeled) alongside `parentId`/`created`.
async function walkFolderPath(segments, { create }) {
  const { rootId, remaining } = resolveRootIdAndRemainingSegments(segments);
  let parentId = rootId === DEFAULT_BOOKMARKS_PARENT_ID ? await getDefaultBookmarksParentId() : rootId;
  let created = false;
  const rootLabel = ROOT_LABELS_BY_ID[rootId];
  const resolvedSegments = rootLabel ? [rootLabel] : [];
  for (const segment of remaining) {
    const children = await browser.bookmarks.getChildren(parentId);
    const matches = children
      .filter((child) => child.type === 'folder' && child.title.trim().toLowerCase() === segment.toLowerCase())
      .sort((a, b) => a.dateAdded - b.dateAdded);
    if (matches.length > 0) {
      parentId = matches[0].id;
      resolvedSegments.push(matches[0].title);
    } else if (create) {
      const folder = await browser.bookmarks.create({ parentId, title: segment });
      parentId = folder.id;
      resolvedSegments.push(folder.title);
      created = true;
    } else {
      return null;
    }
  }
  return { parentId, created, folder: resolvedSegments.join('/') };
}

// Walks UP from a node's parentId to reconstruct its full folder path
// string (e.g. "Tech/AI", or "Bookmarks Toolbar/Reading" for a non-default
// root), stopping at one of the four special root ids (prefixed as a fixed
// label instead, for the three non-default roots — see ROOT_LABELS_BY_ID).
// Used for list_bookmarks/search_bookmarks results and for add_bookmark's
// duplicate response, where the caller needs to know where an EXISTING
// bookmark actually lives.
async function getFolderPathString(parentId) {
  const titles = [];
  let currentId = parentId;
  while (currentId && !BOOKMARKS_ROOT_IDS.has(currentId)) {
    const [node] = await browser.bookmarks.get(currentId);
    titles.unshift(node.title);
    currentId = node.parentId;
  }
  const rootLabel = ROOT_LABELS_BY_ID[currentId];
  if (rootLabel) titles.unshift(rootLabel);
  return titles.join('/');
}

async function toBookmarkResult(node) {
  return {
    id: node.id,
    url: node.url,
    title: node.title,
    folder: await getFolderPathString(node.parentId),
  };
}

// Exact-string-equality dedup — see design spec's "Dedup 判斷範圍" section
// for why no URL normalization is done here.
async function findExactUrlDuplicate(url) {
  const matches = (await browser.bookmarks.search({ url }))
    .filter((node) => node.type === 'bookmark' && node.url === url)
    .sort((a, b) => a.dateAdded - b.dateAdded);
  return matches.length > 0 ? matches[0] : null;
}

async function handleAddBookmark(msg) {
  let parsedUrl;
  try {
    parsedUrl = new URL(msg.url);
  } catch {
    return { ok: false, error: 'invalid_url' };
  }
  const hostname = parsedUrl.hostname;
  const isPrivate = isPrivateAddress(hostname);

  // Private/LAN addresses skip dedup entirely: the same URL can legitimately
  // be a different physical device at different times (see design spec's
  // "Private/LAN 網址的特殊處理" section) — treating it as a stable identity
  // key would be the same mistake password-manager autofill makes on
  // shared-IP origins.
  if (!isPrivate) {
    const existing = await findExactUrlDuplicate(msg.url);
    if (existing) {
      return {
        ok: true,
        duplicate: true,
        id: existing.id,
        url: existing.url,
        title: existing.title,
        folder: await getFolderPathString(existing.parentId),
        folderCreated: false,
      };
    }
  }

  const segments = parseFolderPath(msg.folder);
  const { parentId, created, folder } = await walkFolderPath(segments, { create: true });
  const node = await browser.bookmarks.create({ parentId, title: msg.title, url: msg.url });

  const result = {
    ok: true,
    id: node.id,
    url: node.url,
    title: node.title,
    folder,
    folderCreated: created,
  };
  if (isPrivate && needsTitleWarning(msg.title, msg.url, hostname)) {
    result.titleWarning =
      "private-network address needs an identifying title (device/location/purpose) — the IP alone won't be distinguishable later";
  }
  return result;
}

async function collectBookmarks(node, pathSegments, out) {
  if (node.type === 'bookmark') {
    out.push({ id: node.id, url: node.url, title: node.title, folder: pathSegments.join('/') });
    return;
  }
  if (node.children) {
    // Descending into one of the four named root containers starts a fresh
    // path with that root's fixed label (or no label for the default
    // "unfiled_____" root); the single absolute tree root above them (no
    // parentId) contributes nothing. Only real user-created folders are
    // otherwise appended — matching getFolderPathString's root-stopping
    // behavior.
    let nextPath;
    if (!node.parentId) {
      nextPath = pathSegments;
    } else if (BOOKMARKS_ROOT_IDS.has(node.id)) {
      const rootLabel = ROOT_LABELS_BY_ID[node.id];
      nextPath = rootLabel ? [rootLabel] : [];
    } else {
      nextPath = [...pathSegments, node.title];
    }
    for (const child of node.children) {
      await collectBookmarks(child, nextPath, out);
    }
  }
}

// Hard cap on bookmark results returned to the caller. native-host's
// MAX_MESSAGE_BYTES (1 MiB) is a protocol-level limit on the whole native
// messaging response — an unbounded bookmark library (thousands of
// entries) could overflow it and produce a connection-level framing error
// instead of a graceful per-call failure. 1000 is the same order-of-
// magnitude safety margin as search_history's 30-result cap, scaled up
// since bookmarks carry less metadata per entry and hitting 1000 bookmarks
// is rarer than hitting 30 history matches.
const MAX_BOOKMARK_RESULTS = 1000;

function capBookmarkResults(results) {
  if (results.length <= MAX_BOOKMARK_RESULTS) return { results, truncated: false };
  return { results: results.slice(0, MAX_BOOKMARK_RESULTS), truncated: true };
}

async function handleListBookmarks(msg) {
  const segments = parseFolderPath(msg.folder);

  if (segments.length === 0) {
    const [root] = await browser.bookmarks.getTree();
    const collected = [];
    await collectBookmarks(root, [], collected);
    const { results, truncated } = capBookmarkResults(collected);
    return truncated ? { ok: true, results, truncated } : { ok: true, results };
  }

  const walked = await walkFolderPath(segments, { create: false });
  if (!walked) return { ok: true, results: [] };
  const children = await browser.bookmarks.getChildren(walked.parentId);
  const bookmarks = children.filter((node) => node.type === 'bookmark');
  const resolved = await Promise.all(bookmarks.map(toBookmarkResult));
  const { results, truncated } = capBookmarkResults(resolved);
  return truncated ? { ok: true, results, truncated } : { ok: true, results };
}

async function handleSearchBookmarks(msg) {
  const matches = await browser.bookmarks.search(msg.query);
  const bookmarks = matches.filter((node) => node.type === 'bookmark');
  const resolved = await Promise.all(bookmarks.map(toBookmarkResult));
  const { results, truncated } = capBookmarkResults(resolved);
  return truncated ? { ok: true, results, truncated } : { ok: true, results };
}

// Returns true if `candidateId` equals `startId`, or is any ancestor of it
// (walking up startId's parentId chain). Used to reject moving a node into
// itself or into one of its own descendants — either would create a cycle
// in the bookmark tree.
async function isNodeOrAncestor(candidateId, startId) {
  let currentId = startId;
  while (currentId && !BOOKMARKS_ROOT_IDS.has(currentId)) {
    if (currentId === candidateId) return true;
    const [node] = await browser.bookmarks.get(currentId);
    currentId = node.parentId;
  }
  return false;
}

async function handleToBeDeleted(msg) {
  const target = msg.target;
  const hasId = typeof target?.id === 'string' && target.id.trim() !== '';
  const hasFolder = typeof target?.folder === 'string' && target.folder.trim() !== '';
  if (hasId === hasFolder) {
    // Both given, or neither given (or target itself isn't a usable object) —
    // hasId/hasFolder are both false in every one of those cases, and both
    // true only when both fields were provided, so this one equality check
    // catches all of them.
    return { ok: false, error: 'invalid_target' };
  }

  let nodeId;
  let node;
  if (hasId) {
    [node] = await browser.bookmarks.get(target.id);
    if (node.type !== 'bookmark') {
      // target.id can only legitimately be a bookmark id (see design spec's
      // "輸入" section) — existing tools never return a folder id.
      return { ok: false, error: 'id_is_not_a_bookmark' };
    }
    nodeId = node.id;
  } else {
    const segments = parseFolderPath(target.folder);
    if (segments.length === 0) {
      // target.folder was non-empty as a raw string (checked above) but
      // parsed down to zero real path segments, e.g. "/" or "//".
      return { ok: false, error: 'invalid_target' };
    }
    const walked = await walkFolderPath(segments, { create: false });
    if (!walked) return { ok: false, error: 'folder_not_found' };
    nodeId = walked.parentId;
    [node] = await browser.bookmarks.get(nodeId);
  }

  if (BOOKMARKS_ROOT_IDS.has(nodeId)) {
    return { ok: false, error: 'cannot_move_root' };
  }

  // Must be captured BEFORE move() below — move() mutates node.parentId.
  const originalParentId = node.parentId;

  const { parentId: pendingDeletionId, folder: pendingDeletionPath } = await walkFolderPath(['Pending Deletion'], { create: true });

  if (await isNodeOrAncestor(nodeId, pendingDeletionId)) {
    return { ok: false, error: 'cannot_move_ancestor_of_destination' };
  }

  await browser.bookmarks.move(nodeId, { parentId: pendingDeletionId });

  return {
    ok: true,
    id: nodeId,
    type: node.type,
    title: node.title,
    from: await getFolderPathString(originalParentId),
    to: pendingDeletionPath,
  };
}

async function handleScreenshot(msg, respond) {
  const gate = await privilegedGate(msg);
  if (!gate.ok) return respond(gate);

  const captureOptions = { format: 'png' };
  if (msg.fullPage) {
    let dims;
    try {
      const [{ result }] = await browser.scripting.executeScript({
        target: { tabId: msg.tabId },
        // Three-way max, not just documentElement: some pages' body/
        // documentElement scroll dimensions disagree depending on layout
        // (quirks mode, height:100% chains, etc.) -- taking the max of all
        // three is the only way to reliably get the true full-page extent.
        func: () => ({
          width: Math.max(
            document.documentElement.scrollWidth,
            document.body ? document.body.scrollWidth : 0,
            window.innerWidth
          ),
          height: Math.max(
            document.documentElement.scrollHeight,
            document.body ? document.body.scrollHeight : 0,
            window.innerHeight
          ),
        }),
      });
      dims = result;
    } catch (err) {
      return respond({ ok: false, error: `screenshot_dimensions_failed: ${err.message}` });
    }
    // Guard against a malformed/empty injection result (e.g. a page that
    // rejected injection in some edge case) before trusting dims.width --
    // caught by use-codex plan review.
    if (!dims || typeof dims.width !== 'number' || typeof dims.height !== 'number') {
      return respond({ ok: false, error: 'screenshot_dimensions_failed: no result from page' });
    }
    if (dims.width > MAX_CAPTURE_DIMENSION || dims.height > MAX_CAPTURE_DIMENSION) {
      return respond({ ok: false, error: 'screenshot_too_large' });
    }
    // rect is relative to the PAGE, not the current scroll position/viewport
    // (MDN, extensionTypes.ImageDetails.rect) -- no scrolling or multi-shot
    // stitching needed, Firefox captures the full document area directly.
    //
    // scale:1 is required, not optional: captureTab defaults scale to the
    // display's devicePixelRatio, so on a HiDPI/retina display (DPR 2) a
    // 20000x20000 CSS-pixel rect would render as a ~40000x40000 output
    // canvas -- silently blowing past MAX_CAPTURE_DIMENSION even though the
    // CSS-pixel check above passed. Forcing scale:1 makes the CSS-pixel
    // dimensions checked above equal to the actual output canvas dimensions,
    // which is what the 32767px ceiling actually applies to. Found by
    // use-codex plan review -- an earlier draft checked CSS pixels but left
    // captureTab's scale at its DPR-dependent default.
    captureOptions.rect = { x: 0, y: 0, width: dims.width, height: dims.height };
    captureOptions.scale = 1;
  }

  const dataUrl = await browser.tabs.captureTab(msg.tabId, captureOptions);

  // Chunked transfer: a single message carrying a full retina PNG would blow
  // past the 1 MiB native-messaging cap on THIS hop. Every chunk carries the
  // original requestId so the host's `pending` map still routes it;
  // native-host/src/index.js reassembles them before writing to PayloadStore.
  const total = Math.max(1, Math.ceil(dataUrl.length / SCREENSHOT_CHUNK_CHARS));
  for (let i = 0; i < total; i += 1) {
    if (!nativePort) return; // port died mid-transfer; host will time the request out
    nativePort.postMessage({
      ok: true,
      type: 'screenshot-chunk',
      requestId: msg.requestId,
      chunkIndex: i,
      totalChunks: total,
      data: dataUrl.slice(i * SCREENSHOT_CHUNK_CHARS, (i + 1) * SCREENSHOT_CHUNK_CHARS),
    });
  }
}

async function handleListFrames(msg) {
  // Discovery-only: gated on the top frame, same as any other operation that
  // doesn't target a specific sub-frame yet. The frames THEMSELVES aren't
  // read here, just enumerated (id/parent/url), so this doesn't need a
  // per-frame policy check the way forwardToContentScript's aggregate path
  // does.
  const gate = await privilegedGate(msg, { frameId: 0 });
  if (!gate.ok) return gate;
  let frames;
  try {
    frames = await browser.webNavigation.getAllFrames({ tabId: msg.tabId });
  } catch (err) {
    return { ok: false, error: `unknown_tab: ${err.message}` };
  }
  return {
    ok: true,
    frames: frames.map((f) => ({ frameId: f.frameId, parentFrameId: f.parentFrameId, url: f.url })),
  };
}

// Sends to exactly one frame, never a bare tabId-only broadcast: with
// all_frames:true, more than one frame can have a listener, and Firefox
// resolves an unscoped tabs.sendMessage to only one of the (arbitrary)
// responses -- see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/sendMessage.
async function sendToFrame(tabId, frameId, msg) {
  try {
    return await browser.tabs.sendMessage(tabId, msg, { frameId });
  } catch (err) {
    // This frame may predate the extension being loaded/reloaded --
    // manifest.json's content_scripts only auto-inject on new navigations,
    // not into already-open tabs/frames. Inject on demand and retry once
    // before giving up, so "operate the user's existing, already-logged-in
    // tabs" (this project's whole point) actually works on tabs opened
    // before the extension started.
    try {
      // browser.tabs.executeScript (the classic MV2 API, uses the extension's
      // existing host permissions directly) rather than browser.scripting --
      // the latter threw an opaque "An unexpected error occurred" here with
      // no further detail. frameId here targets exactly this frame; never
      // pass allFrames here, that would reintroduce the same
      // which-response-wins ambiguity this function exists to avoid.
      await browser.tabs.executeScript(tabId, { file: 'content-script.js', frameId });
    } catch (injectErr) {
      console.error('firefox-bridge: content script injection failed', injectErr);
      return { ok: false, error: `content_script_inject_failed: ${injectErr.message}` };
    }
    try {
      return await browser.tabs.sendMessage(tabId, msg, { frameId });
    } catch (retryErr) {
      return { ok: false, error: `content_script_unreachable: ${retryErr.message}` };
    }
  }
}

// Shared by handleClick and forwardToContentScript's `type` case. Given a
// per-frame attempt function `attemptFrame(frameId)` that returns a
// content-script response object, tries frame 0 first, falls back to
// searching other frames (capped at FRAME_SEARCH_CAP) for the first one
// where the message actually resolves -- either `ok: true`, or a
// non-retryable error that proves the element WAS found in that frame
// (e.g. option_not_found on a <select>).
//
// FRAME_SEARCH_CAP bounds worst-case latency/frame count on a pathological
// page with many iframes. No existing precedent in this codebase for a
// frame-count cap specifically (MAX_ELEMENTS/HEURISTIC_SCAN_CAP bound
// per-frame element scanning, not frame count) -- 20 is a conservative,
// arbitrary choice: comfortably above any normal page's iframe count,
// low enough that a pathological page can't make one click/type call
// enumerate hundreds of frames.
const FRAME_SEARCH_CAP = 20;

async function searchFramesForResult(msg, attemptFrame) {
  const RETRYABLE_ERRORS = new Set(['element_not_found', 'stale_selector']);
  // stale_selector is retryable for the same reason established earlier in
  // this spec: expectedDomEpoch may have been intended for the frame the
  // element actually lives in, not frame 0, so a mismatch on frame 0 alone
  // doesn't prove the page is genuinely stale everywhere.

  const gate0 = await privilegedGate(msg, { frameId: 0 });
  if (!gate0.ok) return gate0;
  const result0 = await attemptFrame(0);
  if (result0.ok || !RETRYABLE_ERRORS.has(result0.error)) return result0;

  let frameList;
  try {
    frameList = await browser.webNavigation.getAllFrames({ tabId: msg.tabId });
  } catch (err) {
    // Couldn't enumerate frames -- this is also an incomplete search (we
    // never even tried beyond frame 0), not a confirmed "not found."
    return { ...result0, frameSearchIncomplete: true };
  }

  // Tracks every reason the search might not be exhaustive -- a
  // policy-blocked frame, hitting FRAME_SEARCH_CAP, or getAllFrames itself
  // failing all mean a final "not found" should NOT be read as "definitely
  // not on this page." use-codex review on an earlier draft only tracked
  // the policy-skip case; capped-out and enumeration-failure are the same
  // class of incompleteness and must set the same flag.
  let incomplete = false;
  let framesTried = 1; // frame 0 already counted
  for (const frame of frameList) {
    if (frame.frameId === 0) continue;
    if (framesTried >= FRAME_SEARCH_CAP) {
      incomplete = true;
      break;
    }
    // Non-interactive check ONLY, unlike the frame-0 gate above and the
    // explicit-frameId path elsewhere: privilegedGate's policyCheck calls
    // requestUserConfirmation, which can pop a real, up-to-60s user
    // confirmation dialog. Iframes from ad/tracker domains landing on the
    // blacklist are common, so an automatic fallback search walking past
    // several of them could pop a dialog per frame, sequentially, inside
    // one click/type call -- easily blowing past the native host's 90s
    // REQUEST_TIMEOUT_MS if any dialog is ignored. So this loop calls
    // policyGate.checkUrl directly (same session-scoped onceGrants/
    // sessionGrants used by policyCheck, so an already-granted permission
    // is still honored) and treats anything short of 'allow' as a
    // policy-skip -- never prompting. A caller who actually wants to
    // interact with a blacklisted frame can still pass an explicit
    // frameId and get today's normal interactive prompt via privilegedGate.
    const sessionOnceGrants = onceGrants.get(msg.sessionId) || new Set();
    const decision = policyGate.checkUrl(frame.url, {
      onceGrants: sessionOnceGrants,
      sessionGrants,
      sessionId: msg.sessionId,
    });
    if (decision !== 'allow') {
      incomplete = true;
      continue;
    }
    framesTried += 1;
    const result = await attemptFrame(frame.frameId);
    if (!result.ok && (result.error?.startsWith('content_script_inject_failed') || result.error?.startsWith('content_script_unreachable'))) {
      // Transport-level failure (e.g. about:blank placeholder, PDF viewer
      // frame, or a frame outside host permissions) -- proves nothing about
      // whether the target element exists in this frame, unlike
      // option_not_found (which proves the element WAS found). Skip and
      // keep searching, same as a policy-skipped frame.
      incomplete = true;
      continue;
    }
    if (result.ok || !RETRYABLE_ERRORS.has(result.error)) return result;
  }

  if (incomplete) {
    // Not found in any frame this search actually reached -- but the
    // search was NOT exhaustive (policy block, cap, or enumeration
    // failure), so say so explicitly rather than letting a generic
    // element_not_found imply "definitely not on this page."
    return { ...result0, frameSearchIncomplete: true };
  }
  return result0;
}

async function handleClick(msg) {
  const gate = await privilegedGate(msg, { frameId: msg.frameId ?? 0 });
  if (!gate.ok) return gate;

  const tabBefore = await browser.tabs.get(msg.tabId);
  const urlBefore = tabBefore.url;

  // Longer than content-script's own 300ms observation window (not equal to
  // it) -- gives room for messaging round-trip/serialization overhead so an
  // ordinary, non-blocked click doesn't get misread as dialogOpened just
  // because the response arrived a few ms late.
  const CLICK_TIMEOUT_MS = 600;

  // Known limitation of sendToFrame's retry-and-reinject logic: if a click
  // triggers a navigation and the original browser.tabs.sendMessage inside
  // sendToFrame rejects due to the frame's document tearing down mid-flight,
  // sendToFrame will inject the content script into the NEW document and
  // resend the same click message. This could potentially trigger el.click()
  // a second time against whatever now matches msg.selector in the new
  // document. This is pre-existing behavior (not a regression introduced here)
  // and is accepted as a known limitation — not fixed in this task.
  const attemptFrame = async (frameId) => {
    // .catch(() => null) is defensive, not currently load-bearing: sendToFrame
    // already catches its own send/inject/retry failures internally and
    // resolves to {ok: false, error} rather than rejecting. This guards
    // against a future change to sendToFrame reintroducing a real rejection
    // path.
    const contentScriptResult = sendToFrame(msg.tabId, frameId, msg).catch(() => null);
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), CLICK_TIMEOUT_MS));
    const raced = await Promise.race([contentScriptResult, timeout]);
    if (raced === null) {
      // This SPECIFIC frame didn't answer in time. This is a best-effort
      // heuristic, not a certainty: sendToFrame's own injection/retry path
      // can also eat the full budget before the content-script listener
      // ever starts, with no click dispatched at all -- we cannot
      // distinguish a real dialog from injection latency here. Still
      // treated as terminal (not retryable): even in the injection-delay
      // case, trying ANOTHER frame risks double-dispatching a click if the
      // original sendToFrame call is still in flight and eventually
      // succeeds after this function has already moved on -- accepting a
      // possible missed click in the rare true-injection-delay case is the
      // safer failure mode than accepting a possible double click.
      return { ok: true, dialogOpened: true, domChanged: false };
    }
    return raced;
  };

  // No second gate call needed here for the explicit-frameId path -- the
  // gate above already checked exactly this frameId (msg.frameId ?? 0
  // resolves to msg.frameId when it's explicitly set). For the
  // omitted-frameId path, searchFramesForResult's own internal gate0 check
  // (frameId: 0) becomes a harmless, redundant re-check of the same frame
  // already gated above -- acceptable, not a new correctness issue.
  const result = msg.frameId != null
    ? await attemptFrame(msg.frameId)
    : await searchFramesForResult(msg, attemptFrame);

  // Read AFTER the race, not before it started -- a navigation triggered by
  // the click may still be in flight at this point (tab.url hasn't updated
  // yet), which would under-report navigated: false for a click whose
  // effect genuinely was "started a navigation." Not fixed in this batch
  // (would need its own wait/poll, overlapping with wait_for's job) --
  // documented as a known false-negative source in the click tool
  // description (Task 2) and the manual checklist (Task 3).
  const tabAfter = await browser.tabs.get(msg.tabId);
  const navigated = tabAfter.url !== urlBefore;

  if (!result.ok) return result; // element_not_found (all searched frames exhausted) / stale_selector (genuinely, everywhere) / policy error -- pass through unchanged

  return {
    ok: true,
    navigated,
    dialogOpened: Boolean(result.dialogOpened),
    domChanged: Boolean(result.domChanged),
    newUrl: navigated ? tabAfter.url : undefined,
    // The design spec's own handleClick code silently dropped
    // frameSearchIncomplete even though searchFramesForResult sets it --
    // found and fixed during use-codex plan review. Without this line, the
    // caller would never learn a search wasn't exhaustive.
    ...(result.frameSearchIncomplete ? { frameSearchIncomplete: true } : {}),
  };
}

async function forwardToContentScript(msg) {
  // click is handled entirely by handleClick now (see the switch in
  // handleNativeMessage) -- this function never receives msg.type ===
  // 'click'. type gets the same frame-fallback search as click, but with
  // no per-frame race (type has never had timeout protection -- if a
  // frame's response hangs, the whole call hangs, same as before this
  // batch; not fixed here, out of scope). wait_for keeps its original,
  // single-frame-only behavior -- cross-frame waiting needs a materially
  // different design (waiting on multiple frames simultaneously), not in
  // scope for this batch.
  if (msg.type === 'type') {
    if (msg.frameId != null) {
      const gate = await privilegedGate(msg, { frameId: msg.frameId });
      if (!gate.ok) return gate;
      return sendToFrame(msg.tabId, msg.frameId, msg);
    }
    return searchFramesForResult(msg, (frameId) => sendToFrame(msg.tabId, frameId, msg));
  }
  if (msg.type === 'wait_for') {
    const frameId = msg.frameId ?? 0;
    const gate = await privilegedGate(msg, { frameId });
    if (!gate.ok) return gate;
    return sendToFrame(msg.tabId, frameId, msg);
  }
  if (msg.type === 'scroll_to') {
    // Single frame only, no cross-frame fallback search or aggregation --
    // a selector is always frame-local, and there's exactly one frame the
    // caller means to scroll within (default the top frame if unstated).
    const frameId = msg.frameId ?? 0;
    const gate = await privilegedGate(msg, { frameId });
    if (!gate.ok) return gate;
    return sendToFrame(msg.tabId, frameId, msg);
  }

  if (msg.type === 'press_key') {
    if (msg.selector !== undefined) {
      // Has a selector (including an explicit empty string -- consistent
      // with content-script.js's own msg.selector !== undefined check):
      // same frame-fallback shape as `type` -- omitted frameId searches
      // other frames for the first where the selector resolves.
      if (msg.frameId != null) {
        const gate = await privilegedGate(msg, { frameId: msg.frameId });
        if (!gate.ok) return gate;
        return sendToFrame(msg.tabId, msg.frameId, msg);
      }
      return searchFramesForResult(msg, (frameId) => sendToFrame(msg.tabId, frameId, msg));
    }
    // No selector: single frame only (document.activeElement is inherently
    // frame-scoped, no fallback search makes sense).
    const frameId = msg.frameId ?? 0;
    const gate = await privilegedGate(msg, { frameId });
    if (!gate.ok) return gate;
    return sendToFrame(msg.tabId, frameId, msg);
  }

  // read_page / list_elements with an explicit frameId: single-frame, same
  // shape as before this session's iframe work.
  if (msg.frameId != null) {
    const gate = await privilegedGate(msg, { frameId: msg.frameId });
    if (!gate.ok) return gate;
    const result = await sendToFrame(msg.tabId, msg.frameId, msg);
    if (result.ok && msg.type === 'list_elements' && Array.isArray(result.elements)) {
      result.elements = result.elements.map((el) => ({ ...el, frameId: msg.frameId }));
    }
    return result;
  }

  // read_page / list_elements with no frameId: enumerate every frame and
  // aggregate, grouped by frame -- NOT a flat merged list, so a caller can
  // tell the router UI's real content frame apart from an unrelated ad
  // iframe instead of everything being interleaved. Each frame is gated on
  // its own url: an allowed top-level page must not become a path to read a
  // blacklisted embedded frame.
  const topGate = await privilegedGate(msg, { frameId: 0 });
  if (!topGate.ok) return topGate;

  let frameList;
  try {
    frameList = await browser.webNavigation.getAllFrames({ tabId: msg.tabId });
  } catch (err) {
    return { ok: false, error: `unknown_tab: ${err.message}` };
  }

  const frames = [];
  const frameErrors = [];
  for (const frame of frameList) {
    const frameGate = frame.frameId === 0 ? topGate : await privilegedGate(msg, { frameId: frame.frameId });
    if (!frameGate.ok) {
      frameErrors.push({ frameId: frame.frameId, url: frame.url, error: frameGate.error });
      continue;
    }
    const result = await sendToFrame(msg.tabId, frame.frameId, msg);
    if (!result.ok) {
      frameErrors.push({ frameId: frame.frameId, url: frame.url, error: result.error });
      continue;
    }
    if (msg.type === 'list_elements' && Array.isArray(result.elements)) {
      result.elements = result.elements.map((el) => ({ ...el, frameId: frame.frameId }));
    }
    frames.push({ frameId: frame.frameId, parentFrameId: frame.parentFrameId, url: frame.url, ...result });
  }

  return { ok: true, frames, frameErrors };
}

// Tab close invalidates any lease on it (spec: lease invalidation on tab close).
browser.tabs.onRemoved.addListener((tabId) => {
  releaseTabState(tabId);
});

const consoleBuffers = new Map(); // tabId -> array of {level, args, timestamp}

function pushBounded(buffer, entry) {
  buffer.push(entry);
  while (buffer.length > MAX_BUFFER_ENTRIES) buffer.shift();
}

async function handleStartConsole(msg) {
  const gate = await privilegedGate(msg);
  if (!gate.ok) return gate;
  consoleBuffers.set(msg.tabId, []);
  await browser.scripting.executeScript({
    target: { tabId: msg.tabId },
    files: ['console-inject.js'],
    world: 'MAIN',
  });
  return { ok: true };
}

async function handleGetConsole(msg) {
  // Gated like every other content-exposing operation: this hands back page
  // content captured from the tab.
  const gate = await privilegedGate(msg);
  if (!gate.ok) return gate;
  const buffer = consoleBuffers.get(msg.tabId);
  if (!buffer) return { ok: false, error: 'not_subscribed' };
  return { ok: true, messages: buffer };
}

browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'console-message' && sender.tab) {
    const buf = consoleBuffers.get(sender.tab.id);
    if (buf) {
      const args = Array.isArray(msg.args) ? msg.args.map(truncateField) : msg.args;
      pushBounded(buf, { level: msg.level, args, timestamp: msg.timestamp });
    }
  }
});

const networkBuffers = new Map(); // tabId -> array of request summaries

browser.webRequest.onCompleted.addListener(
  (details) => {
    if (details.tabId < 0) return; // not associated with any tab (e.g. background requests) — never buffered
    const buf = networkBuffers.get(details.tabId);
    if (!buf) return; // only buffer for tabs with an active subscription
    pushBounded(buf, {
      url: truncateField(details.url),
      method: details.method,
      statusCode: details.statusCode,
      type: details.type,
      timeStamp: details.timeStamp,
    });
  },
  { urls: ['<all_urls>'] }
);

async function handleWaitFor(msg) {
  // "Set" means a MEANINGFUL value: selector/textGone must be non-empty
  // strings, networkIdle must be exactly `true`. A naive `!== undefined`
  // check would count an empty string or an explicit `networkIdle: false`
  // as "set" -- the former would then race two never-matching conditions
  // in content-script (harmless but pointless), the latter would silently
  // fall through to content-script polling with NEITHER condition set,
  // which just times out doing nothing. Found during use-codex plan review.
  const hasSelector = typeof msg.selector === 'string' && msg.selector.length > 0;
  const hasTextGone = typeof msg.textGone === 'string' && msg.textGone.length > 0;
  const hasNetworkIdle = msg.networkIdle === true;
  const conditionsSet = [hasSelector, hasTextGone, hasNetworkIdle].filter(Boolean).length;
  if (conditionsSet !== 1) {
    return { ok: false, error: 'invalid_wait_condition' };
  }
  if (hasNetworkIdle) {
    return handleWaitForNetworkIdle(msg);
  }
  return forwardToContentScript(msg);
}

// Deliberately self-contained -- does NOT reuse the existing networkBuffers
// map (see handleStartNetwork/handleGetNetwork above). That map only
// buffers for tabs with an active start_network subscription and is meant
// for the caller-visible get_network history; this needs its own
// lastActivity tracker regardless of whether start_network was ever called.
//
// Known limitations, not fixed in this batch (found during use-codex plan
// review, verified sound overall -- multiple browser.webRequest.onCompleted
// listeners coexist safely, this one doesn't interfere with the existing
// networkBuffers-based listener, and each concurrent wait_for({networkIdle})
// call has its own independent lastActivity/listener so concurrent waits on
// the same or different tabs don't share state):
// - Requests already in flight *before* this listener is installed are
//   invisible to it -- only onCompleted events firing after the listener is
//   added count as "activity."
// - Only onCompleted is tracked (matching networkBuffers's existing
//   behavior) -- a failed, cancelled, or still-in-progress request doesn't
//   count as activity, so a page with one very long-running request could
//   report matched: true (falsely "idle") while that request is still
//   pending.
// - If the tab closes mid-wait, nothing detects that -- the wait either
//   continues to timeoutMs or reports idle after IDLE_WINDOW_MS of
//   (now-impossible) further activity, same as it would for any other
//   quiet tab.
// - addListener itself is called outside the try block -- if it throws
//   (not expected in normal operation), the function exits before the
//   finally would run. Accepted as-is; not defensively wrapped in this
//   batch.
async function handleWaitForNetworkIdle(msg) {
  const gate = await privilegedGate(msg, { frameId: msg.frameId ?? 0 });
  if (!gate.ok) return gate;

  const IDLE_WINDOW_MS = 500;
  const POLL_INTERVAL_MS = 100;
  const deadline = Date.now() + (msg.timeoutMs ?? 5000);

  let lastActivity = Date.now();
  const onCompleted = (details) => {
    if (details.tabId === msg.tabId) lastActivity = Date.now();
  };
  browser.webRequest.onCompleted.addListener(onCompleted, { urls: ['<all_urls>'] });

  try {
    while (Date.now() < deadline) {
      if (Date.now() - lastActivity >= IDLE_WINDOW_MS) {
        return { ok: true, matched: true, timedOut: false };
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    return { ok: true, matched: false, timedOut: true };
  } finally {
    browser.webRequest.onCompleted.removeListener(onCompleted);
  }
}

async function handleStartNetwork(msg) {
  const gate = await privilegedGate(msg);
  if (!gate.ok) return gate;
  networkBuffers.set(msg.tabId, []);
  return { ok: true };
}

async function handleGetNetwork(msg) {
  const gate = await privilegedGate(msg);
  if (!gate.ok) return gate;
  const buffer = networkBuffers.get(msg.tabId);
  // Buffering starts only at start_network, so a read before subscribing is an
  // error rather than a silently-empty result that also loses page-load traffic.
  if (!buffer) return { ok: false, error: 'not_subscribed' };
  return { ok: true, requests: buffer };
}

connectToNativeHost();
