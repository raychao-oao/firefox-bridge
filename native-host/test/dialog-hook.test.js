import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildDialogHookSource } = require('../../extension/dialog-hook.js');

test('buildDialogHookSource embeds the given port and token', () => {
  const source = buildDialogHookSource({ port: 54321, token: 'abc123' });
  assert.match(source, /54321/);
  assert.match(source, /"abc123"/);
});

test('buildDialogHookSource produces syntactically valid JavaScript', () => {
  const source = buildDialogHookSource({ port: 1234, token: 'tok' });
  // Constructing (not calling) a Function from this source throws
  // SyntaxError on malformed JS without needing window/XMLHttpRequest/
  // crypto/location, none of which exist in this Node test process.
  assert.doesNotThrow(() => new Function(source));
});

test('buildDialogHookSource JSON-escapes a token that would otherwise break out of the string literal', () => {
  const source = buildDialogHookSource({ port: 1, token: 'evil"; alert(1); //' });
  assert.doesNotThrow(() => new Function(source));
  assert.match(source, /evil\\"/);
});
