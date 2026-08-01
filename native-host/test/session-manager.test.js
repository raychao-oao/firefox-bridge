import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '../src/session-manager.js';

test('createSession returns unique ids', () => {
  const sm = new SessionManager();
  const a = sm.createSession();
  const b = sm.createSession();
  assert.notEqual(a, b);
});

test('acquireLease succeeds for an unclaimed tab and records ownership', () => {
  const sm = new SessionManager();
  const s = sm.createSession();
  const result = sm.acquireLease(s, 42);
  assert.deepEqual(result, { ok: true });
  assert.equal(sm.isLeaseOwner(s, 42), true);
  assert.equal(sm.leaseOwner(42), s);
});

test('acquireLease conflicts when another session already owns the tab', () => {
  const sm = new SessionManager();
  const s1 = sm.createSession();
  const s2 = sm.createSession();
  sm.acquireLease(s1, 42);
  const result = sm.acquireLease(s2, 42);
  assert.deepEqual(result, { ok: false, error: 'conflict' });
});

test('acquireLease is idempotent for the same session re-acquiring its own tab', () => {
  const sm = new SessionManager();
  const s = sm.createSession();
  sm.acquireLease(s, 42);
  const result = sm.acquireLease(s, 42);
  assert.deepEqual(result, { ok: true });
});

test('acquireLease rejects an unknown session', () => {
  const sm = new SessionManager();
  const result = sm.acquireLease('nonexistent', 42);
  assert.deepEqual(result, { ok: false, error: 'unknown_session' });
});

test('releaseLease frees the tab for other sessions', () => {
  const sm = new SessionManager();
  const s1 = sm.createSession();
  const s2 = sm.createSession();
  sm.acquireLease(s1, 42);
  sm.releaseLease(s1, 42);
  assert.deepEqual(sm.acquireLease(s2, 42), { ok: true });
});

test('destroySession releases all leases owned by that session', () => {
  const sm = new SessionManager();
  const s1 = sm.createSession();
  const s2 = sm.createSession();
  sm.acquireLease(s1, 1);
  sm.acquireLease(s1, 2);
  sm.destroySession(s1);
  assert.equal(sm.leaseOwner(1), null);
  assert.deepEqual(sm.acquireLease(s2, 1), { ok: true });
});

test('invalidateLeasesForTab clears ownership regardless of which session held it', () => {
  const sm = new SessionManager();
  const s1 = sm.createSession();
  sm.acquireLease(s1, 42);
  sm.invalidateLeasesForTab(42);
  assert.equal(sm.leaseOwner(42), null);
  assert.equal(sm.isLeaseOwner(s1, 42), false);
});
