//
// Localhost-only HTTP server that a whitelisted page's synchronous XHR
// blocks against while its overridden alert()/confirm()/prompt() waits for
// an MCP-side decision (respond_dialog) or this file's own 30s timeout.
// Modeled on socket-server.js's token-auth pattern, but reachable over
// HTTP (127.0.0.1 only) instead of a Unix socket, since the caller is
// page-context JavaScript running in a whitelisted webpage, not a trusted
// local process.
//
// CORS is load-bearing here, not incidental: the page's synchronous XHR is
// a cross-origin request (page origin -> 127.0.0.1), using a custom header
// (X-Dialog-Token) and a non-simple content type (application/json), which
// forces the browser to send a CORS preflight (OPTIONS) before the real
// POST. Skip the Access-Control-* headers and EVERY request fails as a
// CORS error -- indistinguishable, from the page's side, from a CSP block
// -- silently making this feature never work on any site at all, not just
// CSP-restricted ones.
//
// See docs/superpowers/specs/2026-08-12-firefox-bridge-dialog-interception-design.md
// for the full design ("Why real synchronous control", "Fallback when the
// sync XHR itself can't be made", "Why no tabId").
import http from 'node:http';
import { randomBytes } from 'node:crypto';

const DIALOG_TIMEOUT_MS = 30_000;
const DIALOG_TYPES = new Set(['alert', 'confirm', 'prompt']);

// Shared by respond_dialog (action/text supplied) and this file's own 30s
// timeout (action/text both undefined -- every branch below falls through
// to each type's safe default in that case: alert -> undefined, confirm ->
// false (action !== 'accept'), prompt -> null (neither 'dismiss' nor
// 'accept' matched).
function resolveDialogValue(type, action, text, defaultText) {
  if (type === 'alert') return undefined;
  if (type === 'confirm') return action === 'accept';
  if (action === 'dismiss') return null;
  if (action === 'accept') return text !== undefined ? text : defaultText;
  return null; // 30s-timeout path for a prompt: no action was ever given
}

export class DialogServer {
  constructor() {
    this.server = null;
    this.port = null;
    this.token = null;
    // id -> { res, url, type, message, defaultText, openedAt, timer }
    this.pending = new Map();
  }

  async start() {
    this.token = randomBytes(32).toString('hex');
    this.server = http.createServer((req, res) => this._handleRequest(req, res));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      // Port 0 lets the OS assign an ephemeral port, avoiding collisions
      // with anything else already listening on the machine.
      this.server.listen(0, '127.0.0.1', resolve);
    });
    this.port = this.server.address().port;
    return { port: this.port, token: this.token };
  }

  async stop() {
    // Clear timers and destroy any pending connection sockets to prevent
    // server.close() from hanging (it only fires callback once ALL connections
    // are closed, but a never-resolved dialog's response connection stays open).
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.res.socket?.destroy();
    }
    this.pending.clear();
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
    }
  }

  listPending() {
    return [...this.pending.entries()].map(([id, entry]) => ({
      id,
      url: entry.url,
      type: entry.type,
      message: entry.message,
      defaultText: entry.defaultText,
      openedAt: entry.openedAt,
    }));
  }

  // Used both by respond_dialog (MCP-originated, action/text supplied) and
  // this file's own 30s timeout (called with just `id`).
  resolvePending(id, action, text) {
    const entry = this.pending.get(id);
    if (!entry) return { ok: false, error: 'not_found' };
    clearTimeout(entry.timer);
    this.pending.delete(id);
    const value = resolveDialogValue(entry.type, action, text, entry.defaultText);
    try {
      entry.res.writeHead(200, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
      });
      entry.res.end(JSON.stringify({ value }));
    } catch {
      // Dead connection (page navigated/closed) -- nothing to do; see the
      // design spec's "Why no tabId" section. There is no one left to
      // report this to either way.
    }
    return { ok: true };
  }

  _handleRequest(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Dialog-Token');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method !== 'POST' || req.url !== '/dialog') {
      res.writeHead(404);
      res.end();
      return;
    }
    if (req.headers['x-dialog-token'] !== this.token) {
      res.writeHead(401);
      res.end();
      return;
    }

    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('error', () => {
      // Connection died before the body finished -- nothing was registered
      // in `pending` yet (that happens in the 'end' handler below), so
      // there's nothing to clean up.
    });
    req.on('end', () => {
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
      const { id, url, type, message, defaultText } = msg;
      if (typeof id !== 'string' || !DIALOG_TYPES.has(type)) {
        res.writeHead(400);
        res.end();
        return;
      }

      const timer = setTimeout(() => this.resolvePending(id), DIALOG_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();

      this.pending.set(id, { res, url, type, message, defaultText, openedAt: Date.now(), timer });
    });
  }
}
