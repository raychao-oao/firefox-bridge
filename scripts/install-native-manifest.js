// repo/scripts/install-native-manifest.js
import { writeFile, mkdir, chmod } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NATIVE_HOST_ENTRY = path.resolve(__dirname, '../native-host/src/index.js');
const HOST_NAME = 'firefox_bridge_native_host';

function manifestDirForPlatform() {
  const home = homedir();
  switch (platform()) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Mozilla', 'NativeMessagingHosts');
    case 'linux':
      return path.join(home, '.mozilla', 'native-messaging-hosts');
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
  // without requiring native-host/src/index.js itself to have a shebang
  // (Windows compatibility, if ever added, would need a .bat variant instead).
  const launcherPath = path.join(manifestDir, '..', 'firefox-bridge-launch.sh');
  const script = `#!/bin/sh\nexec node "${NATIVE_HOST_ENTRY}"\n`;
  await writeFile(launcherPath, script, { mode: 0o755 });
  await chmod(launcherPath, 0o755);
  return launcherPath;
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

  console.log(`Installed native messaging manifest at: ${manifestPath}`);
  console.log(`Launcher script: ${launcherPath}`);
  console.log('Restart Firefox, then load the extension from repo/extension/manifest.json via about:debugging.');
}

main().catch((err) => {
  console.error(`install-native-manifest failed: ${err.stack}`);
  process.exit(1);
});
