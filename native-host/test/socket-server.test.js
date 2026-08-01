import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { SocketServer } from '../src/socket-server.js';
import { SessionManager } from '../src/session-manager.js';
import { encodeMessage, createDecoder } from '../src/native-messaging.js';

async function withServer(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'fb-socket-test-'));
  const server = new SocketServer({ socketDir: dir, sessionManager: new SessionManager() });
  const { socketPath, token } = await server.start();
  try {
    await fn({ server, socketPath, token, dir });
  } finally {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

function connectAndAuth(socketPath, token) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath, () => {
      socket.write(encodeMessage({ type: 'auth', token }));
    });
    const decoder = createDecoder((msg) => resolve({ socket, authAck: msg }));
    socket.on('data', (chunk) => decoder.push(chunk));
    socket.on('error', reject);
  });
}

test('start() creates a socket dir with 0700 perms and a token file with 0600 perms', async () => {
  await withServer(async ({ dir }) => {
    const dirStat = await stat(dir);
    assert.equal(dirStat.mode & 0o777, 0o700);
    const tokenStat = await stat(path.join(dir, 'token'));
    assert.equal(tokenStat.mode & 0o777, 0o600);
  });
});

test('a client that sends the correct token gets an auth-ok response', async () => {
  await withServer(async ({ socketPath, token }) => {
    const { authAck, socket } = await connectAndAuth(socketPath, token);
    assert.equal(authAck.type, 'auth-ok');
    socket.destroy();
  });
});

test('a client that sends the wrong token is disconnected', async () => {
  await withServer(async ({ socketPath }) => {
    await assert.rejects(async () => {
      await new Promise((resolve, reject) => {
        const socket = net.createConnection(socketPath, () => {
          socket.write(encodeMessage({ type: 'auth', token: 'wrong-token' }));
        });
        socket.on('close', () => reject(new Error('socket closed by server')));
        socket.on('error', reject);
      });
    }, /socket closed by server/);
  });
});

test('after auth, server emits "request" for subsequent messages and respond() writes framed JSON back', async () => {
  await withServer(async ({ server, socketPath, token }) => {
    server.on('request', (msg, respond) => {
      respond({ echoed: msg.payload });
    });
    const { socket } = await connectAndAuth(socketPath, token);
    const reply = await new Promise((resolve) => {
      const decoder = createDecoder((msg) => resolve(msg));
      socket.on('data', (chunk) => decoder.push(chunk));
      socket.write(encodeMessage({ payload: 'ping' }));
    });
    assert.deepEqual(reply, { echoed: 'ping' });
    socket.destroy();
  });
});
