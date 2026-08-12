// Builds the page-context (MAIN world) JS source injected into whitelisted
// hostnames via browser.contentScripts.register() in background.js. Not a
// content script itself -- a background-page global (manifest.json's
// background.scripts) exposing one function that RETURNS injectable
// source as a string, since contentScripts.register()'s `code` option
// needs each hostname's current port/token baked in at registration time
// (the injected script runs in the page's own JS world, with no access to
// browser.* APIs to fetch them itself).
//
// See docs/superpowers/specs/2026-08-12-firefox-bridge-dialog-interception-design.md
// ("Fallback when the sync XHR itself can't be made" and "Why real
// synchronous control") for the design this implements.
//
// Loaded as a plain background-page global (manifest.json's
// background.scripts, must be listed before background.js). Also
// require()'d directly from native-host/test/dialog-hook.test.js via
// createRequire, same dual-mode pattern as policy-gate.js.
function buildDialogHookSource({ port, token }) {
  // JSON.stringify (not raw template interpolation) so a token or port
  // value can never break out of the generated string/number literal.
  const portLiteral = JSON.stringify(port);
  const tokenLiteral = JSON.stringify(token);

  return `
(function () {
  if (window.__firefoxBridgeDialogHookInstalled__) return; // idempotent
  window.__firefoxBridgeDialogHookInstalled__ = true;

  var PORT = ${portLiteral};
  var TOKEN = ${tokenLiteral};
  var nativeAlert = window.alert;
  var nativeConfirm = window.confirm;
  var nativePrompt = window.prompt;

  function sendDialogRequest(type, message, defaultText) {
    var xhr = new XMLHttpRequest();
    // Synchronous (third arg to open() is 'async'; false makes it
    // synchronous) -- deprecated but still functional in Firefox, and the
    // only way this override can return a real value to the page's
    // calling code the same way the native blocking dialog would have.
    xhr.open('POST', 'http://127.0.0.1:' + PORT + '/dialog', false);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('X-Dialog-Token', TOKEN);
    xhr.send(JSON.stringify({
      id: crypto.randomUUID(),
      url: location.href,
      type: type,
      message: message,
      defaultText: defaultText,
    }));
    if (xhr.status !== 200) {
      throw new Error('dialog server responded with status ' + xhr.status);
    }
    return JSON.parse(xhr.responseText).value;
  }

  window.alert = function (message) {
    try {
      sendDialogRequest('alert', message);
    } catch (e) {
      nativeAlert.call(window, message);
    }
  };

  window.confirm = function (message) {
    try {
      return sendDialogRequest('confirm', message);
    } catch (e) {
      return nativeConfirm.call(window, message);
    }
  };

  window.prompt = function (message, defaultText) {
    try {
      return sendDialogRequest('prompt', message, defaultText);
    } catch (e) {
      return nativePrompt.call(window, message, defaultText);
    }
  };
})();
`;
}

if (typeof module !== 'undefined') {
  module.exports = { buildDialogHookSource };
}
