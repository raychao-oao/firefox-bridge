import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
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

function makeFakeServer(socketPath, token, { onRequest } = {}) {
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const len = buf.readUInt32LE(0);
        if (buf.length < 4 + len) break;
        const msg = JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
        buf = buf.subarray(4 + len);
        if (msg.type === 'auth') {
          if (msg.token === token) {
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

async function withFakeServer(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'fb-bridge-client-test-'));
  const socketPath = path.join(dir, 'bridge.sock');
  const token = 'test-token-123';
  await writeFile(path.join(dir, 'token'), token, { mode: 0o600 });
  const requests = [];
  const server = await makeFakeServer(socketPath, token, {
    onRequest: (msg, respond) => {
      requests.push(msg);
      respond({ requestId: msg.requestId, ok: true, result: 'done' });
    },
  });
  try {
    await fn({ dir, requests });
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
