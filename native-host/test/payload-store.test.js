import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PayloadStore } from '../src/payload-store.js';

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'fb-payload-test-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('create returns an opaque handle, not a filesystem path', async () => {
  await withTempDir(async (dir) => {
    const store = new PayloadStore(dir);
    const handle = await store.create(Buffer.from('hello'));
    assert.equal(typeof handle, 'string');
    assert.equal(handle.includes('/'), false);
    assert.equal(handle.includes(dir), false);
  });
});

test('read returns the original bytes and deletes the file (single-read)', async () => {
  await withTempDir(async (dir) => {
    const store = new PayloadStore(dir);
    const handle = await store.create(Buffer.from('payload-bytes'));
    const first = await store.read(handle);
    assert.equal(first.toString('utf8'), 'payload-bytes');

    await assert.rejects(() => store.read(handle), /unknown handle/);

    const remaining = await readdir(dir);
    assert.deepEqual(remaining, []);
  });
});

test('read on an unknown handle rejects', async () => {
  await withTempDir(async (dir) => {
    const store = new PayloadStore(dir);
    await assert.rejects(() => store.read('does-not-exist'), /unknown handle/);
  });
});

test('invalidateAll deletes all outstanding files and clears handles', async () => {
  await withTempDir(async (dir) => {
    const store = new PayloadStore(dir);
    const h1 = await store.create(Buffer.from('a'));
    const h2 = await store.create(Buffer.from('b'));
    await store.invalidateAll();
    await assert.rejects(() => store.read(h1), /unknown handle/);
    await assert.rejects(() => store.read(h2), /unknown handle/);
    assert.deepEqual(await readdir(dir), []);
  });
});
