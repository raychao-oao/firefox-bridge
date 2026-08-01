import net from 'node:net';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { encodeMessage, createDecoder } from './native-messaging.js';

export class SocketServer extends EventEmitter {
  constructor({ socketDir, sessionManager }) {
    super();
    this.socketDir = socketDir;
    this.sessionManager = sessionManager;
    this.server = null;
    this.socketPath = path.join(socketDir, 'bridge.sock');
    this.tokenPath = path.join(socketDir, 'token');
    this.token = null;
  }

  async start() {
    await mkdir(this.socketDir, { recursive: true, mode: 0o700 });
    this.token = randomBytes(32).toString('hex');
    await writeFile(this.tokenPath, this.token, { mode: 0o600 });
    await unlink(this.socketPath).catch(() => {}); // clear stale socket file

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

    const decoder = createDecoder((msg) => {
      if (!authenticated) {
        if (msg.type === 'auth' && msg.token === this.token) {
          authenticated = true;
          session = { id: this.sessionManager.createSession() };
          socket.write(encodeMessage({ type: 'auth-ok', sessionId: session.id }));
        } else {
          socket.destroy();
        }
        return;
      }
      this.emit('request', msg, (result) => socket.write(encodeMessage(result)), session);
    });

    socket.on('data', (chunk) => decoder.push(chunk));
    socket.on('close', () => {
      if (session) this.sessionManager.destroySession(session.id);
    });
    socket.on('error', () => socket.destroy());
  }

  async stop() {
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
    }
    await unlink(this.socketPath).catch(() => {});
  }
}
