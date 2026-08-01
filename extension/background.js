// repo/extension/background.js
// PolicyGate is available as a global here (loaded before this script in manifest.json).

let nativePort = null;
let reconnectTimer = null;

const policyGate = new PolicyGate({
  blacklist: [], // populated from browser.storage.local by loadBlacklist(), see options/options.js (Task 16)
  confirmationTimeoutMs: 60000,
});

// Per-session tab lease bookkeeping. Reset entirely whenever the native
// port reconnects (spec: "重連只恢復 transport，不恢復邏輯 session").
let leaseOwner = new Map(); // tabId -> sessionId
let onceGrants = new Set(); // urls granted "allow once"
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
  // Transport-reconnect-does-not-restore-session: drop all lease/grant state.
  leaseOwner = new Map();
  onceGrants = new Set();
  sessionGrants = new Map();
  console.log('firefox-bridge: logical session state cleared on port loss');
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
  const decision = policyGate.checkUrl(url, { onceGrants, sessionGrants, sessionId });
  if (decision === 'allow') return { allowed: true };

  const userChoice = await requestUserConfirmation(url);
  if (userChoice === 'once') {
    onceGrants.add(url);
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

async function handleNativeMessage(msg) {
  const respond = (result) => {
    nativePort.postMessage({ ...result, requestId: msg.requestId });
  };

  try {
    switch (msg.type) {
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
        return respond(await handleScreenshot(msg));
      case 'start_console':
        return respond(await handleStartConsole(msg));
      case 'get_console':
        return respond(handleGetConsole(msg));
      case 'get_network':
        return respond(handleGetNetwork(msg));
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
    const lease = checkLease(sessionId, msg.tabId);
    if (lease.error === 'conflict') return { ok: false, error: 'conflict' };
    tab = await browser.tabs.get(msg.tabId);
  } else {
    tab = await browser.tabs.create({ url: msg.url || 'about:blank' });
  }
  if (leaseOwner.get(tab.id) && leaseOwner.get(tab.id) !== sessionId) {
    return { ok: false, error: 'conflict' };
  }
  leaseOwner.set(tab.id, sessionId);
  return { ok: true, tabId: tab.id, url: tab.url };
}

function handleReleaseTab(msg) {
  if (leaseOwner.get(msg.tabId) === msg.sessionId) {
    leaseOwner.delete(msg.tabId);
  }
  return { ok: true };
}

async function handleNavigate(msg) {
  const lease = checkLease(msg.sessionId, msg.tabId);
  if (!lease.ok) return { ok: false, error: lease.error };

  const policy = await policyCheck(msg.url, msg.sessionId);
  if (!policy.allowed) return { ok: false, error: policy.error };

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

async function handleScreenshot(msg) {
  const lease = checkLease(msg.sessionId, msg.tabId);
  if (!lease.ok) return { ok: false, error: lease.error };
  const dataUrl = await browser.tabs.captureTab(msg.tabId, { format: 'png' });
  // Returned to the native host as-is; index.js (Task 6/14) turns this into
  // a payload-store handle before the MCP server ever sees raw bytes.
  return { ok: true, dataUrl };
}

async function forwardToContentScript(msg) {
  const lease = checkLease(msg.sessionId, msg.tabId);
  if (!lease.ok) return { ok: false, error: lease.error };
  try {
    return await browser.tabs.sendMessage(msg.tabId, msg);
  } catch (err) {
    return { ok: false, error: `content_script_unreachable: ${err.message}` };
  }
}

// Tab close invalidates any lease on it (spec: lease invalidation on tab close).
browser.tabs.onRemoved.addListener((tabId) => {
  leaseOwner.delete(tabId);
  networkBuffers.delete(tabId);
  consoleBuffers.delete(tabId);
});

const consoleBuffers = new Map(); // tabId -> array of {level, args, timestamp}

async function handleStartConsole(msg) {
  const lease = checkLease(msg.sessionId, msg.tabId);
  if (!lease.ok) return { ok: false, error: lease.error };
  consoleBuffers.set(msg.tabId, []);
  await browser.scripting.executeScript({
    target: { tabId: msg.tabId },
    files: ['console-inject.js'],
    world: 'MAIN',
  });
  return { ok: true };
}

function handleGetConsole(msg) {
  const lease = checkLease(msg.sessionId, msg.tabId);
  if (!lease.ok) return { ok: false, error: lease.error };
  return { ok: true, messages: consoleBuffers.get(msg.tabId) || [] };
}

browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'console-message' && sender.tab) {
    const buf = consoleBuffers.get(sender.tab.id);
    if (buf) buf.push({ level: msg.level, args: msg.args, timestamp: msg.timestamp });
  }
});

const networkBuffers = new Map(); // tabId -> array of request summaries

browser.webRequest.onCompleted.addListener(
  (details) => {
    if (details.tabId < 0) return; // not associated with any tab (e.g. background requests) — never buffered
    if (!networkBuffers.has(details.tabId)) return; // only buffer for tabs with an active subscription
    networkBuffers.get(details.tabId).push({
      url: details.url,
      method: details.method,
      statusCode: details.statusCode,
      type: details.type,
      timeStamp: details.timeStamp,
    });
  },
  { urls: ['<all_urls>'] }
);

function handleGetNetwork(msg) {
  const lease = checkLease(msg.sessionId, msg.tabId);
  if (!lease.ok) return { ok: false, error: lease.error };
  if (!networkBuffers.has(msg.tabId)) {
    networkBuffers.set(msg.tabId, []); // first call for this tab starts buffering
  }
  return { ok: true, requests: networkBuffers.get(msg.tabId) };
}

connectToNativeHost();
