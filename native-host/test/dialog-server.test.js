import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DialogServer } from '../src/dialog-server.js';

async function withServer(fn) {
  const server = new DialogServer();
  const { port, token } = await server.start();
  try {
    await fn({ server, port, token });
  } finally {
    await server.stop();
  }
}

// Raw http.request helper -- this is NOT a browser, so it can't reproduce a
// real CORS preflight, but it CAN assert the server sends the right
// Access-Control-* response headers, which is the actual regression this
// project needs guarded (see Global Constraints: CORS is load-bearing).
function postDialog(port, token, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/dialog',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          'x-dialog-token': token,
          ...extraHeaders,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function preflight(port) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/dialog', method: 'OPTIONS' },
      (res) => resolve({ status: res.statusCode, headers: res.headers })
    );
    req.on('error', reject);
    req.end();
  });
}

test('start() binds 127.0.0.1 on an OS-assigned port and returns a token', async () => {
  await withServer(async ({ port, token }) => {
    assert.equal(typeof port, 'number');
    assert.ok(port > 0);
    assert.equal(typeof token, 'string');
    assert.equal(token.length, 64); // randomBytes(32).toString('hex')
  });
});

test('OPTIONS preflight to /dialog gets CORS headers with no auth required', async () => {
  await withServer(async ({ port }) => {
    const res = await preflight(port);
    assert.equal(res.headers['access-control-allow-origin'], '*');
    assert.match(res.headers['access-control-allow-methods'], /POST/);
    assert.match(res.headers['access-control-allow-headers'], /X-Dialog-Token/i);
  });
});

test('POST /dialog without a token is rejected 401 and never appears in listPending', async () => {
  await withServer(async ({ server, port }) => {
    const res = await postDialog(port, 'wrong-token', { id: 'a', url: 'https://x', type: 'alert', message: 'hi' });
    assert.equal(res.status, 401);
    assert.deepEqual(server.listPending(), []);
  });
});

test('POST /dialog with a bad type is rejected 400', async () => {
  await withServer(async ({ port, token }) => {
    const res = await postDialog(port, token, { id: 'a', url: 'https://x', type: 'not-a-real-type', message: 'hi' });
    assert.equal(res.status, 400);
  });
});

test('a pending confirm dialog appears in listPending, and resolvePending releases the HTTP response', async () => {
  await withServer(async ({ server, port, token }) => {
    const responsePromise = postDialog(port, token, { id: 'd1', url: 'https://x/page', type: 'confirm', message: 'sure?' });
    // Give the request handler's 'end' listener a turn to register the pending entry.
    await new Promise((r) => setTimeout(r, 20));

    const pending = server.listPending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, 'd1');
    assert.equal(pending[0].url, 'https://x/page');
    assert.equal(pending[0].type, 'confirm');
    assert.equal(pending[0].message, 'sure?');

    const resolveResult = server.resolvePending('d1', 'accept');
    assert.deepEqual(resolveResult, { ok: true });

    const res = await responsePromise;
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { value: true });
    assert.deepEqual(server.listPending(), []);
  });
});

test('resolvePending "dismiss" on a confirm resolves false', async () => {
  await withServer(async ({ server, port, token }) => {
    const responsePromise = postDialog(port, token, { id: 'd2', url: 'https://x', type: 'confirm', message: 'sure?' });
    await new Promise((r) => setTimeout(r, 20));
    server.resolvePending('d2', 'dismiss');
    const res = await responsePromise;
    assert.deepEqual(JSON.parse(res.body), { value: false });
  });
});

test('resolvePending "accept" with text on a prompt resolves that text, not defaultText', async () => {
  await withServer(async ({ server, port, token }) => {
    const responsePromise = postDialog(port, token, {
      id: 'd3', url: 'https://x', type: 'prompt', message: 'name?', defaultText: 'default-val',
    });
    await new Promise((r) => setTimeout(r, 20));
    server.resolvePending('d3', 'accept', 'Ray');
    const res = await responsePromise;
    assert.deepEqual(JSON.parse(res.body), { value: 'Ray' });
  });
});

test('resolvePending "accept" with no text on a prompt falls back to defaultText', async () => {
  await withServer(async ({ server, port, token }) => {
    const responsePromise = postDialog(port, token, {
      id: 'd4', url: 'https://x', type: 'prompt', message: 'name?', defaultText: 'default-val',
    });
    await new Promise((r) => setTimeout(r, 20));
    server.resolvePending('d4', 'accept');
    const res = await responsePromise;
    assert.deepEqual(JSON.parse(res.body), { value: 'default-val' });
  });
});

test('resolvePending "dismiss" on a prompt resolves null, not an empty string', async () => {
  await withServer(async ({ server, port, token }) => {
    const responsePromise = postDialog(port, token, {
      id: 'd5', url: 'https://x', type: 'prompt', message: 'name?', defaultText: 'default-val',
    });
    await new Promise((r) => setTimeout(r, 20));
    server.resolvePending('d5', 'dismiss', 'ignored-because-dismiss');
    const res = await responsePromise;
    assert.deepEqual(JSON.parse(res.body), { value: null });
  });
});

test('resolvePending on an unknown id returns not_found', async () => {
  await withServer(async ({ server }) => {
    assert.deepEqual(server.resolvePending('nope'), { ok: false, error: 'not_found' });
  });
});

test('resolvePending twice on the same id returns not_found the second time', async () => {
  await withServer(async ({ server, port, token }) => {
    const responsePromise = postDialog(port, token, { id: 'd6', url: 'https://x', type: 'alert', message: 'hi' });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(server.resolvePending('d6', 'accept'), { ok: true });
    assert.deepEqual(server.resolvePending('d6', 'accept'), { ok: false, error: 'not_found' });
    await responsePromise;
  });
});

test('an alert always resolves to an undefined value regardless of action', async () => {
  await withServer(async ({ server, port, token }) => {
    const responsePromise = postDialog(port, token, { id: 'd7', url: 'https://x', type: 'alert', message: 'hi' });
    await new Promise((r) => setTimeout(r, 20));
    server.resolvePending('d7', 'dismiss');
    const res = await responsePromise;
    assert.equal(JSON.parse(res.body).value, undefined);
  });
});

test('two independent pending dialogs on different ids resolve independently', async () => {
  await withServer(async ({ server, port, token }) => {
    const p1 = postDialog(port, token, { id: 'x1', url: 'https://a', type: 'confirm', message: 'a?' });
    const p2 = postDialog(port, token, { id: 'x2', url: 'https://a', type: 'confirm', message: 'b?' });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(server.listPending().length, 2);
    server.resolvePending('x2', 'accept');
    server.resolvePending('x1', 'dismiss');
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.deepEqual(JSON.parse(r1.body), { value: false });
    assert.deepEqual(JSON.parse(r2.body), { value: true });
  });
});

test('stop() clears all pending timers so the process can exit cleanly', async () => {
  const server = new DialogServer();
  const { port, token } = await server.start();
  postDialog(port, token, { id: 'd8', url: 'https://x', type: 'alert', message: 'hi' }).catch(() => {});
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(server.listPending().length, 1);
  await server.stop();
  // No assertion beyond "this resolves and the process doesn't hang" --
  // node --test fails the run on a lingering timer keeping the event loop
  // alive past the test file's own completion.
});
