// repo/scripts/sign-extension.js
//
// Signs extension/ as an unlisted (self-distributed) Firefox add-on via
// Mozilla's web-ext CLI, producing a permanently-installable .xpi. Unlisted
// signing is automated validation only (no human review) -- this is NOT
// publishing to the public AMO store.
//
// Requires AMO_API_KEY and AMO_API_SECRET in the environment (from
// https://addons.mozilla.org/en-US/developers/addon/api/key/). Deliberately
// read from env, never accepted as a CLI argument, so the credentials don't
// end up in shell history or process listings.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const EXTENSION_DIR = path.join(REPO_ROOT, 'extension');
const ARTIFACTS_DIR = path.join(REPO_ROOT, 'dist');

const apiKey = process.env.AMO_API_KEY;
const apiSecret = process.env.AMO_API_SECRET;

if (!apiKey || !apiSecret) {
  console.error(
    'Missing AMO_API_KEY / AMO_API_SECRET in the environment.\n' +
    'Get a key pair from https://addons.mozilla.org/en-US/developers/addon/api/key/ ' +
    'and export both before running this script:\n' +
    '  export AMO_API_KEY="..."\n' +
    '  export AMO_API_SECRET="..."'
  );
  process.exit(1);
}

function run(command, args) {
  console.log(`\n$ ${command} ${args.filter((a) => !a.includes(apiSecret)).join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: REPO_ROOT });
  if (result.status !== 0) {
    console.error(`\n${command} exited with status ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

// Validate the manifest/extension structure before spending a signing
// request on something that would just fail anyway.
run('npx', ['--yes', 'web-ext', 'lint', '--source-dir', EXTENSION_DIR]);

run('npx', [
  '--yes', 'web-ext', 'sign',
  '--source-dir', EXTENSION_DIR,
  '--artifacts-dir', ARTIFACTS_DIR,
  '--api-key', apiKey,
  '--api-secret', apiSecret,
  '--channel', 'unlisted',
]);

console.log(
  `\nSigned .xpi written to ${ARTIFACTS_DIR}/. Install it permanently via:\n` +
  '  - Drag the .xpi file into a Firefox window, or\n' +
  '  - about:addons -> gear icon -> "Install Add-on From File..."\n' +
  'Re-run this script after any change to extension/ and reinstall the new .xpi.'
);
