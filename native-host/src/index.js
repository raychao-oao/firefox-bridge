import path from 'node:path';
import os from 'node:os';
import { unlinkSync } from 'node:fs';
import { createDecoder, encodeMessage } from './native-messaging.js';
import { PayloadStore } from './payload-store.js';
import { SessionManager } from './session-manager.js';
import { SocketServer } from './socket-server.js';

function bridgeDir() {
  const base = process.env.XDG_RUNTIME_DIR || os.homedir();
  return process.env.XDG_RUNTIME_DIR
    ? path.join(base, 'firefox-bridge')
    : path.join(base, '.firefox-bridge');
}

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
  const socketServer = new SocketServer({ socketDir: dir, sessionManager });
  await socketServer.start();

  // Pending requests sent to Firefox, keyed by requestId, so responses
  // (arriving async on stdin) can be routed back to the right socket client.
  const pending = new Map();

  const stdoutDecoder = createDecoder((msg) => {
    const waiter = pending.get(msg.requestId);
    if (waiter) {
      pending.delete(msg.requestId);
      waiter(msg);
    }
  });
  process.stdin.on('data', (chunk) => stdoutDecoder.push(chunk));

  socketServer.on('request', async (msg, respond) => {
    if (msg.type === 'payload-read') {
      try {
        const data = await payloadStore.read(msg.handle);
        respond({ ok: true, dataBase64: data.toString('base64') });
      } catch (err) {
        respond({ ok: false, error: err.message });
      }
      return;
    }
    // Everything else is forwarded to the extension over native messaging
    // and the response is relayed back once Firefox replies.
    pending.set(msg.requestId, (reply) => respond(reply));
    process.stdout.write(encodeMessage(msg));
  });

  const shutdown = async () => {
    // Lock removal is synchronous and reliable even if the async cleanup
    // below is slow, since process.exit() below will otherwise cut it off.
    cleanupLock();
    await socketServer.stop();
    await payloadStore.invalidateAll();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  process.stderr.write(`native-host fatal error: ${err.stack}\n`);
  process.exit(1);
});
