import path from 'node:path';
import { unlinkSync } from 'node:fs';
import { createDecoder, encodeMessage } from './native-messaging.js';
import { bridgeDir } from './bridge-dir.js';
import { PayloadStore } from './payload-store.js';
import { SessionManager } from './session-manager.js';
import { SocketServer } from './socket-server.js';

// A request forwarded to Firefox that never gets a reply (crashed background
// page, dropped native port) must not hang the CLI forever or leak a `pending`
// entry. Kept in sync with mcp-server/src/bridge-client.js.
//
// Timeout ordering constraint (see also extension/background.js's
// confirmationTimeoutMs comment): this value MUST stay comfortably larger
// than the extension's confirmationTimeoutMs (currently 60_000ms). Gated
// operations (blacklist confirmation popup) can legitimately take up to that
// long to resolve; if this timeout fires first, the CLI is told
// 'request_timeout' while the extension is still waiting on the user, and
// once the user responds the extension proceeds anyway with nothing left
// listening for the real reply (the `pending` entry was already deleted).
// Keep this >= confirmationTimeoutMs + real margin (not just +1ms), and keep
// mcp-server/src/bridge-client.js's REQUEST_TIMEOUT_MS >= this value.
const REQUEST_TIMEOUT_MS = 90_000;

async function acquireSingletonLock(dir) {
  const { open } = await import('node:fs/promises');
  const lockPath = path.join(dir, 'native-host.lock');
  try {
    const handle = await open(lockPath, 'wx'); // fails if the file already exists
    await handle.writeFile(String(process.pid));
    return { lockPath, handle };
  } catch (err) {
    if (err.code === 'EEXIST') {
      throw new Error(
        `Another native-host instance appears to be running (lock file: ${lockPath}). ` +
        `If this is stale, remove it manually and retry.`
      );
    }
    throw err;
  }
}

