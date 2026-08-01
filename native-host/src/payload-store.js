import { writeFile, readFile, unlink, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export class PayloadStore {
  constructor(dir) {
    this.dir = dir;
    this.handles = new Map(); // handle -> absolute file path
  }

  async _ensureDir() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
  }

  async create(buffer) {
    await this._ensureDir();
    const handle = randomUUID();
    const filePath = path.join(this.dir, handle);
    await writeFile(filePath, buffer, { mode: 0o600 });
    this.handles.set(handle, filePath);
    return handle;
  }

  async read(handle) {
    const filePath = this.handles.get(handle);
    if (!filePath) {
      throw new Error(`unknown handle: ${handle}`);
    }
    const data = await readFile(filePath);
    this.handles.delete(handle);
    await unlink(filePath).catch(() => {}); // already-gone is fine
    return data;
  }

  async invalidateAll() {
    const paths = [...this.handles.values()];
    this.handles.clear();
    await Promise.all(paths.map((p) => unlink(p).catch(() => {})));
  }
}
