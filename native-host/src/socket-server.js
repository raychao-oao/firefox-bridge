import net from 'node:net';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { bridgeSocketPath } from './bridge-dir.js';
import { encodeMessage, createDecoder, MAX_SOCKET_MESSAGE_BYTES } from './native-messaging.js';

const SOCKET_FRAME_OPTS = { maxBytes: MAX_SOCKET_MESSAGE_BYTES };

export class SocketServer extends EventEmitter {
  constructor({ socketDir, sessionManager }) {
    super();
    this.socketDir = socketDir;
    this.sessionManager = sessionManager;
    this.server = null;
    this.socketPath = bridgeSocketPath(socketDir);
    this.tokenPath = path.join(socketDir, 'token');
    this.token = null;
  }

  async start() {
    await mkdir(this.socketDir, { recursive: true, mode: 0o700 });
    this.token = randomBytes(32).toString('hex');
    await writeFile(this.tokenPath, this.token, { mode: 0o600 });
    if (process.platform !== 'win32') {
      await unlink(this.socketPath).catch(() => {}); // clear stale socket file
    }

    this.server = net.createServer((socket) => this._handleConnection(socket));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.socketPath, resolve);
    });

    return { socketPath: this.socketPath, token: this.token };
  }

  _handleConnection(socket) {
    let authenticated = false;
    let session = null;

    const respond = (result) => {
      try {
        socket.write(encodeMessage(result, SOCKET_FRAME_OPTS));
      } catch (err) {
        // Encoding failed (e.g. oversized frame). Report the failure to the
        // client rather than throwing out of an async handler and crashing the
        // singleton host.
        process.stderr.write(`socket-server: failed to encode response: ${err.message}\n`);
        try {
          socket.write(encodeMessage({ ok: false, error: 'response_too_large', requestId: result?.requestId }, SOCKET_FRAME_OPTS));
        } catch {
          socket.destroy();
        }
      }
    };

    const decoder = createDecoder((msg) => {
      if (!authenticated) {
        if (msg.type === 'auth' && msg.token === this.token) {
          authenticated = true;
          session = { id: this.sessionManager.createSession() };
          respond({ type: 'auth-ok', sessionId: session.id });
        } else {
          socket.destroy();
        }
        return;
      }
      this.emit('request', msg, respond, session);
    }, SOCKET_FRAME_OPTS);

    socket.on('data', (chunk) => {
      // A malformed or oversized frame must only kill THIS connection — never
      // the shared singleton process serving every other session.
      try {
        decoder.push(chunk);
      } catch (err) {
        process.stderr.write(`socket-server: dropping client after framing error: ${err.message}\n`);
        socket.destroy();
      }
    });
    socket.on('close', () => {
      if (session) {
        this.sessionManager.destroySession(session.id);
        // Let listeners (index.js) tell the extension to drop this session's
        // leases/grants/buffers, which live extension-side, not host-side.
        this.emit('session-ended', session.id);
      }
    });
    socket.on('error', () => socket.destroy());
  }

  async stop() {
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
    }
    if (process.platform !== 'win32') await unlink(this.socketPath).catch(() => {});
  }
}
