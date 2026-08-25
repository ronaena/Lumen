import unzipper from 'unzipper';

/**
 * EpubArchive — the only place `unzipper` is imported. Everything downstream works
 * against this thin abstraction, so the zip-reading implementation can be swapped later
 * without touching EpubParser or the pipeline.
 */
export class EpubArchive {
  private constructor(private readonly entries: Map<string, Buffer>) {}

  static async fromBuffer(buffer: Buffer): Promise<EpubArchive> {
    let directory: unzipper.CentralDirectory;
    try {
      directory = await unzipper.Open.buffer(buffer);
    } catch (cause) {
      throw new Error('CORRUPT_ZIP', { cause });
    }

    const entries = new Map<string, Buffer>();
    for (const file of directory.files) {
      if (file.type !== 'File') continue;
      try {
        const content = await file.buffer();
        entries.set(file.path, content);
      } catch (cause) {
        throw new Error('CORRUPT_ZIP', { cause });
      }
    }
    return new EpubArchive(entries);
  }

  has(path: string): boolean {
    return this.entries.has(path);
  }

  read(path: string): Buffer | null {
    return this.entries.get(path) ?? null;
  }

  readText(path: string): string | null {
    const buffer = this.read(path);
    return buffer ? buffer.toString('utf8') : null;
  }

  listPaths(): string[] {
    return [...this.entries.keys()];
  }
}
