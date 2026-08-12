// repo/extension/dialog-whitelist.js
//
// Shared hostname-normalization logic for the dialog interception
// whitelist, used by extension/background.js's add_dialog_whitelist/
// remove_dialog_whitelist handlers. Unlike policy-gate.js's PolicyGate,
// there is no separate per-request "is this URL whitelisted" check needed
// here: browser.contentScripts.register()'s own `matches` pattern performs
// that gating natively -- Firefox itself decides whether to inject the
// dialog hook, not this file (see background.js's registerDialogHook).
// What DOES need sharing is hostname normalization. In practice, though,
// extension/options/options.js does NOT import this file -- it maintains
// its own separate (but logic-identical) `normalizeHostname` copy for its
// blacklist+whitelist UI. The consumers of THIS file's
// normalizeDialogHostname are background.js's add_dialog_whitelist/
// remove_dialog_whitelist handlers (the MCP-tool-driven path), which is
// where sharing this implementation actually matters today.
//
// Loaded as a plain background-page global (manifest.json's
// background.scripts, must be listed before background.js). Also
// require()'d directly from native-host/test/dialog-whitelist.test.js via
// createRequire, same dual-mode pattern as policy-gate.js.
function normalizeDialogHostname(value) {
  try {
    const hasScheme = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(value);
    const url = new URL(hasScheme ? value : `http://${value}`);
    return url.hostname || null;
  } catch {
    return null;
  }
}

if (typeof module !== 'undefined') {
  module.exports = { normalizeDialogHostname };
}
