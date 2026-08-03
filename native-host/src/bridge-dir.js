import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

// Single source of truth for where the control socket / token / payload files
// live. Shared by native-host and mcp-server (mcp-server depends on the
// native-host workspace package) so the two can never disagree about the path.
export function bridgeDir() {
  const base = process.env.XDG_RUNTIME_DIR || os.homedir();
  return process.env.XDG_RUNTIME_DIR
    ? path.join(base, 'firefox-bridge')
    : path.join(base, '.firefox-bridge');
}

// Unix-domain sockets are filesystem paths, while Windows named pipes live in
// the \\.\pipe namespace. Hash the bridge directory so isolated test/runtime
// directories still get isolated pipes and both sides can derive the same name.
export function bridgeSocketPath(socketDir) {
  if (process.platform !== 'win32') return path.join(socketDir, 'bridge.sock');
  const id = createHash('sha256').update(path.resolve(socketDir).toLowerCase()).digest('hex').slice(0, 16);
  return `\\\\.\\pipe\\firefox-bridge-${id}`;
}
