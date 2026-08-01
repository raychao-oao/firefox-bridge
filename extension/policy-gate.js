// repo/extension/policy-gate.js
//
// Authored as a plain (CommonJS-compatible) script, not an ES module: it
// loads directly as a Firefox MV2 background-page script (via
// manifest.json's "scripts" array, Task 10) with no bundler and no `type:
// module`, and `export` syntax would be a SyntaxError there. The
// `module.exports` branch only runs under Node (native-host's test suite);
// browsers never define `module`, so `PolicyGate` is simply left as a
// background-page global there.
class PolicyGate {
  constructor({ blacklist, confirmationTimeoutMs = 60000 }) {
    this.blacklist = blacklist;
    this.confirmationTimeoutMs = confirmationTimeoutMs;
  }

  isBlacklisted(url) {
    let hostname;
    try {
      hostname = new URL(url).hostname;
    } catch {
      return false;
    }
    return this.blacklist.some((entry) => hostname === entry || hostname.endsWith(`.${entry}`));
  }

  checkUrl(url, { onceGrants, sessionGrants, sessionId }) {
    if (!this.isBlacklisted(url)) return 'allow';
    if (onceGrants.has(url)) return 'allow';
    const hostname = new URL(url).hostname;
    const sessionSet = sessionGrants.get(sessionId);
    if (sessionSet && sessionSet.has(hostname)) return 'allow';
    return 'needs_confirmation';
  }
}

if (typeof module !== 'undefined') {
  module.exports = { PolicyGate };
}
