import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildWebmcpHookSource } = require('../../extension/webmcp-hook.js');

test('buildWebmcpHookSource produces syntactically valid JavaScript', () => {
  const source = buildWebmcpHookSource();
  // Constructing (not calling) a Function from this source throws
  // SyntaxError on malformed JS without needing window/postMessage/
  // document, none of which exist in this Node test process.
  assert.doesNotThrow(() => new Function(source));
});

test('buildWebmcpHookSource defines document.modelContext.registerTool', () => {
  const source = buildWebmcpHookSource();
  assert.match(source, /document\.modelContext\s*=/);
  assert.match(source, /registerTool\s*:/);
});

test('buildWebmcpHookSource uses the firefox-bridge-webmcp message namespace', () => {
  const source = buildWebmcpHookSource();
  assert.match(source, /firefox-bridge-webmcp/);
  assert.match(source, /tool\.register/);
  assert.match(source, /tool\.call/);
  assert.match(source, /tool\.result/);
  assert.match(source, /tool\.error/);
});

test('buildWebmcpHookSource is idempotent-guarded against double injection', () => {
  const source = buildWebmcpHookSource();
  assert.match(source, /__firefoxBridgeWebmcpHookInstalled__/);
});
