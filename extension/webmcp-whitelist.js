// repo/extension/webmcp-whitelist.js
//
// Shared hostname-normalization logic for the WebMCP shim's whitelist, used
// by extension/background.js's add_webmcp_whitelist/remove_webmcp_whitelist
// handlers. Deliberately independent of extension/dialog-whitelist.js's
// normalizeDialogHostname despite identical logic -- the two whitelists
// (dialogWhitelist, webmcpWhitelist) gate different capabilities ("allow
// alert/confirm/prompt interception" vs "allow AI to call this page's
// registered tools") and are kept as separately editable subsystems, per
// docs/superpowers/specs/2026-08-20-firefox-bridge-webmcp-shim-design.md.
//
// Loaded as a plain background-page global (manifest.json's
// background.scripts). Also require()'d directly from
// native-host/test/webmcp-whitelist.test.js via createRequire, same
// dual-mode pattern as dialog-whitelist.js.
function normalizeWebmcpHostname(value) {
  try {
    const hasScheme = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(value);
    const url = new URL(hasScheme ? value : `http://${value}`);
    return url.hostname || null;
  } catch {
    return null;
  }
}

// Subdomain-safe membership check -- contentScripts.register()'s matches
// (Task 3) covers both `hostname` and `*.hostname`, so authorization must
// accept the same set or it will reject a legitimately shim-injected
// subdomain. This is the ONE function every whitelist check in this
// feature must call -- never a bespoke `.includes()`.
function isWebmcpHostnameAllowed(hostname, whitelist) {
  if (!hostname) return false;
  return whitelist.some((allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`));
}

if (typeof module !== 'undefined') {
  module.exports = { normalizeWebmcpHostname, isWebmcpHostnameAllowed };
}
