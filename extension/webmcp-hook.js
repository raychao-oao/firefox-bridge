// repo/extension/webmcp-hook.js
//
// Builds the page-context (MAIN world) JS source injected into whitelisted
// hostnames via browser.contentScripts.register() in background.js. Not a
// content script itself -- a background-page global (manifest.json's
// background.scripts) exposing one function that RETURNS injectable
// source as a string, same structural pattern as extension/dialog-hook.js.
//
// Unlike dialog-hook.js, this shim needs NO port/token baked in -- WebMCP
// tool calls are async (Promise-based), so plain window.postMessage to the
// content script (relayed via browser.runtime.sendMessage) is sufficient;
// there's no need for dialog-hook.js's synchronous-XHR-to-a-local-server
// trick, which exists only because alert/confirm/prompt must return a real
// value synchronously to the page's calling code.
//
// See docs/superpowers/specs/2026-08-20-firefox-bridge-webmcp-shim-design.md
// ("Page-world shim" and "Message protocol") for the design this implements.
//
// Loaded as a plain background-page global (manifest.json's
// background.scripts, must be listed before background.js). Also
// require()'d directly from native-host/test/webmcp-hook.test.js via
// createRequire, same dual-mode pattern as dialog-hook.js.
function buildWebmcpHookSource() {
  return `
(function () {
  if (window.__firefoxBridgeWebmcpHookInstalled__) return; // idempotent
  window.__firefoxBridgeWebmcpHookInstalled__ = true;

  // toolName -> execute function. Never leaves this page-world closure --
  // only tool metadata (name/title/description/inputSchema/annotations)
  // crosses the postMessage boundary on registration. A real Map, not a
  // plain object -- tool names come from the page's own registerTool()
  // calls, but a plain object keyed by an arbitrary string still risks a
  // "__proto__"-shaped name silently hitting the prototype chain instead
  // of being stored.
  var toolExecutors = new Map();

  function post(type, payload) {
    window.postMessage(Object.assign({
      source: 'firefox-bridge-webmcp',
      version: 1,
      type: type,
    }, payload), '*');
  }

  document.modelContext = {
    registerTool: function (tool) {
      if (!tool || typeof tool.name !== 'string' || typeof tool.execute !== 'function') {
        throw new TypeError('registerTool requires at least {name: string, execute: function}');
      }
      toolExecutors.set(tool.name, tool.execute);
      post('tool.register', {
        tool: {
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations,
        },
      });
    },
  };

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var data = event.data;
    if (!data || data.source !== 'firefox-bridge-webmcp' || data.version !== 1) return;
    if (data.type !== 'tool.call') return;

    var requestId = data.requestId;
    var toolName = data.toolName;
    var executeFn = toolExecutors.get(toolName);
    if (typeof executeFn !== 'function') {
      post('tool.error', { requestId: requestId, error: 'unknown_tool: ' + toolName });
      return;
    }
    try {
      Promise.resolve(executeFn(data.arguments)).then(
        function (result) {
          // window.postMessage structured-clones its payload -- a result
          // containing something non-cloneable (a function, a DOM node, a
          // Symbol) would throw here with nothing catching it, silently
          // losing the result and leaving the caller to wait out the full
          // WEBMCP_CALL_TIMEOUT_MS for a misleading timeout instead of a
          // clear error. Caught explicitly below.
          try {
            post('tool.result', { requestId: requestId, result: result });
          } catch (postErr) {
            post('tool.error', { requestId: requestId, error: 'result_not_serializable: ' + (postErr && postErr.message ? postErr.message : String(postErr)) });
          }
        },
        function (err) {
          post('tool.error', { requestId: requestId, error: err && err.message ? err.message : String(err) });
        }
      );
    } catch (err) {
      post('tool.error', { requestId: requestId, error: err && err.message ? err.message : String(err) });
    }
  });
})();
`;
}

if (typeof module !== 'undefined') {
  module.exports = { buildWebmcpHookSource };
}
