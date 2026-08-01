import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { BridgeClient } from '../src/bridge-client.js';

// Encoding must match native-host's framing scheme (4-byte LE length + JSON).
function encode(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

function makeFakeServer(socketPath, token, { onRequest, onConnection, rejectAuth = false } = {}) {
  const server = net.createServer((socket) => {
    if (onConnection) onConnection(socket);
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const len = buf.readUInt32LE(0);
        if (buf.length < 4 + len) break;
        const msg = JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
        buf = buf.subarray(4 + len);
        if (msg.type === 'auth') {
          if (!rejectAuth && msg.token === token) {
            socket.write(encode({ type: 'auth-ok', sessionId: 's1' }));
          } else {
            socket.destroy();
          }
        } else if (onRequest) {
          onRequest(msg, (result) => socket.write(encode(result)));
        }
      }
    });
  });
  return new Promise((resolve) => server.listen(socketPath, () => resolve(server)));
}

async function withFakeServer(fn, { rejectAuth = false, respondToRequests = true } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'fb-bridge-client-test-'));
  const socketPath = path.join(dir, 'bridge.sock');
  const token = 'test-token-123';
  await writeFile(path.join(dir, 'token'), token, { mode: 0o600 });
  const requests = [];
  const sockets = [];
  const server = await makeFakeServer(socketPath, token, {
    rejectAuth,
    onConnection: (socket) => sockets.push(socket),
    onRequest: (msg, respond) => {
      requests.push(msg);
      if (respondToRequests) respond({ requestId: msg.requestId, ok: true, result: 'done' });
    },
  });
  try {
    await fn({ dir, requests, sockets, server });
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('connect() reads the token file and authenticates', async () => {
  await withFakeServer(async ({ dir }) => {
    const client = new BridgeClient({ socketDir: dir });
    await client.connect();
    client.close();
  });
});

test('call() attaches a requestId and resolves with the matching response', async () => {
  await withFakeServer(async ({ dir, requests }) => {
    const client = new BridgeClient({ socketDir: dir });
    await client.connect();
    const result = await client.call({ type: 'navigate', url: 'https://example.com' });
    assert.equal(result.ok, true);
    assert.equal(result.result, 'done');
    assert.equal(requests[0].type, 'navigate');
    assert.equal(typeof requests[0].requestId, 'string');
    client.close();
  });
});

test('connect() rejects (does not hang) when the server destroys the socket instead of sending auth-ok', async () => {
  await withFakeServer(async ({ dir }) => {
    const client = new BridgeClient({ socketDir: dir });
    await assert.rejects(
      () => client.connect(),
      /bridge authentication failed/,
    );
  }, { rejectAuth: true });
});

test('client emits session-reset when the server closes the connection after auth', async () => {
  await withFakeServer(async ({ dir, sockets }) => {
    const client = new BridgeClient({ socketDir: dir });
    await client.connect();

    const sessionReset = new Promise((resolve) => client.once('session-reset', resolve));
    assert.equal(sockets.length, 1);
    sockets[0].destroy();
    await sessionReset;

    client.close();
  });
});

test('a pending call() rejects when the server disconnects before responding', async () => {
  await withFakeServer(async ({ dir, sockets, requests }) => {
    const client = new BridgeClient({ socketDir: dir });
    await client.connect();

    const pendingCall = client.call({ type: 'navigate', url: 'https://example.com/never-responds' });
    // Wait until the server has actually received the request (it will never respond,
    // since respondToRequests is disabled for this server).
    while (requests.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(sockets.length, 1);
    sockets[0].destroy();

    await assert.rejects(() => pendingCall, /bridge connection lost/);
    client.close();
  }, { respondToRequests: false });
});
