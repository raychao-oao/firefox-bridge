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
  if (process.platform === 'win32') return;
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

test('"request" carries the authenticated session as its third argument', async () => {
  await withServer(async ({ server, socketPath, token }) => {
    const seen = new Promise((resolve) => {
      server.on('request', (msg, respond, session) => resolve(session));
    });
    const { socket, authAck } = await connectAndAuth(socketPath, token);
    socket.write(encodeMessage({ type: 'navigate' }));
    const session = await seen;
    assert.equal(typeof session.id, 'string');
    assert.equal(session.id, authAck.sessionId);
    socket.destroy();
  });
});

test('closing a socket emits "session-ended" with that session id', async () => {
  await withServer(async ({ server, socketPath, token }) => {
    const ended = new Promise((resolve) => server.on('session-ended', resolve));
    const { socket, authAck } = await connectAndAuth(socketPath, token);
    socket.destroy();
    assert.equal(await ended, authAck.sessionId);
  });
});

test('a malformed frame destroys only the offending connection, not the server', async () => {
  await withServer(async ({ server, socketPath, token }) => {
    const bad = await connectAndAuth(socketPath, token);
    const closed = new Promise((resolve) => bad.socket.on('close', resolve));
    // Length prefix beyond the socket cap: the decoder throws inside 'data'.
    const bogus = Buffer.alloc(8);
    bogus.writeUInt32LE(0xfffffff0, 0);
    bad.socket.write(bogus);
    await closed;

    // Server still alive and serving new clients.
    server.on('request', (msg, respond) => respond({ echoed: msg.payload }));
    const good = await connectAndAuth(socketPath, token);
    const reply = await new Promise((resolve) => {
      const decoder = createDecoder((msg) => resolve(msg));
      good.socket.on('data', (chunk) => decoder.push(chunk));
      good.socket.write(encodeMessage({ payload: 'still-here' }));
    });
    assert.deepEqual(reply, { echoed: 'still-here' });
    good.socket.destroy();
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
