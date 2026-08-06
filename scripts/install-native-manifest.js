// repo/scripts/install-native-manifest.js
import { writeFile, mkdir } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoDir = process.env.FIREFOX_BRIDGE_REPO_DIR
  ? path.resolve(process.env.FIREFOX_BRIDGE_REPO_DIR)
  : path.resolve(__dirname, '..');
const NATIVE_HOST_ENTRY = path.join(repoDir, 'native-host', 'src', 'index.js');
const HOST_NAME = 'firefox_bridge_native_host';

function manifestDirForPlatform() {
  if (process.env.FIREFOX_BRIDGE_MANIFEST_DIR) {
    return path.resolve(process.env.FIREFOX_BRIDGE_MANIFEST_DIR);
  }
  const home = homedir();
  switch (platform()) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Mozilla', 'NativeMessagingHosts');
    case 'linux':
      return path.join(home, '.mozilla', 'native-messaging-hosts');
    case 'win32':
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Mozilla', 'NativeMessagingHosts');
    default:
      throw new Error(
        `Unsupported platform for automatic native messaging manifest install: ${platform()}. ` +
        `See Firefox's native messaging docs for the manifest path on this OS and place it manually.`
      );
  }
}

async function writeLauncherScript(manifestDir) {
  // Firefox spawns whatever `path` the manifest points to directly; on most
  // systems that must be an executable, not a .js file handed to `node`.
  // A tiny shell launcher keeps the manifest pointing at something spawnable
  // without requiring native-host/src/index.js itself to have a shebang.
  // On win32 this writes a .cmd launcher instead (see below).
  //
  // Firefox launched from Finder/Dock gets a minimal PATH that typically
  // does NOT include Homebrew's /opt/homebrew/bin (Apple Silicon) or
  // /usr/local/bin (Intel) -- `exec node ...` would silently fail to find
  // node with no useful error surfaced back through the native messaging
  // port. Use the absolute path to the node binary that is running this
  // installer script (process.execPath) instead of relying on PATH.
  if (platform() === 'win32') {
    const launcherPath = path.join(manifestDir, '..', 'firefox-bridge-launch.cmd');
    const escapeBatch = (value) => value.replaceAll('%', '%%').replaceAll('"', '""');
    const script = `@echo off\r\n"${escapeBatch(process.execPath)}" "${escapeBatch(NATIVE_HOST_ENTRY)}"\r\n`;
    await writeFile(launcherPath, script);
    return launcherPath;
  }

  const launcherPath = path.join(manifestDir, '..', 'firefox-bridge-launch.sh');
  const script = `#!/bin/sh\nexec "${process.execPath}" "${NATIVE_HOST_ENTRY}"\n`;
  await writeFile(launcherPath, script, { mode: 0o755 });
  return launcherPath;
}

function registerWindowsManifest(manifestPath) {
  if (platform() !== 'win32') return;
  const key = `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${HOST_NAME}`;
  const result = spawnSync('reg.exe', ['add', key, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`Failed to register Firefox native messaging host: ${result.stderr || result.stdout}`);
  }
}

async function main() {
  const manifestDir = manifestDirForPlatform();
  await mkdir(manifestDir, { recursive: true });
  const launcherPath = await writeLauncherScript(manifestDir);

  const manifest = {
    name: HOST_NAME,
    description: 'firefox-bridge native messaging host',
    path: launcherPath,
    type: 'stdio',
    allowed_extensions: ['firefox-bridge@firefox-bridge.local'],
  };

  const manifestPath = path.join(manifestDir, `${HOST_NAME}.json`);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  registerWindowsManifest(manifestPath);

  console.log(`Installed native messaging manifest at: ${manifestPath}`);
  console.log(`Launcher script: ${launcherPath}`);
  if (platform() === 'win32') console.log('Registered the native messaging host under HKCU for Firefox.');
  console.log('Restart Firefox, then ensure the firefox-bridge extension is enabled.');
}

main().catch((err) => {
  console.error(`install-native-manifest failed: ${err.stack}`);
  process.exit(1);
});
