import { createDatabase, type Database } from '../../src/db/client.js';
import { sql } from 'drizzle-orm';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://lumen:lumen@localhost:5432/lumen_test';

let db: Database | null = null;

export function getTestDb(): Database {
  if (!db) {
    db = createDatabase(TEST_DATABASE_URL);
  }
  return db;
}

/** Truncates every table between tests so each test starts from a clean slate. */
export async function resetDatabase(): Promise<void> {
  const database = getTestDb();
  await database.execute(sql`
    TRUNCATE TABLE
      provider_usage,
      listening_progress,
      reading_progress,
      character_voice_assignments,
      characters,
      scenes,
      audio_segments,
      narration_attempts,
      text_segments,
      chapters,
      processing_job_steps,
      processing_jobs,
      voice_provider_mappings,
      voices,
      book_sources,
      books,
      users
    RESTART IDENTITY CASCADE
  `);
}

export async function createTestUser(db: Database, email: string) {
  const { users } = await import('../../src/db/schema/index.js');
  const [user] = await db.insert(users).values({ email }).returning();
  if (!user) throw new Error('Expected a user row after insert');
  return user;
}

/** Minimal fixture chain: user -> book -> chapter -> voice -> textSegment. */
export async function createTextSegmentFixture(db: Database, emailSuffix: string) {
  const { books, chapters, voices, textSegments } = await import('../../src/db/schema/index.js');
  const user = await createTestUser(db, `fixture-${emailSuffix}@example.com`);
  const [book] = await db
    .insert(books)
    .values({ userId: user.id, title: 'Fixture Book', language: 'en' })
    .returning();
  const [chapter] = await db
    .insert(chapters)
    .values({ bookId: book!.id, orderIndex: 0, sourceLocation: 'ch1' })
    .returning();
  const [voice] = await db
    .insert(voices)
    .values({ displayName: 'Narrator', role: 'narrator', language: 'en' })
    .returning();
  const [segment] = await db
    .insert(textSegments)
    .values({
      chapterId: chapter!.id,
      orderIndex: 0,
      sourceText: 'Once upon a time.',
      normalizedText: 'Once upon a time.',
      charCount: 18,
      sourceReference: 'p1',
      contentHash: 'hash-1',
      narratorVoiceId: voice!.id,
    })
    .returning();

  return { user: user!, book: book!, chapter: chapter!, voice: voice!, segment: segment! };
}
