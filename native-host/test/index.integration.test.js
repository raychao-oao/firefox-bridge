// End-to-end test of native-host/src/index.js: spawns the real host process,
// plays the role of Firefox on its stdio, and the role of an MCP server on its
// control socket. Covers the wiring that unit tests can't see.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { encodeMessage, createDecoder, MAX_SOCKET_MESSAGE_BYTES } from '../src/native-messaging.js';
import { bridgeSocketPath } from '../src/bridge-dir.js';

const HOST_ENTRY = fileURLToPath(new URL('../src/index.js', import.meta.url));
const SOCKET_OPTS = { maxBytes: MAX_SOCKET_MESSAGE_BYTES };

function connectClient(socketDir) {
  return new Promise((resolve, reject) => {
    readFile(path.join(socketDir, 'token'), 'utf8').then((token) => {
      const socket = net.createConnection(bridgeSocketPath(socketDir));
      const pending = new Map();
      let sessionId = null;
      const decoder = createDecoder((msg) => {
        if (msg.type === 'auth-ok') {
          sessionId = msg.sessionId;
          resolve({
            sessionId: () => sessionId,
            call: (payload) => new Promise((res) => {
              const requestId = `req-${Math.random().toString(16).slice(2)}`;
              pending.set(requestId, res);
              socket.write(encodeMessage({ ...payload, requestId }, SOCKET_OPTS));
            }),
            close: () => socket.destroy(),
          });
          return;
        }
        const waiter = pending.get(msg.requestId);
        if (waiter) {
          pending.delete(msg.requestId);
          waiter(msg);
        }
      }, SOCKET_OPTS);
      socket.on('data', (chunk) => decoder.push(chunk));
      socket.on('error', reject);
      socket.on('connect', () => socket.write(encodeMessage({ type: 'auth', token }, SOCKET_OPTS)));
    }, reject);
  });
}

