// repo/native-host/test/bookmark-helpers.test.js
//
// bookmark-helpers.js ships under extension/, which has no package.json of
// its own and inherits CommonJS from the repo root's package.json (no
// "type": "module" there) — Firefox background-page scripts are also plain
// (non-ESM) scripts. So bookmark-helpers.js is authored as CommonJS with a
// dual-mode export (see policy-gate.js for the established pattern), and
// this test loads it via createRequire rather than a static `import`, since
// native-host's own package.json sets "type": "module" but that only
// governs files inside native-host/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseFolderPath, isPrivateAddress, needsTitleWarning } = require('../../extension/bookmark-helpers.js');

test('parseFolderPath splits on / and trims each segment', () => {
  assert.deepEqual(parseFolderPath('Tech/AI'), ['Tech', 'AI']);
  assert.deepEqual(parseFolderPath(' Tech / AI '), ['Tech', 'AI']);
});

test('parseFolderPath drops empty segments from leading/trailing/double slashes', () => {
  assert.deepEqual(parseFolderPath('/A/'), ['A']);
  assert.deepEqual(parseFolderPath('A//B'), ['A', 'B']);
  assert.deepEqual(parseFolderPath('//'), []);
});

test('parseFolderPath returns empty array for empty/whitespace-only/undefined input', () => {
  assert.deepEqual(parseFolderPath(''), []);
  assert.deepEqual(parseFolderPath('   '), []);
  assert.deepEqual(parseFolderPath(undefined), []);
});

test('isPrivateAddress matches RFC 1918 ranges', () => {
  assert.equal(isPrivateAddress('10.0.0.1'), true);
  assert.equal(isPrivateAddress('172.16.0.1'), true);
  assert.equal(isPrivateAddress('172.31.255.255'), true);
  assert.equal(isPrivateAddress('192.168.1.1'), true);
});

test('isPrivateAddress rejects public IPv4 and adjacent-but-out-of-range values', () => {
  assert.equal(isPrivateAddress('8.8.8.8'), false);
  assert.equal(isPrivateAddress('172.32.0.1'), false); // just outside 172.16.0.0/12
  assert.equal(isPrivateAddress('172.15.255.255'), false); // just outside on the other side
});

test('isPrivateAddress matches loopback (127.0.0.0/8, not just 127.0.0.1)', () => {
  assert.equal(isPrivateAddress('127.0.0.1'), true);
  assert.equal(isPrivateAddress('127.5.5.5'), true);
});

test('isPrivateAddress matches localhost case-insensitively', () => {
  assert.equal(isPrivateAddress('localhost'), true);
  assert.equal(isPrivateAddress('LOCALHOST'), true);
});

test('isPrivateAddress matches IPv6 loopback, ULA, and link-local', () => {
  assert.equal(isPrivateAddress('::1'), true);
  assert.equal(isPrivateAddress('fc00::1'), true);
  assert.equal(isPrivateAddress('fd12:3456::1'), true);
  assert.equal(isPrivateAddress('fe80::1234'), true);
});

test('isPrivateAddress rejects public IPv6 and public domain names', () => {
  assert.equal(isPrivateAddress('2001:4860:4860::8888'), false);
  assert.equal(isPrivateAddress('example.com'), false);
});

test('needsTitleWarning is true for empty/whitespace title', () => {
  assert.equal(needsTitleWarning('', 'http://192.168.1.1/', '192.168.1.1'), true);
  assert.equal(needsTitleWarning('   ', 'http://192.168.1.1/', '192.168.1.1'), true);
});

test('needsTitleWarning is true when title equals the url or hostname (case/whitespace-insensitive)', () => {
  assert.equal(needsTitleWarning('http://192.168.1.1/', 'http://192.168.1.1/', '192.168.1.1'), true);
  assert.equal(needsTitleWarning('192.168.1.1', 'http://192.168.1.1/', '192.168.1.1'), true);
  assert.equal(needsTitleWarning(' 192.168.1.1 ', 'http://192.168.1.1/', '192.168.1.1'), true);
});

test('needsTitleWarning is false for a real identifying title', () => {
  assert.equal(needsTitleWarning('Netgear router — home', 'http://192.168.1.1/', '192.168.1.1'), false);
});
