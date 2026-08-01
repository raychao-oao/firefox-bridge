// repo/native-host/test/policy-gate.test.js
//
// policy-gate.js ships under extension/, which has no package.json of its
// own and inherits CommonJS from the repo root's package.json (no "type":
// "module" there) — Firefox background-page scripts are also plain
// (non-ESM) scripts. So policy-gate.js is authored as CommonJS with a
// dual-mode export (see Step 3), and this test loads it via createRequire
// rather than a static `import`, since native-host's own package.json sets
// "type": "module" but that only governs files inside native-host/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PolicyGate } = require('../../extension/policy-gate.js');

test('isBlacklisted matches exact hostname', () => {
  const gate = new PolicyGate({ blacklist: ['bank.example.com'] });
  assert.equal(gate.isBlacklisted('https://bank.example.com/login'), true);
});

test('isBlacklisted matches subdomains of a blacklisted hostname', () => {
  const gate = new PolicyGate({ blacklist: ['bank.example.com'] });
  assert.equal(gate.isBlacklisted('https://secure.bank.example.com/login'), true);
});

test('isBlacklisted does not match unrelated hostnames', () => {
  const gate = new PolicyGate({ blacklist: ['bank.example.com'] });
  assert.equal(gate.isBlacklisted('https://example.com/'), false);
  assert.equal(gate.isBlacklisted('https://notbank.example.com/'), false);
});

test('checkUrl allows non-blacklisted URLs with no grants needed', () => {
  const gate = new PolicyGate({ blacklist: ['bank.example.com'] });
  const ctx = { onceGrants: new Set(), sessionGrants: new Map(), sessionId: 's1' };
  assert.equal(gate.checkUrl('https://example.com/', ctx), 'allow');
});

test('checkUrl requires confirmation for a blacklisted URL with no prior grant', () => {
  const gate = new PolicyGate({ blacklist: ['bank.example.com'] });
  const ctx = { onceGrants: new Set(), sessionGrants: new Map(), sessionId: 's1' };
  assert.equal(gate.checkUrl('https://bank.example.com/', ctx), 'needs_confirmation');
});

test('checkUrl allows once a "once" grant exists for that exact URL', () => {
  const gate = new PolicyGate({ blacklist: ['bank.example.com'] });
  const ctx = { onceGrants: new Set(['https://bank.example.com/']), sessionGrants: new Map(), sessionId: 's1' };
  assert.equal(gate.checkUrl('https://bank.example.com/', ctx), 'allow');
});

test('checkUrl allows when a session grant exists for that hostname and session', () => {
  const gate = new PolicyGate({ blacklist: ['bank.example.com'] });
  const sessionGrants = new Map([['s1', new Set(['bank.example.com'])]]);
  const ctx = { onceGrants: new Set(), sessionGrants, sessionId: 's1' };
  assert.equal(gate.checkUrl('https://bank.example.com/', ctx), 'allow');
});

test('checkUrl still needs confirmation for a different session without its own grant', () => {
  const gate = new PolicyGate({ blacklist: ['bank.example.com'] });
  const sessionGrants = new Map([['s1', new Set(['bank.example.com'])]]);
  const ctx = { onceGrants: new Set(), sessionGrants, sessionId: 's2' };
  assert.equal(gate.checkUrl('https://bank.example.com/', ctx), 'needs_confirmation');
});
