import path from 'node:path';
import os from 'node:os';

// Single source of truth for where the control socket / token / payload files
// live. Shared by native-host and mcp-server (mcp-server depends on the
// native-host workspace package) so the two can never disagree about the path.
export function bridgeDir() {
  const base = process.env.XDG_RUNTIME_DIR || os.homedir();
  return process.env.XDG_RUNTIME_DIR
    ? path.join(base, 'firefox-bridge')
    : path.join(base, '.firefox-bridge');
}
