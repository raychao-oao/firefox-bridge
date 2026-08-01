// repo/extension/background.js
// PolicyGate is available as a global here (loaded before this script in manifest.json).

let nativePort = null;
let reconnectTimer = null;

const policyGate = new PolicyGate({
  blacklist: [], // populated from browser.storage.local by loadBlacklist(), see options/options.js (Task 16)
  confirmationTimeoutMs: 60000,
});

// Console/network buffers are bounded ring buffers: an unbounded buffer on a
// chatty page would eventually make get_console/get_network responses exceed
// the 1 MiB native-messaging cap. Oldest entries are dropped first.
const MAX_BUFFER_ENTRIES = 500;

// Screenshot dataUrls routinely exceed the 1 MiB native-messaging cap, so they
// are sent to the host in chunks. 700 KiB leaves ample room for the JSON
// envelope inside the 1 MiB frame limit.
const SCREENSHOT_CHUNK_CHARS = 700 * 1024;

// Per-session tab lease bookkeeping. Reset entirely whenever the native
// port reconnects (spec: "重連只恢復 transport，不恢復邏輯 session").
let leaseOwner = new Map(); // tabId -> sessionId
let onceGrants = new Map(); // sessionId -> Set<url> granted "allow once"
let sessionGrants = new Map(); // sessionId -> Set<hostname>

function connectToNativeHost() {
  nativePort = browser.runtime.connectNative('firefox_bridge_native_host');
  nativePort.onMessage.addListener((msg) => handleNativeMessage(msg));
  nativePort.onDisconnect.addListener(() => {
    console.warn('firefox-bridge: native port disconnected', browser.runtime.lastError);
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
async function privilegedGate(msg, { url } = {}) {
  const lease = checkLease(msg.sessionId, msg.tabId);
  if (!lease.ok) return lease;

  let target = url;
  if (target === undefined) {
    try {
      const tab = await browser.tabs.get(msg.tabId);
      target = tab.url;
    } catch (err) {
      return { ok: false, error: `unknown_tab: ${err.message}` };
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
      case 'click':
      case 'type':
      case 'read_page':
        return respond(await forwardToContentScript(msg));
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

async function handleAcquireTab(msg) {
  const sessionId = msg.sessionId;
  let tab;
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
    const policy = await policyCheck(url, sessionId);
    if (!policy.allowed) return { ok: false, error: policy.error };
    tab = await browser.tabs.create({ url });
  }
  if (leaseOwner.get(tab.id) && leaseOwner.get(tab.id) !== sessionId) {
    return { ok: false, error: 'conflict' };
  }
  leaseOwner.set(tab.id, sessionId);
  return { ok: true, tabId: tab.id, url: tab.url };
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

async function handleListTabs() {
  const tabs = await browser.tabs.query({});
  return {
    ok: true,
    tabs: tabs.map((t) => ({
      id: t.id,
      url: t.url,
      title: t.title,
      leasedBy: leaseOwner.get(t.id) || null,
    })),
  };
}

async function handleScreenshot(msg, respond) {
  const gate = await privilegedGate(msg);
  if (!gate.ok) return respond(gate);

  const dataUrl = await browser.tabs.captureTab(msg.tabId, { format: 'png' });

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

async function forwardToContentScript(msg) {
  const gate = await privilegedGate(msg);
  if (!gate.ok) return gate;
  try {
    return await browser.tabs.sendMessage(msg.tabId, msg);
  } catch (err) {
    return { ok: false, error: `content_script_unreachable: ${err.message}` };
  }
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
    if (buf) pushBounded(buf, { level: msg.level, args: msg.args, timestamp: msg.timestamp });
  }
});

const networkBuffers = new Map(); // tabId -> array of request summaries

browser.webRequest.onCompleted.addListener(
  (details) => {
    if (details.tabId < 0) return; // not associated with any tab (e.g. background requests) — never buffered
    const buf = networkBuffers.get(details.tabId);
    if (!buf) return; // only buffer for tabs with an active subscription
    pushBounded(buf, {
      url: details.url,
      method: details.method,
      statusCode: details.statusCode,
      type: details.type,
      timeStamp: details.timeStamp,
    });
  },
  { urls: ['<all_urls>'] }
);

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
