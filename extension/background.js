// repo/extension/background.js
// PolicyGate is available as a global here (loaded before this script in manifest.json).

let nativePort = null;
let reconnectTimer = null;

function connectToNativeHost() {
  nativePort = browser.runtime.connectNative('firefox_bridge_native_host');

  nativePort.onMessage.addListener((msg) => {
    handleNativeMessage(msg);
  });

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

// Overridden in Task 11 to actually clear session/lease state;
// declared here so the lifecycle wiring is complete on its own.
function onNativePortLost() {
  console.log('firefox-bridge: native port lost, logical session state must be reset (see Task 11)');
}

// Overridden in Task 11 to dispatch to the policy gate + tab lease + tool handlers.
function handleNativeMessage(msg) {
  console.log('firefox-bridge: received native message', msg);
}

connectToNativeHost();
