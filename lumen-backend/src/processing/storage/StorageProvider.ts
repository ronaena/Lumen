/**
 * StorageProvider — the provider-neutral interface for large-binary storage (original
 * EPUBs, generated audio, covers). The database only ever stores the `storageRef` string
 * this interface returns — never bytes. No cloud-specific type (S3 client, GCS bucket,
 * etc.) may appear here or in any caller of this interface.
 *
 * LocalFilesystemStorageProvider (see LocalFilesystemStorageProvider.ts) is the only
 * implementation in this phase, and it is dev/test infrastructure only — not a
 * production cloud-storage decision. Swapping in a real object-storage implementation
 * later means writing one new class against this same interface; nothing that depends
 * on StorageProvider needs to change.
 */
export interface StorageProvider {
  /**
   * Writes bytes under a caller-supplied logical key (e.g. "books/{bookId}/source.epub")
   * and returns the storageRef to persist in the database. The ref format is an
   * implementation detail of the provider — callers must treat it as opaque.
   */
  write(key: string, data: Buffer): Promise<string>;

  read(storageRef: string): Promise<Buffer>;

  delete(storageRef: string): Promise<void>;

  exists(storageRef: string): Promise<boolean>;
}
