import net from 'node:net';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
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
    this.socketPath = path.join(socketDir, 'bridge.sock');
    this.tokenPath = path.join(socketDir, 'token');
    this.socket = null;
    this.pending = new Map(); // requestId -> {resolve, reject, timer}
  }

  async connect() {
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
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('bridge connection lost'));
    }
    this.pending.clear();
    this.emit('session-reset');
  }

  call(payload) {
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
    if (this.socket) this.socket.destroy();
  }
}
