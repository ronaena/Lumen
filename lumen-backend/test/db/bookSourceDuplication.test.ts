import { describe, it, expect, beforeEach } from 'vitest';
import { getTestDb, resetDatabase, createTestUser } from './setup.js';
import { BookRepository } from '../../src/repositories/BookRepository.js';

describe('BookSource duplicate protection (DB-1)', () => {
  const db = getTestDb();
  const bookRepo = new BookRepository(db);

  beforeEach(async () => {
    await resetDatabase();
  });

  it('rejects the same user uploading the same checksum twice', async () => {
    const user = await createTestUser(db, 'reader1@example.com');
    const bookA = await bookRepo.create({ userId: user.id, title: 'Book A', language: 'en' });
    const bookB = await bookRepo.create({ userId: user.id, title: 'Book B (dup attempt)', language: 'en' });

    await bookRepo.createSource({
      bookId: bookA.id,
      userId: user.id,
      originalFileStorageRef: 's3://bucket/a.epub',
      originalFilename: 'a.epub',
      fileSizeBytes: 1000,
      checksum: 'same-checksum-abc',
      mimeType: 'application/epub+zip',
    });

    await expect(
      bookRepo.createSource({
        bookId: bookB.id,
        userId: user.id,
        originalFileStorageRef: 's3://bucket/b.epub',
        originalFilename: 'b.epub',
        fileSizeBytes: 1000,
        checksum: 'same-checksum-abc',
        mimeType: 'application/epub+zip',
      }),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('allows two different users to upload the same checksum', async () => {
    const userA = await createTestUser(db, 'usera@example.com');
    const userB = await createTestUser(db, 'userb@example.com');
    const bookA = await bookRepo.create({ userId: userA.id, title: 'Book A', language: 'en' });
    const bookB = await bookRepo.create({ userId: userB.id, title: 'Book B', language: 'en' });

    await bookRepo.createSource({
      bookId: bookA.id,
      userId: userA.id,
      originalFileStorageRef: 's3://bucket/a.epub',
      originalFilename: 'a.epub',
      fileSizeBytes: 1000,
      checksum: 'shared-checksum-xyz',
      mimeType: 'application/epub+zip',
    });

    const sourceB = await bookRepo.createSource({
      bookId: bookB.id,
      userId: userB.id,
      originalFileStorageRef: 's3://bucket/b.epub',
      originalFilename: 'b.epub',
      fileSizeBytes: 1000,
      checksum: 'shared-checksum-xyz',
      mimeType: 'application/epub+zip',
    });

    expect(sourceB.checksum).toBe('shared-checksum-xyz');
  });
});