async function main() {
  const dir = bridgeDir();
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const lock = await acquireSingletonLock(dir);
  const cleanupLock = () => {
    try {
      unlinkSync(lock.lockPath);
    } catch {
      // already gone; ignore
    }
  };
  process.on('exit', cleanupLock);

  const sessionManager = new SessionManager();
  const payloadStore = new PayloadStore(path.join(dir, 'payloads'));
  // handle -> sessionId that created it. A handle is an unguessable UUID, but
  // capability-by-obscurity is not enough: only the session that produced a
  // payload may redeem it.
  const payloadOwners = new Map();
  const socketServer = new SocketServer({ socketDir: dir, sessionManager });
  await socketServer.start();

  // Pending requests sent to Firefox, keyed by requestId, so responses
  // (arriving async on stdin) can be routed back to the right socket client.
  // Value: { onReply(reply), settle(result), refresh() }.
  const pending = new Map();

  function track(requestId, respond, onReply) {
    let timer;
    const settle = (result) => {
      if (!pending.has(requestId)) return;
      clearTimeout(timer);
      pending.delete(requestId);
      respond(result);
    };
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => settle({ ok: false, error: 'request_timeout' }), REQUEST_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
    };
    pending.set(requestId, { onReply: (reply) => onReply(reply, settle, refresh), settle, refresh });
    refresh();
  }

  // Firefox's replies arrive on STDIN. A malformed/oversized frame must be
  // dropped, not allowed to throw out of the 'data' handler and take down the
  // singleton host. The decoder's internal buffer is unrecoverable once a
  // framing error occurs (we can't know where the next frame starts), so we
  // discard it by rebuilding the decoder.
  let stdinDecoder;
  const onFirefoxMessage = (msg) => {
    const waiter = pending.get(msg.requestId);
    if (waiter) waiter.onReply(msg);
  };
  const makeStdinDecoder = () => createDecoder(onFirefoxMessage);
  stdinDecoder = makeStdinDecoder();
  process.stdin.on('data', (chunk) => {
    try {
      stdinDecoder.push(chunk);
    } catch (err) {
      process.stderr.write(`native-host: dropping malformed native-messaging frame: ${err.message}\n`);
      stdinDecoder = makeStdinDecoder();
    }
  });

  function sendToFirefox(msg) {
    try {
      process.stdout.write(encodeMessage(msg));
      return true;
    } catch (err) {
      process.stderr.write(`native-host: failed to encode message for Firefox: ${err.message}\n`);
      return false;
    }
  }

  // When a CLI's socket closes, its leases/grants/buffers live extension-side,
  // so the extension must be told explicitly — otherwise the dead session's
  // tabs stay leased (and thus permanently `conflict`) forever.
  socketServer.on('session-ended', (sessionId) => {
    sendToFirefox({ type: 'session_end', sessionId, requestId: `session-end:${sessionId}` });
  });

  socketServer.on('request', async (msg, rawRespond, session) => {
    // Every response MUST carry the requestId or the client can't match it to
    // its pending call. Replies relayed from Firefox already have it; responses
    // this host synthesises (payload-read, reassembled screenshots, timeouts,
    // errors) would not, so stamp it here for all of them, authoritatively.
    const respond = (result) => rawRespond({ ...result, requestId: msg.requestId });

    if (msg.type === 'payload-read') {
      try {
        if (payloadOwners.get(msg.handle) !== session.id) {
          // Same response shape as a genuinely unknown handle, so a caller
          // can't distinguish "not yours" from "does not exist".
          respond({ ok: false, error: `unknown handle: ${msg.handle}` });
          return;
        }
        const data = await payloadStore.read(msg.handle);
        payloadOwners.delete(msg.handle);
        respond({ ok: true, dataBase64: data.toString('base64') });
      } catch (err) {
        respond({ ok: false, error: err.message });
      }
      return;
    }

    // Everything else is forwarded to the extension over native messaging and
    // the response is relayed back once Firefox replies.
    //
    // `sessionId` is stamped here from the authenticated socket session and
    // deliberately OVERRIDES anything the client sent: the socket auth is the
    // only legitimate source of session identity.
    const outbound = { ...msg, sessionId: session.id };

    // Screenshot responses arrive CHUNKED. A full-page retina PNG, base64'd,
    // routinely exceeds the 1 MiB native-messaging cap, so background.js splits
    // it into `{ok:true, type:'screenshot-chunk', requestId, chunkIndex,
    // totalChunks, data}` messages that all share the original requestId (so
    // this `pending` map still routes them). We reassemble here and hand the
    // MCP server an opaque PayloadStore handle — raw bytes never cross the
    // socket until the client explicitly redeems it via `payload-read`.
    const chunks = [];
    let received = 0;

    track(msg.requestId, respond, async (reply, settle, refresh) => {
      try {
        if (reply.type === 'screenshot-chunk') {
          if (chunks[reply.chunkIndex] === undefined) received += 1;
          chunks[reply.chunkIndex] = reply.data;
          if (received < reply.totalChunks) {
            refresh(); // more chunks coming; don't let the timeout fire mid-stream
            return;
          }
          const dataUrl = chunks.join(''); // "data:image/png;base64,...."
          const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
          const handle = await payloadStore.create(Buffer.from(base64, 'base64'));
          payloadOwners.set(handle, session.id);
          settle({ ok: true, handle });
          return;
        }
        settle(reply);
      } catch (err) {
        settle({ ok: false, error: err.message });
      }
    });

    if (!sendToFirefox(outbound)) {
      const waiter = pending.get(msg.requestId);
      if (waiter) waiter.settle({ ok: false, error: 'request_too_large' });
    }
  });

  const shutdown = async () => {
    // Lock removal is synchronous and reliable even if the async cleanup
    // below is slow, since process.exit() below will otherwise cut it off.
    cleanupLock();
    await socketServer.stop();
    await payloadStore.invalidateAll();
    payloadOwners.clear();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  process.stderr.write(`native-host fatal error: ${err.stack}\n`);
  process.exit(1);
});
