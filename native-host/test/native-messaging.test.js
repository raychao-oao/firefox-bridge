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

test('encodeMessage throws when the encoded body exceeds MAX_MESSAGE_BYTES', () => {
  const huge = { data: 'x'.repeat(MAX_MESSAGE_BYTES) };
  assert.throws(() => encodeMessage(huge), /exceeds MAX_MESSAGE_BYTES/);
});
