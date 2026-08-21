// repo/extension/webmcp-relay.js
//
// Dedicated relay content script for the WebMCP shim. Declared STATICALLY
// in manifest.json's content_scripts (Task 1, Step 2b) -- present on
// EVERY page from extension load onward, at document_start, ISOLATED
// world (the default for a content_scripts entry with no explicit world),
// same as content-script.js except at document_start instead of
// document_idle. This is deliberately NOT part of content-script.js
// itself: a page that calls registerTool() during its own early script
// execution would have its tool.register postMessage fire before a
// document_idle listener exists to receive it. postMessage isn't queued,
// so the registration would be silently and permanently lost. A static
// document_start entry closes that gap by construction, with no ordering
// dependency on any dynamically-registered content script (see
// docs/superpowers/specs/2026-08-20-firefox-bridge-webmcp-shim-design.md,
// "Page-world shim" § "Registration timing", for why an earlier draft's
// dynamic per-hostname registration was abandoned in favor of this).
//
// Being present on every page does NOT weaken the whitelist boundary --
// background.js's webmcp-tool-register handler (Task 4) is the real
// enforcement point, authorizing by sender.url regardless of which pages
// this relay happens to run on.
(function () {
  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var data = event.data;
    if (!data || data.source !== 'firefox-bridge-webmcp' || data.version !== 1) return;

    if (data.type === 'tool.register') {
      browser.runtime.sendMessage({ type: 'webmcp-tool-register', tool: data.tool });
    } else if (data.type === 'tool.result') {
      browser.runtime.sendMessage({ type: 'webmcp-tool-result', requestId: data.requestId, result: data.result });
    } else if (data.type === 'tool.error') {
      browser.runtime.sendMessage({ type: 'webmcp-tool-error', requestId: data.requestId, error: data.error });
    }
  });

  browser.runtime.onMessage.addListener(function (msg) {
    if (msg.type !== 'webmcp-tool-call') return; // not handled by this listener -- returning nothing (not `true`) is deliberate, see the note below
    window.postMessage({
      source: 'firefox-bridge-webmcp',
      version: 1,
      type: 'tool.call',
      requestId: msg.requestId,
      toolName: msg.toolName,
      arguments: msg.arguments,
    }, '*');
    // Deliberately does NOT `return true`. A scoped review (2026-08-21)
    // found an earlier draft returned `true` here -- which tells Firefox
    // "I will call sendResponse() asynchronously" -- but this listener
    // never calls sendResponse(). background.js's browser.tabs.sendMessage()
    // call (Task 5) would then hang waiting for a response that never
    // arrives, recreating a timeout black hole (the request would only
    // resolve via the OUTER 90-100s native-messaging transport timeout,
    // not the intended 20s WEBMCP_CALL_TIMEOUT_MS). The actual call
    // result is delivered through the SEPARATE webmcp-tool-result/
    // webmcp-tool-error postMessage path above, not through this
    // listener's return value -- so this listener has nothing to respond
    // WITH, and must not claim it will.
  });
})();
