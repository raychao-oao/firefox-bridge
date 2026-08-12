import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { normalizeDialogHostname } = require('../../extension/dialog-whitelist.js');

test('normalizeDialogHostname extracts the hostname from a bare hostname', () => {
  assert.equal(normalizeDialogHostname('example.com'), 'example.com');
});

test('normalizeDialogHostname extracts the hostname from a full URL', () => {
  assert.equal(normalizeDialogHostname('https://example.com/some/path?q=1'), 'example.com');
});

test('normalizeDialogHostname strips a trailing slash on a bare hostname', () => {
  assert.equal(normalizeDialogHostname('example.com/'), 'example.com');
});

test('normalizeDialogHostname returns null for unparseable input', () => {
  assert.equal(normalizeDialogHostname(''), null);
  assert.equal(normalizeDialogHostname('   '), null);
});

test('normalizeDialogHostname handles a subdomain', () => {
  assert.equal(normalizeDialogHostname('sub.example.com'), 'sub.example.com');
});
