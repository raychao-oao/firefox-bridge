// repo/extension/console-inject.js
// Executed via browser.scripting.executeScript({ world: 'MAIN' }).
// Runs in the page's own JS realm, so it can intercept the page's own
// console.* calls — a normal (isolated-world) content script cannot.
(function installConsoleBridge() {
  if (window.__firefoxBridgeConsoleInstalled) return;
  window.__firefoxBridgeConsoleInstalled = true;

  const methods = ['log', 'warn', 'error', 'info'];
  for (const method of methods) {
    const original = console[method];
    console[method] = function (...args) {
      window.postMessage(
        {
          __firefoxBridge: 'console',
          level: method,
          args: args.map((a) => {
            try { return String(a); } catch { return '<unserializable>'; }
          }),
          timestamp: Date.now(),
        },
        '*'
      );
      return original.apply(console, args);
    };
  }
})();
