import net from 'node:net';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { bridgeSocketPath } from '@firefox-bridge/native-host/src/bridge-dir.js';
// Framing is imported from the native-host workspace package rather than
// re-implemented here, so the two ends of the socket can never drift apart
// (and so this side inherits the length-prefix bound).
import {
  encodeMessage,
  createDecoder,
  MAX_SOCKET_MESSAGE_BYTES,
} from '@firefox-bridge/native-host/src/native-messaging.js';

const SOCKET_FRAME_OPTS = { maxBytes: MAX_SOCKET_MESSAGE_BYTES };

// Must stay >= native-host/src/index.js's REQUEST_TIMEOUT_MS (currently
// 90_000ms), with a real margin on top. The host applies its own timeout to
// the Firefox hop and can legitimately take up to that long to resolve (e.g.
// waiting on a blacklist confirmation popup, or refreshing its timer across a
// multi-chunk screenshot transfer); this client-side timeout additionally
// covers the host itself going away mid-request, but must never fire before
// a legitimate host response would arrive. Ordering constraint (see also
// extension/background.js's confirmationTimeoutMs comment):
//   confirmationTimeoutMs < native-host REQUEST_TIMEOUT_MS < this value.
// Simplest robust rule: keep this = host timeout + margin (5-10s+), rather
// than trying to mirror the host's per-chunk refresh() here.
const HOST_REQUEST_TIMEOUT_MS = 90_000;
const REQUEST_TIMEOUT_MS = HOST_REQUEST_TIMEOUT_MS + 10_000;

export class BridgeClient extends EventEmitter {
  constructor({ socketDir, requestTimeoutMs = REQUEST_TIMEOUT_MS }) {
    super();
    this.socketDir = socketDir;
    this.requestTimeoutMs = requestTimeoutMs;
    this.socketPath = bridgeSocketPath(socketDir);
    this.tokenPath = path.join(socketDir, 'token');
    this.socket = null;
    this.pending = new Map(); // requestId -> {resolve, reject, timer}
    // `connected` gates call() -- false whenever there is no live, authenticated
    // socket (before the first connect, and for the whole reconnect window after
    // a disconnect). reconnectTimer is non-null only while a retry is pending, so
    // repeated close events (or a call() nudge, see below) don't stack timers.
    this.connected = false;
    this.reconnectTimer = null;
    // Set while a connect() call (initial or reconnect) is in flight, so
    // _handleDisconnect() can tell "this close event IS the auth handshake
    // failing" apart from "a previously-established connection just died".
    // Both fire the same socket 'close' event, but only the latter should
    // make _handleDisconnect() schedule its own retry -- otherwise it races
    // the reconnect loop's own catch block (which knows the correct,
    // already-backed-off delay) and stomps its retry via the
    // already-scheduled guard in _scheduleReconnect(). See use-codex review.
    this._connecting = false;
    // Set by close() so a deliberate shutdown doesn't get treated as a
    // connection loss to recover from.
    this._closing = false;
  }

  async connect() {
    this._connecting = true;
    try {
      const token = (await readFile(this.tokenPath, 'utf8')).trim();
      this.socket = net.createConnection(this.socketPath);
      const decoder = createDecoder((msg) => this._handleMessage(msg), SOCKET_FRAME_OPTS);
      this.socket.on('data', (chunk) => {
        // A framing error means the stream is unusable; treat it exactly like a
        // disconnect (reject pending calls) instead of throwing out of the
        // 'data' handler and killing the CLI's mcp-server process.
        try {
          decoder.push(chunk);
        } catch (err) {
          process.stderr.write(`bridge-client: framing error, dropping connection: ${err.message}\n`);
          this.socket.destroy();
        }
      });
      this.socket.on('close', () => this._handleDisconnect());

      await new Promise((resolve, reject) => {
        let settled = false;
        const onAuthFailureClose = () => {
          if (settled) return;
          settled = true;
          reject(new Error('bridge authentication failed'));
        };
        this.socket.once('connect', () => {
          this.socket.write(encodeMessage({ type: 'auth', token }, SOCKET_FRAME_OPTS));
        });
        this.socket.once('error', (err) => {
          if (settled) return;
          settled = true;
          reject(err);
        });
        this.socket.once('close', onAuthFailureClose);
        const authWaiter = (msg) => {
          if (msg.type === 'auth-ok') {
            settled = true;
            this.socket.off('close', onAuthFailureClose);
            this.sessionId = msg.sessionId;
            resolve();
          }
        };
        this._authWaiter = authWaiter;
      });

      this.connected = true;
    } finally {
      this._connecting = false;
    }
  }

  _handleMessage(msg) {
    if (this._authWaiter && msg.type === 'auth-ok') {
      this._authWaiter(msg);
      this._authWaiter = null;
      return;
    }
    const waiter = this.pending.get(msg.requestId);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.pending.delete(msg.requestId);
      waiter.resolve(msg);
    }
  }

  _handleDisconnect() {
    this.connected = false;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('bridge connection lost'));
    }
    this.pending.clear();
    this.emit('session-reset');
    // Skip if: a deliberate close() is in progress (nothing to recover), or
    // this close event is the connect()/reconnect attempt's OWN auth
    // handshake failing (that attempt's catch block in _scheduleReconnect
    // below schedules the next retry itself, with the correct backed-off
    // delay -- scheduling here too would double-schedule and, since
    // _scheduleReconnect no-ops while a timer is already pending, silently
    // discard the backed-off delay in favor of this call's default one).
    if (!this._closing && !this._connecting) {
      this._scheduleReconnect();
    }
  }

  // The native host restarts (with a fresh socket + auth token, see
  // socket-server.js's start()) any time the Firefox extension reloads --
  // auto-update, manual reload, or even toggling a permission in
  // about:addons. Without this, every call() after that point fails until
  // the user manually reconnects the MCP client. Mirrors the retry-with-
  // backoff extension/background.js already does for its own native-host
  // connection (connectToNativeHost's scheduleReconnect) -- this is the
  // same fix for the other leg of the bridge.
  _scheduleReconnect(delayMs = 500) {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
        process.stderr.write('bridge-client: reconnected to native host\n');
      } catch (err) {
        // Most likely cause: the native host hasn't finished respawning yet
        // (token/socket not written back out) or Firefox itself is closed.
        // Keep retrying with capped backoff rather than giving up -- there is
        // no user-facing action that would otherwise recover this.
        this._scheduleReconnect(Math.min(delayMs * 2, 5000));
      }
    }, delayMs);
    if (typeof this.reconnectTimer.unref === 'function') this.reconnectTimer.unref();
  }

  call(payload) {
    if (!this.connected) {
      // Resolve (not reject) with the same {ok:false, error} shape every
      // other failure uses -- e.g. request_timeout below -- so callers don't
      // need a separate rejection path. A reconnect is already in progress
      // (scheduled from _handleDisconnect); the very next call typically
      // succeeds once it lands.
      return Promise.resolve({ ok: false, error: 'bridge_disconnected' });
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      // No sessionId is attached here on purpose: the native host stamps the
      // authenticated session onto every forwarded message and ignores any
      // client-supplied value.
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ ok: false, error: 'request_timeout' });
      }, this.requestTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.socket.write(encodeMessage({ ...payload, requestId }, SOCKET_FRAME_OPTS));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(err);
      }
    });
  }

  close() {
    this._closing = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) this.socket.destroy();
  }
}
