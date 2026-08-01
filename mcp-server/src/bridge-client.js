import net from 'node:net';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

function encode(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

function createDecoder(onMessage) {
  let buffer = Buffer.alloc(0);
  return {
    push(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const len = buffer.readUInt32LE(0);
        if (buffer.length < 4 + len) return;
        const jsonBytes = buffer.subarray(4, 4 + len);
        buffer = buffer.subarray(4 + len);
        onMessage(JSON.parse(jsonBytes.toString('utf8')));
      }
    },
  };
}

export class BridgeClient extends EventEmitter {
  constructor({ socketDir }) {
    super();
    this.socketDir = socketDir;
    this.socketPath = path.join(socketDir, 'bridge.sock');
    this.tokenPath = path.join(socketDir, 'token');
    this.socket = null;
    this.pending = new Map(); // requestId -> {resolve, reject}
  }

  async connect() {
    const token = (await readFile(this.tokenPath, 'utf8')).trim();
    this.socket = net.createConnection(this.socketPath);
    const decoder = createDecoder((msg) => this._handleMessage(msg));
    this.socket.on('data', (chunk) => decoder.push(chunk));
    this.socket.on('close', () => this._handleDisconnect());

    await new Promise((resolve, reject) => {
      this.socket.once('connect', () => {
        this.socket.write(encode({ type: 'auth', token }));
      });
      this.socket.once('error', reject);
      const authWaiter = (msg) => {
        if (msg.type === 'auth-ok') {
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
      this.pending.delete(msg.requestId);
      waiter.resolve(msg);
    }
  }

  _handleDisconnect() {
    for (const waiter of this.pending.values()) {
      waiter.reject(new Error('bridge connection lost'));
    }
    this.pending.clear();
    this.emit('session-reset');
  }

  call(payload) {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.socket.write(encode({ ...payload, requestId }));
    });
  }

  close() {
    if (this.socket) this.socket.destroy();
  }
}
