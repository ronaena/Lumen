import { mkdir, writeFile, readFile, unlink, access } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import type { StorageProvider } from './StorageProvider.js';

/**
 * LocalFilesystemStorageProvider — DEV/TEST INFRASTRUCTURE ONLY.
 *
 * Not the production cloud-storage decision — see StorageProvider.ts. Stores files under
 * a root directory, one file per logical key, and returns a `local://<key>` storageRef so
 * it's visually distinguishable from a future `s3://` or `gs://` ref during development.
 */
export class LocalFilesystemStorageProvider implements StorageProvider {
  constructor(private readonly rootDir: string) {}

  private resolvePath(key: string): string {
    // Defends against path traversal in a caller-supplied key — keys must resolve to a
    // path inside rootDir.
    const target = resolve(this.rootDir, key);
    const root = resolve(this.rootDir) + sep;
    if (!target.startsWith(root)) {
      throw new Error(`Storage key resolves outside the storage root: ${key}`);
    }
    return target;
  }

  private refFor(key: string): string {
    return `local://${normalize(key).split(sep).join('/')}`;
  }

  private keyFromRef(storageRef: string): string {
    if (!storageRef.startsWith('local://')) {
      throw new Error(`Not a local storage reference: ${storageRef}`);
    }
    return storageRef.slice('local://'.length);
  }

  async write(key: string, data: Buffer): Promise<string> {
    const path = this.resolvePath(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
    return this.refFor(key);
  }

  async read(storageRef: string): Promise<Buffer> {
    const key = this.keyFromRef(storageRef);
    const path = this.resolvePath(key);
    return readFile(path);
  }

  async delete(storageRef: string): Promise<void> {
    const key = this.keyFromRef(storageRef);
    const path = this.resolvePath(key);
    await unlink(path);
  }

  async exists(storageRef: string): Promise<boolean> {
    try {
      const key = this.keyFromRef(storageRef);
      const path = this.resolvePath(key);
      await access(path);
      return true;
    } catch {
      return false;
    }
  }
}
