import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { normalizeWebmcpHostname, isWebmcpHostnameAllowed } = require('../../extension/webmcp-whitelist.js');

test('normalizeWebmcpHostname extracts the hostname from a bare hostname', () => {
  assert.equal(normalizeWebmcpHostname('ai-lab.oao.tw'), 'ai-lab.oao.tw');
});

test('normalizeWebmcpHostname extracts the hostname from a full URL', () => {
  assert.equal(normalizeWebmcpHostname('https://ai-lab.oao.tw/shelter-radar.html'), 'ai-lab.oao.tw');
});

test('normalizeWebmcpHostname strips a trailing slash on a bare hostname', () => {
  assert.equal(normalizeWebmcpHostname('ai-lab.oao.tw/'), 'ai-lab.oao.tw');
});

test('normalizeWebmcpHostname returns null for unparseable input', () => {
  assert.equal(normalizeWebmcpHostname(''), null);
  assert.equal(normalizeWebmcpHostname('   '), null);
});

test('normalizeWebmcpHostname handles a subdomain', () => {
  assert.equal(normalizeWebmcpHostname('sub.ai-lab.oao.tw'), 'sub.ai-lab.oao.tw');
});

test('isWebmcpHostnameAllowed accepts an exact match', () => {
  assert.equal(isWebmcpHostnameAllowed('ai-lab.oao.tw', ['ai-lab.oao.tw']), true);
});

test('isWebmcpHostnameAllowed accepts a subdomain of a whitelisted hostname', () => {
  assert.equal(isWebmcpHostnameAllowed('sub.ai-lab.oao.tw', ['ai-lab.oao.tw']), true);
});

test('isWebmcpHostnameAllowed rejects an unrelated hostname', () => {
  assert.equal(isWebmcpHostnameAllowed('evil.example.com', ['ai-lab.oao.tw']), false);
});

test('isWebmcpHostnameAllowed rejects a hostname that merely ends with the allowed string but is not a subdomain', () => {
  // "evilai-lab.oao.tw" ends with "ai-lab.oao.tw" as a raw string but is NOT
  // a subdomain of it (no dot boundary) -- must be rejected.
  assert.equal(isWebmcpHostnameAllowed('evilai-lab.oao.tw', ['ai-lab.oao.tw']), false);
});

test('isWebmcpHostnameAllowed rejects a null/empty hostname', () => {
  assert.equal(isWebmcpHostnameAllowed(null, ['ai-lab.oao.tw']), false);
  assert.equal(isWebmcpHostnameAllowed('', ['ai-lab.oao.tw']), false);
});
