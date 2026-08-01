import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeMessage, createDecoder, MAX_MESSAGE_BYTES } from '../src/native-messaging.js';

test('encodeMessage prefixes a 4-byte little-endian length before the JSON body', () => {
  const buf = encodeMessage({ hello: 'world' });
  const jsonBytes = Buffer.from(JSON.stringify({ hello: 'world' }), 'utf8');
  assert.equal(buf.readUInt32LE(0), jsonBytes.length);
  assert.deepEqual(buf.subarray(4), jsonBytes);
});

test('createDecoder reassembles a message split across multiple chunks', () => {
  const received = [];
  const decoder = createDecoder((msg) => received.push(msg));
  const full = encodeMessage({ a: 1, b: 'two' });
  decoder.push(full.subarray(0, 3));
  decoder.push(full.subarray(3, 7));
  decoder.push(full.subarray(7));
  assert.deepEqual(received, [{ a: 1, b: 'two' }]);
});

test('createDecoder handles two messages arriving back-to-back in one chunk', () => {
  const received = [];
  const decoder = createDecoder((msg) => received.push(msg));
  const combined = Buffer.concat([encodeMessage({ n: 1 }), encodeMessage({ n: 2 })]);
  decoder.push(combined);
  assert.deepEqual(received, [{ n: 1 }, { n: 2 }]);
});

test('encodeMessage throws when total frame (header + body) exceeds MAX_MESSAGE_BYTES', () => {
  // Helper to create a payload with a specific JSON-encoded byte length
  function makePayload(targetLen) {
    // Start with minimal payload and calculate padding needed
    const base = { p: '' };
    const baseLen = Buffer.byteLength(JSON.stringify(base), 'utf8');
    const paddingLen = targetLen - baseLen;
    return { p: 'x'.repeat(Math.max(0, paddingLen)) };
  }

  // Test 1: A payload encoding to MAX_MESSAGE_BYTES - 4 bytes should NOT throw
  // Total frame = 4-byte header + (MAX_MESSAGE_BYTES - 4) body = MAX_MESSAGE_BYTES (exactly at cap)
  const okPayload = makePayload(MAX_MESSAGE_BYTES - 4);
  const buf = encodeMessage(okPayload);
  assert.equal(buf.length, MAX_MESSAGE_BYTES);

  // Test 2: A payload encoding to MAX_MESSAGE_BYTES - 3 bytes should throw
  // Total frame = 4-byte header + (MAX_MESSAGE_BYTES - 3) body = MAX_MESSAGE_BYTES + 1 (exceeds cap)
  const tooLargePayload = makePayload(MAX_MESSAGE_BYTES - 3);
  assert.throws(() => encodeMessage(tooLargePayload), /exceeds MAX_MESSAGE_BYTES/);
});
