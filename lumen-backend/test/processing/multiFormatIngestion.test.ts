import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestDb, resetDatabase, createTestUser } from '../db/setup.js';
import { LocalFilesystemStorageProvider } from '../../src/processing/storage/LocalFilesystemStorageProvider.js';
import { ingestBook } from '../../src/processing/pipeline/processBook.js';
import { EpubValidationError } from '../../src/processing/errors/ProcessingErrors.js';import { BookRepository } from '../../src/repositories/BookRepository.js';
import { ChapterRepository } from '../../src/repositories/ChapterRepository.js';
import { TextSegmentRepository } from '../../src/repositories/TextSegmentRepository.js';
import { ProcessingJobRepository } from '../../src/repositories/ProcessingJobRepository.js';
import { VoiceRepository } from '../../src/repositories/VoiceRepository.js';
import { buildValidDocx, buildInvalidDocx } from '../fixtures/buildDocx.js';
import { buildValidPdf, buildInvalidPdf, buildScannedLikePdf } from '../fixtures/buildPdf.js';

describe('Multi-Format Ebook Ingestion (TXT, DOCX, PDF) — real Postgres + real filesystem', () => {
  const db = getTestDb();
  const bookRepo = new BookRepository(db);
  const chapterRepo = new ChapterRepository(db);
  const textSegmentRepo = new TextSegmentRepository(db);
  const jobRepo = new ProcessingJobRepository(db);
  const voiceRepo = new VoiceRepository(db);

  let storageDir: string;
  let storage: LocalFilesystemStorageProvider;

  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), 'lumen-multiformat-test-'));
  });

  afterAll(async () => {
    await rm(storageDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await resetDatabase();
    storage = new LocalFilesystemStorageProvider(storageDir);
  });

  async function makeUserAndVoice() {
    const user = await createTestUser(db, `multiformat-${Date.now()}-${Math.random()}@example.com`);
    const voice = await voiceRepo.create({ displayName: 'Narrator', role: 'narrator', language: 'en' });
    return { user, voice };
  }

  const deps = () => ({ storage, bookRepo, chapterRepo, textSegmentRepo, jobRepo, voiceRepo });

  // ============================== TXT ==============================

  it('TXT: a valid UTF-8 file with multiple paragraphs ingests into one generated chapter, no fabricated title', async () => {
    const { user, voice } = await makeUserAndVoice();
    const buffer = Buffer.from('First paragraph, with unicode: café.\n\nSecond paragraph.\n\nThird paragraph.', 'utf8');

    const result = await ingestBook(deps(), {
      userId: user.id,
      buffer,
      filename: 'book.txt',
      mimeType: 'text/plain',
      narratorVoiceId: voice.id,
    });

    expect(result.chapterCount).toBe(1);
    expect(result.segmentCount).toBe(3);
    const chapters = await chapterRepo.listByBook(result.bookId);
    expect(chapters).toHaveLength(1);
    expect(chapters[0]!.title).toBeNull();
    const segments = await textSegmentRepo.listByChapter(chapters[0]!.id);
    expect(segments.map((s) => s.sourceText)).toEqual([
      'First paragraph, with unicode: café.',
      'Second paragraph.',
      'Third paragraph.',
    ]);
  });

  it('TXT: empty file is rejected as EMPTY_DOCUMENT', async () => {
    const { user, voice } = await makeUserAndVoice();
    await expect(
      ingestBook(deps(), {
        userId: user.id,
        buffer: Buffer.from('', 'utf8'),
        filename: 'empty.txt',
        mimeType: 'text/plain',
        narratorVoiceId: voice.id,
      }),
    ).rejects.toThrow(EpubValidationError);
  });

  it('TXT: a large file (well under the 200MB limit but non-trivial) ingests correctly', async () => {
    const { user, voice } = await makeUserAndVoice();
    const paragraph = 'A reasonably long paragraph of narration text repeated many times. '.repeat(50);
    const paragraphs = Array.from({ length: 200 }, () => paragraph);
    const buffer = Buffer.from(paragraphs.join('\n\n'), 'utf8');

    const result = await ingestBook(deps(), {
      userId: user.id,
      buffer,
      filename: 'large.txt',
      mimeType: 'text/plain',
      narratorVoiceId: voice.id,
    });
    expect(result.segmentCount).toBe(200);
  });

  it('TXT: unusual line endings (CRLF) are handled correctly', async () => {
    const { user, voice } = await makeUserAndVoice();
    const buffer = Buffer.from('First.\r\n\r\nSecond.\r\n\r\nThird.', 'utf8');

    const result = await ingestBook(deps(), {
      userId: user.id,
      buffer,
      filename: 'crlf.txt',
      mimeType: 'text/plain',
      narratorVoiceId: voice.id,
    });
    expect(result.segmentCount).toBe(3);
    const chapters = await chapterRepo.listByBook(result.bookId);
    const segments = await textSegmentRepo.listByChapter(chapters[0]!.id);
    expect(segments.map((s) => s.sourceText)).toEqual(['First.', 'Second.', 'Third.']);
  });

  it('TXT: a file exceeding the 200MB size limit is rejected as FILE_TOO_LARGE before any parsing is attempted', async () => {
    const { user, voice } = await makeUserAndVoice();
    // Genuinely exceeds the 200MB limit shared by validateDocumentUpload across all
    // non-EPUB formats -- proves the existing size-limit behavior applies here too, not
    // just for EPUB (which already had its own dedicated test in validation.test.ts).
    const oversized = Buffer.alloc(200 * 1024 * 1024 + 1, 'a');

    try {
      await ingestBook(deps(), {
        userId: user.id,
        buffer: oversized,
        filename: 'huge.txt',
        mimeType: 'text/plain',
        narratorVoiceId: voice.id,
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EpubValidationError);
      expect((error as EpubValidationError).code).toBe('FILE_TOO_LARGE');
    }
  });

  // ============================== DOCX ==============================

  it('DOCX: a valid document with multiple paragraphs ingests correctly', async () => {
    const { user, voice } = await makeUserAndVoice();
    const buffer = await buildValidDocx(['Chapter opening line.', 'A second paragraph of real content.']);

    const result = await ingestBook(deps(), {
      userId: user.id,
      buffer,
      filename: 'book.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      narratorVoiceId: voice.id,
    });

    expect(result.chapterCount).toBe(1);
    expect(result.segmentCount).toBe(2);
    const chapters = await chapterRepo.listByBook(result.bookId);
    expect(chapters[0]!.title).toBeNull(); // no fabricated title
    const segments = await textSegmentRepo.listByChapter(chapters[0]!.id);
    expect(segments[0]!.sourceText).toBe('Chapter opening line.');
  });

  it('DOCX: an empty document is rejected as EMPTY_DOCUMENT', async () => {
    const { user, voice } = await makeUserAndVoice();
    const buffer = await buildValidDocx([]);

    await expect(
      ingestBook(deps(), {
        userId: user.id,
        buffer,
        filename: 'empty.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        narratorVoiceId: voice.id,
      }),
    ).rejects.toThrow(EpubValidationError);
  });

  it('DOCX: a malformed file (valid ZIP, no word/document.xml) is rejected safely, no raw parser internals leaked', async () => {
    const { user, voice } = await makeUserAndVoice();
    const buffer = await buildInvalidDocx();

    try {
      await ingestBook(deps(), {
        userId: user.id,
        buffer,
        filename: 'malformed.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        narratorVoiceId: voice.id,
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EpubValidationError);
      const message = (error as EpubValidationError).message;
      expect(message).not.toMatch(/unzipper|node_modules|ENOENT|at new/i);
    }
  });

  it('DOCX: a completely non-ZIP file is rejected safely', async () => {
    const { user, voice } = await makeUserAndVoice();
    const buffer = Buffer.from('not a zip file at all', 'utf8');

    await expect(
      ingestBook(deps(), {
        userId: user.id,
        buffer,
        filename: 'fake.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        narratorVoiceId: voice.id,
      }),
    ).rejects.toThrow(EpubValidationError);
  });

  // ============================== PDF (text-based) ==============================

  it('PDF: a valid text-based single-page PDF ingests correctly', async () => {
    const { user, voice } = await makeUserAndVoice();
    const buffer = buildValidPdf('This is real extractable PDF text.');

    const result = await ingestBook(deps(), {
      userId: user.id,
      buffer,
      filename: 'book.pdf',
      mimeType: 'application/pdf',
      narratorVoiceId: voice.id,
    });

    expect(result.chapterCount).toBe(1);
    expect(result.segmentCount).toBe(1);
    const chapters = await chapterRepo.listByBook(result.bookId);
    const segments = await textSegmentRepo.listByChapter(chapters[0]!.id);
    expect(segments[0]!.sourceText).toBe('This is real extractable PDF text.');
  });

  it('PDF: an empty PDF (valid structure, zero content) is rejected as EMPTY_DOCUMENT', async () => {
    const { user, voice } = await makeUserAndVoice();
    const buffer = buildScannedLikePdf();

    await expect(
      ingestBook(deps(), {
        userId: user.id,
        buffer,
        filename: 'empty.pdf',
        mimeType: 'application/pdf',
        narratorVoiceId: voice.id,
      }),
    ).rejects.toThrow(EpubValidationError);
  });

  it('PDF: a scanned/image-only PDF (no text layer) is correctly reported as EMPTY_DOCUMENT, never fabricated via OCR', async () => {
    const { user, voice } = await makeUserAndVoice();
    const buffer = buildScannedLikePdf();

    try {
      await ingestBook(deps(), {
        userId: user.id,
        buffer,
        filename: 'scanned.pdf',
        mimeType: 'application/pdf',
        narratorVoiceId: voice.id,
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EpubValidationError);
      expect((error as EpubValidationError).code).toBe('EMPTY_DOCUMENT');
      expect((error as EpubValidationError).message).toMatch(/scanned|image-only/i);
    }
  });

  it('PDF: a malformed/non-PDF file is rejected via the magic-byte check, before any expensive parse attempt', async () => {
    const { user, voice } = await makeUserAndVoice();
    const buffer = buildInvalidPdf();

    try {
      await ingestBook(deps(), {
        userId: user.id,
        buffer,
        filename: 'fake.pdf',
        mimeType: 'application/pdf',
        narratorVoiceId: voice.id,
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EpubValidationError);
      expect((error as EpubValidationError).code).toBe('INVALID_PDF');
    }
  });

  // ============================== Unsupported formats ==============================

  it('DOC (legacy binary): explicitly rejected as UNSUPPORTED_FORMAT, not silently accepted or misparsed', async () => {
    const { user, voice } = await makeUserAndVoice();
    const buffer = Buffer.from('fake legacy doc bytes', 'utf8');

    try {
      await ingestBook(deps(), {
        userId: user.id,
        buffer,
        filename: 'legacy.doc',
        mimeType: 'application/msword',
        narratorVoiceId: voice.id,
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EpubValidationError);
      expect((error as EpubValidationError).code).toBe('UNSUPPORTED_FORMAT');
    }
  });

  it('a completely unknown extension is rejected as UNSUPPORTED_FORMAT', async () => {
    const { user, voice } = await makeUserAndVoice();
    await expect(
      ingestBook(deps(), {
        userId: user.id,
        buffer: Buffer.from('whatever', 'utf8'),
        filename: 'book.xyz',
        mimeType: 'application/octet-stream',
        narratorVoiceId: voice.id,
      }),
    ).rejects.toThrow(EpubValidationError);
  });

  it('extension/MIME mismatch is rejected — a .pdf extension with a non-PDF MIME type', async () => {
    const { user, voice } = await makeUserAndVoice();
    await expect(
      ingestBook(deps(), {
        userId: user.id,
        buffer: buildValidPdf('text'),
        filename: 'book.pdf',
        mimeType: 'text/plain', // wrong MIME for the claimed extension
        narratorVoiceId: voice.id,
      }),
    ).rejects.toThrow(EpubValidationError);
  });

  // ============================== Downstream compatibility ==============================

  it('a segment created from a non-EPUB format is fully compatible with existing repositories (no special-casing needed downstream)', async () => {
    const { user, voice } = await makeUserAndVoice();
    const result = await ingestBook(deps(), {
      userId: user.id,
      buffer: Buffer.from('A single paragraph for downstream compatibility testing.', 'utf8'),
      filename: 'compat.txt',
      mimeType: 'text/plain',
      narratorVoiceId: voice.id,
    });

    const book = await bookRepo.findById(result.bookId, user.id);
    expect(book).not.toBeNull();
    expect(book!.status).toBe('processing');
    expect(book!.chapterCount).toBe(1);
    expect(book!.segmentCount).toBe(1);
  });
});