// Spins up the host with an isolated XDG_RUNTIME_DIR and a fake-Firefox
// responder attached to its stdio. `onRequest(msg, reply)` plays Firefox.
async function withHost(onRequest, fn) {
  const runtime = await mkdtemp(path.join(tmpdir(), 'fb-host-itest-'));
  const host = spawn(process.execPath, [HOST_ENTRY], {
    env: { ...process.env, XDG_RUNTIME_DIR: runtime },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  host.stderr.resume(); // drain; the host logs dropped frames here by design
  const reply = (msg) => host.stdin.write(encodeMessage(msg));
  const decoder = createDecoder((msg) => onRequest(msg, reply));
  host.stdout.on('data', (chunk) => decoder.push(chunk));

  const socketDir = path.join(runtime, 'firefox-bridge');
  // Wait for the host to publish its token + socket.
  let client;
  for (let i = 0; i < 100 && !client; i += 1) {
    try {
      client = await connectClient(socketDir);
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  assert.ok(client, 'host never became connectable');

  try {
    await fn({ client, socketDir, host, connect: () => connectClient(socketDir) });
  } finally {
    client.close();
    if (host.exitCode === null && host.signalCode === null) {
      const exited = once(host, 'exit');
      host.kill('SIGTERM');
      await exited;
    }
    await rm(runtime, { recursive: true, force: true });
  }
}

function makeDataUrl(byteLength) {
  return `data:image/png;base64,${Buffer.alloc(byteLength, 0x41).toString('base64')}`;
}

function sendScreenshotChunks(reply, requestId, dataUrl, chunkChars) {
  const total = Math.ceil(dataUrl.length / chunkChars);
  for (let i = 0; i < total; i += 1) {
    reply({
      ok: true,
      type: 'screenshot-chunk',
      requestId,
      chunkIndex: i,
      totalChunks: total,
      data: dataUrl.slice(i * chunkChars, (i + 1) * chunkChars),
    });
  }
  return total;
}

test('forwarded messages are stamped with the authenticated session id, overriding any client-supplied value', async () => {
  await withHost(
    (msg, reply) => reply({ ok: true, sawSessionId: msg.sessionId, requestId: msg.requestId }),
    async ({ client }) => {
      const res = await client.call({ type: 'echo', sessionId: 'ATTACKER-SUPPLIED' });
      assert.equal(res.sawSessionId, client.sessionId());
      assert.notEqual(res.sawSessionId, 'ATTACKER-SUPPLIED');
    }
  );
});

test('an oversized screenshot is reassembled from chunks and redeemable byte-for-byte', async () => {
  const PNG_BYTES = 2_500_000; // ~3.3 MB as base64: far past the 1 MiB native-messaging cap
  await withHost(
    (msg, reply) => {
      if (msg.type === 'screenshot') {
        const total = sendScreenshotChunks(reply, msg.requestId, makeDataUrl(PNG_BYTES), 700 * 1024);
        assert.ok(total > 1, 'test payload must actually require chunking');
      }
    },
    async ({ client }) => {
      const shot = await client.call({ type: 'screenshot', tabId: 1 });
      assert.equal(shot.ok, true);
      assert.equal(typeof shot.handle, 'string');

      const payload = await client.call({ type: 'payload-read', handle: shot.handle });
      assert.equal(payload.ok, true);
      const bytes = Buffer.from(payload.dataBase64, 'base64');
      assert.equal(bytes.length, PNG_BYTES);
      assert.ok(bytes.every((b) => b === 0x41));
    }
  );
});

test('a payload handle cannot be redeemed by a different session', async () => {
  await withHost(
    (msg, reply) => {
      if (msg.type === 'screenshot') {
        sendScreenshotChunks(reply, msg.requestId, makeDataUrl(64), 1024);
      }
    },
    async ({ client, connect }) => {
      const shot = await client.call({ type: 'screenshot', tabId: 1 });
      const other = await connect();
      const stolen = await other.call({ type: 'payload-read', handle: shot.handle });
      assert.equal(stolen.ok, false);
      assert.match(stolen.error, /unknown handle/);
      other.close();
    }
  );
});

test('a closed client socket produces a session_end notification to Firefox', async () => {
  let resolveEnd;
  const ended = new Promise((r) => { resolveEnd = r; });
  await withHost(
    (msg) => {
      if (msg.type === 'session_end') resolveEnd(msg.sessionId);
    },
    async ({ connect }) => {
      const other = await connect();
      const id = other.sessionId();
      other.close();
      assert.equal(await ended, id);
    }
  );
});

test('starting the host pushes dialog_server_ready to Firefox with a port and token', async () => {
  let sawReady;
  const readyPromise = new Promise((resolve) => { sawReady = resolve; });
  await withHost(
    (msg, reply) => {
      if (msg.type === 'dialog_server_ready') sawReady(msg);
    },
    async () => {
      const msg = await Promise.race([
        readyPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('dialog_server_ready never arrived')), 5000)),
      ]);
      assert.equal(typeof msg.port, 'number');
      assert.ok(msg.port > 0);
      assert.equal(typeof msg.token, 'string');
      assert.equal(msg.token.length, 64);
    }
  );
});

test('list_dialogs and respond_dialog are answered by the host directly, never forwarded to Firefox', async () => {
  let sawUnexpectedForward = false;
  await withHost(
    (msg, reply) => {
      if (msg.type === 'list_dialogs' || msg.type === 'respond_dialog') {
        sawUnexpectedForward = true;
        reply({ ok: false, error: 'should never reach Firefox', requestId: msg.requestId });
      }
    },
    async ({ client }) => {
      const listRes = await client.call({ type: 'list_dialogs' });
      assert.deepEqual(listRes.dialogs, []);
      assert.equal(sawUnexpectedForward, false);

      const respondRes = await client.call({ type: 'respond_dialog', id: 'does-not-exist', action: 'accept' });
      assert.deepEqual(respondRes, { ok: false, error: 'not_found', requestId: respondRes.requestId });
      assert.equal(sawUnexpectedForward, false);
    }
  );
});

test('a dialog POSTed to the dialog server appears in list_dialogs and can be answered via respond_dialog', async () => {
  await withHost(
    () => {}, // this test's dialog traffic never touches the Firefox side at all
    async ({ client, socketDir }) => {
      // A full page -> dialog-server -> respond_dialog round trip is
      // covered by dialog-server.test.js (HTTP-level, same process) and the
      // manual verification checklist (real browser) -- driving it from
      // here would need this harness to parse the dynamically-assigned
      // port out of dialog_server_ready and open a second raw HTTP
      // connection across the test's process boundary, which is more
      // test-only plumbing than the marginal coverage is worth.
      const listRes = await client.call({ type: 'list_dialogs' });
      assert.deepEqual(listRes.dialogs, []);
    }
  );
});

test('a malformed frame from Firefox does not kill the singleton host', async () => {
  await withHost(
    (msg, reply) => reply({ ok: true, requestId: msg.requestId }),
    async ({ client, host }) => {
      const bogus = Buffer.alloc(8);
      bogus.writeUInt32LE(0xfffffff0, 0); // length prefix way past the cap
      host.stdin.write(bogus);
      await new Promise((r) => setTimeout(r, 200));

      assert.equal(host.exitCode, null);
      assert.equal(host.signalCode, null);
      const after = await client.call({ type: 'echo' });
      assert.equal(after.ok, true); // still serving
    }
  );
});

test('a second host started while the first is alive refuses to run', async () => {
  await withHost(
    () => {},
    async ({ socketDir }) => {
      const runtime = path.dirname(socketDir);
      const second = spawn(process.execPath, [HOST_ENTRY], {
        env: { ...process.env, XDG_RUNTIME_DIR: runtime },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stderr = '';
      second.stderr.on('data', (chunk) => { stderr += chunk; });
      second.stdout.resume();
      const [code] = await once(second, 'exit');

      assert.equal(code, 1);
      assert.match(stderr, /Another native-host instance appears to be running/);
    }
  );
});

test('a stale lock left by a killed host is taken over by the next one', async () => {
  const runtime = await mkdtemp(path.join(tmpdir(), 'fb-host-itest-'));
  try {
    const first = spawn(process.execPath, [HOST_ENTRY], {
      env: { ...process.env, XDG_RUNTIME_DIR: runtime },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    first.stderr.resume();
    first.stdout.resume();
    const socketDir = path.join(runtime, 'firefox-bridge');
    let client;
    for (let i = 0; i < 100 && !client; i += 1) {
      try {
        client = await connectClient(socketDir);
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    assert.ok(client, 'first host never became connectable');
    client.close();

    // SIGKILL bypasses the process.on('exit', ...) lock cleanup, leaving a
    // stale lock file behind -- the scenario acquireSingletonLock's dead-PID
    // takeover exists to handle.
    first.kill('SIGKILL');
    await once(first, 'exit');

    const second = spawn(process.execPath, [HOST_ENTRY], {
      env: { ...process.env, XDG_RUNTIME_DIR: runtime },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    second.stderr.resume();
    second.stdout.resume();
    try {
      let secondClient;
      for (let i = 0; i < 100 && !secondClient; i += 1) {
        try {
          secondClient = await connectClient(socketDir);
        } catch {
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      assert.ok(secondClient, 'second host never took over the stale lock');
      secondClient.close();
    } finally {
      if (second.exitCode === null && second.signalCode === null) {
        const exited = once(second, 'exit');
        second.kill('SIGTERM');
        await exited;
      }
    }
  } finally {
    await rm(runtime, { recursive: true, force: true });
  }
});
