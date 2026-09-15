// repo/scripts/install-native-manifest.js
import { writeFile, mkdir } from 'node:fs/promises';
import { realpathSync, existsSync } from 'node:fs';
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

// Per-browser vendor dir name used in each platform's native-messaging-hosts
// path. "firefox" -> Mozilla is the only one live-verified (macOS: confirmed
// by launching LibreWolf and inspecting ~/Library/Application Support/;
// Linux: per LibreWolf's own native-messaging docs). The win32 LibreWolf
// entries follow the same Mozilla->LibreWolf renaming pattern by analogy but
// are NOT independently verified -- test before relying on them.
const BROWSER_VENDOR_DIR = {
  firefox: 'Mozilla',
  librewolf: 'LibreWolf',
};

function resolveBrowser() {
  const arg = process.argv.find((a) => a.startsWith('--browser='));
  const browser = (arg ? arg.slice('--browser='.length) : process.env.FIREFOX_BRIDGE_BROWSER || 'firefox').toLowerCase();
  if (!(browser in BROWSER_VENDOR_DIR)) {
    throw new Error(`Unknown --browser value: ${browser}. Supported: ${Object.keys(BROWSER_VENDOR_DIR).join(', ')}`);
  }
  return browser;
}

function manifestDirForPlatform(browser) {
  if (process.env.FIREFOX_BRIDGE_MANIFEST_DIR) {
    return path.resolve(process.env.FIREFOX_BRIDGE_MANIFEST_DIR);
  }
  const home = homedir();
  const vendorDir = BROWSER_VENDOR_DIR[browser];
  switch (platform()) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', vendorDir, 'NativeMessagingHosts');
    case 'linux':
      // Firefox: ~/.mozilla/native-messaging-hosts
      // LibreWolf: ~/.librewolf/native-messaging-hosts (LibreWolf's documented
      // location; some newer LibreWolf versions also read the Mozilla path,
      // but the LibreWolf-specific one works across versions).
      return path.join(home, `.${vendorDir.toLowerCase()}`, 'native-messaging-hosts');
    case 'win32':
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), vendorDir, 'NativeMessagingHosts');
    default:
      throw new Error(
        `Unsupported platform for automatic native messaging manifest install: ${platform()}. ` +
        `See Firefox's native messaging docs for the manifest path on this OS and place it manually.`
      );
  }
}

// process.execPath resolves through symlinks to the real versioned binary
// (e.g. /opt/homebrew/Cellar/node/26.4.0/bin/node) rather than the stable
// Homebrew symlink (/opt/homebrew/bin/node). Every `brew upgrade node` moves
// that real path, silently breaking the launcher until this script is rerun.
// Prefer the stable symlink when it actually resolves to the same binary
// currently running this installer.
function resolveStableNodePath() {
  const candidates = ['/opt/homebrew/bin/node', '/usr/local/bin/node'];
  for (const candidate of candidates) {
    if (existsSync(candidate) && realpathSync(candidate) === realpathSync(process.execPath)) {
      return candidate;
    }
  }
  return process.execPath;
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
  // installer script (resolveStableNodePath()) instead of relying on PATH.
  const nodePath = resolveStableNodePath();

  if (platform() === 'win32') {
    const launcherPath = path.join(manifestDir, '..', 'firefox-bridge-launch.cmd');
    const escapeBatch = (value) => value.replaceAll('%', '%%').replaceAll('"', '""');
    const script = `@echo off\r\n"${escapeBatch(nodePath)}" "${escapeBatch(NATIVE_HOST_ENTRY)}"\r\n`;
    await writeFile(launcherPath, script);
    return launcherPath;
  }

  const launcherPath = path.join(manifestDir, '..', 'firefox-bridge-launch.sh');
  const script = `#!/bin/sh\nexec "${nodePath}" "${NATIVE_HOST_ENTRY}"\n`;
  await writeFile(launcherPath, script, { mode: 0o755 });
  return launcherPath;
}

function registerWindowsManifest(manifestPath, browser) {
  if (platform() !== 'win32') return;
  const key = `HKCU\\Software\\${BROWSER_VENDOR_DIR[browser]}\\NativeMessagingHosts\\${HOST_NAME}`;
  const result = spawnSync('reg.exe', ['add', key, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`Failed to register ${browser} native messaging host: ${result.stderr || result.stdout}`);
  }
}

async function main() {
  const browser = resolveBrowser();
  const manifestDir = manifestDirForPlatform(browser);
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
  registerWindowsManifest(manifestPath, browser);

  console.log(`Installed native messaging manifest at: ${manifestPath}`);
  console.log(`Launcher script: ${launcherPath}`);
  if (platform() === 'win32') console.log(`Registered the native messaging host under HKCU for ${browser}.`);
  console.log(`Restart ${browser}, then ensure the firefox-bridge extension is enabled.`);
}

main().catch((err) => {
  console.error(`install-native-manifest failed: ${err.stack}`);
  process.exit(1);
});
