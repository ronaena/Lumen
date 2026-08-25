import type { StorageProvider } from '../storage/StorageProvider.js';
import { validateEpubUpload } from '../validation/validateEpubUpload.js';
import { EpubArchive } from '../epub/EpubArchive.js';
import { parseEpub } from '../epub/EpubParser.js';
import { segmentChapterText } from '../segmentation/paragraphSegmentation.js';
import { computeFileChecksum } from '../checksum.js';
import { EpubValidationError, ProcessingError, DuplicateBookError } from '../errors/ProcessingErrors.js';
import { BookRepository } from '../../repositories/BookRepository.js';
import { ChapterRepository } from '../../repositories/ChapterRepository.js';
import { TextSegmentRepository } from '../../repositories/TextSegmentRepository.js';
import { ProcessingJobRepository } from '../../repositories/ProcessingJobRepository.js';
import { VoiceRepository } from '../../repositories/VoiceRepository.js';
import { detectFormat, type SupportedFormat } from '../documentFormats/detectFormat.js';
import { validateDocumentUpload } from '../documentFormats/validateDocumentUpload.js';
import { buildParagraphSegments } from '../documentFormats/buildParagraphSegments.js';
import { parseTxtDocument } from '../documentFormats/parseTxtDocument.js';
import { parseDocxDocument } from '../documentFormats/parseDocxDocument.js';
import { parsePdfDocument } from '../documentFormats/parsePdfDocument.js';
import type { ParsedDocument } from '../documentFormats/ParsedDocument.js';

export interface PipelineDeps {
  storage: StorageProvider;
  bookRepo: BookRepository;
  chapterRepo: ChapterRepository;
  textSegmentRepo: TextSegmentRepository;
  jobRepo: ProcessingJobRepository;
  voiceRepo: VoiceRepository;
}

export interface IngestBookInput {
  userId: string;
  buffer: Buffer;
  filename: string;
  mimeType: string;
  narratorVoiceId: string;
}

export interface PipelineResult {
  bookId: string;
  processingJobId: string;
  chapterCount: number;
  segmentCount: number;
}

/** Runs one ProcessingJobStep around fn(), recording safe-message failure without throwing raw errors into the DB. */
async function runStep<T>(
  jobRepo: ProcessingJobRepository,
  processingJobId: string,
  stepType: 'upload' | 'validation' | 'extraction' | 'chapter_detection' | 'segmentation',
  scopeType: 'book' | 'chapter',
  scopeId: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  const step = await jobRepo.createStep({
    processingJobId,
    stepType,
    scopeType,
    scopeId: scopeId ?? undefined,
    status: 'processing',
    startedAt: new Date(),
  });

  try {
    const result = await fn();
    await jobRepo.updateStepStatus(step.id, { status: 'completed', completedAt: new Date() });
    return result;
  } catch (error) {
    const safeMessage =
      error instanceof EpubValidationError || error instanceof ProcessingError
        ? error.message
        : 'This step could not be completed.';
    await jobRepo.updateStepStatus(step.id, {
      status: 'failed',
      lastError: safeMessage,
      completedAt: new Date(),
    });
    throw error;
  }
}

async function parseNonEpubDocument(format: Exclude<SupportedFormat, 'epub'>, buffer: Buffer): Promise<ParsedDocument> {
  if (format === 'txt') return parseTxtDocument(buffer);
  if (format === 'docx') return parseDocxDocument(buffer);
  return parsePdfDocument(buffer);
}

/**
 * Ingests a brand-new book upload through the full pipeline:
 * upload → validation → storage → extraction → chapter_detection → segmentation.
 *
 * Supports EPUB, TXT, DOCX, and text-based PDF (Multi-Format Ingestion workstream).
 * The EPUB branch below is byte-identical in logic to the original Phase 2
 * implementation -- moved inside an `if (format === 'epub')` block, nothing else
 * changed, per the approved "preserve EPUB exactly" requirement. TXT/DOCX/PDF share a
 * separate branch built on the new ParsedDocument normalization boundary.
 *
 * Per approved decision §8: voice resolution here is deliberately minimal — it validates
 * that `narratorVoiceId` refers to a real Voice and assigns it to every TextSegment. The
 * POLICY of which voice is "the default" is not decided by this function; the caller
 * supplies narratorVoiceId explicitly. No default-narrator-selection policy is invented.
 */
export async function ingestBook(deps: PipelineDeps, input: IngestBookInput): Promise<PipelineResult> {
  const { storage, bookRepo, chapterRepo, textSegmentRepo, jobRepo, voiceRepo } = deps;

  const voice = await voiceRepo.findById(input.narratorVoiceId);
  if (!voice) {
    throw new ProcessingError('VOICE_NOT_FOUND');
  }

  // Book row is created before validation so every stage — including a validation
  // failure — has a Book/ProcessingJob to attach its status/history to, per the
  // resumability and auditability requirements (spec §22/23, corrections §6).
  const placeholderTitle = input.filename.replace(/\.(epub|txt|docx|pdf)$/i, '');
  const book = await bookRepo.create({
    userId: input.userId,
    title: placeholderTitle,
    language: 'en', // placeholder — overwritten from source metadata during extraction, if present
  });

  const job = await jobRepo.create({ bookId: book.id, userId: input.userId, jobType: 'full_processing' });
  await jobRepo.updateJobStatus(job.id, { status: 'processing', startedAt: new Date() });

  try {
    await runStep(jobRepo, job.id, 'upload', 'book', null, async () => {
      // Bytes are already in memory at this stage; this step exists to represent
      // "the upload was received" in the audit trail.
      return true;
    });

    // Format detection is a cheap, synchronous, in-memory check -- deliberately NOT
    // wrapped in its own runStep, so the EPUB branch's step sequence/count remains
    // byte-identical to before this workstream. An UNSUPPORTED_FORMAT throw here
    // propagates to the outer catch block exactly like any other pre-existing error.
    const format = detectFormat(input.filename, input.mimeType);

    if (format === 'epub') {
      // ==================== EPUB branch — unchanged from the original implementation ====================
      const archive = await runStep(jobRepo, job.id, 'validation', 'book', null, () =>
        validateEpubUpload({ buffer: input.buffer, filename: input.filename, mimeType: input.mimeType }),
      );

      const checksum = computeFileChecksum(input.buffer);
      try {
        const storageRef = await storage.write(`books/${book.id}/source.epub`, input.buffer);
        await bookRepo.createSource({
          bookId: book.id,
          userId: input.userId,
          originalFileStorageRef: storageRef,
          originalFilename: input.filename,
          fileSizeBytes: input.buffer.byteLength,
          checksum,
          mimeType: input.mimeType,
        });
      } catch (error) {
        if (isUniqueViolation(error, 'book_sources_user_checksum_unique')) {
          await jobRepo.updateJobStatus(job.id, { status: 'failed', completedAt: new Date() });
          await bookRepo.update(book.id, { status: 'failed' });
          throw new DuplicateBookError();
        }
        throw error;
      }

      const parsed = await runStep(jobRepo, job.id, 'extraction', 'book', null, async () => parseEpub(archive));

      if (parsed.metadata.title || parsed.metadata.author || parsed.metadata.language) {
        await bookRepo.update(book.id, {
          title: parsed.metadata.title ?? placeholderTitle,
          author: parsed.metadata.author ?? null,
          language: parsed.metadata.language ?? 'en',
        });
      }

      const createdChapters = await runStep(jobRepo, job.id, 'chapter_detection', 'book', null, async () => {
        const results = [];
        for (const spineDoc of parsed.spineDocuments) {
          const chapter = await chapterRepo.create({
            bookId: book.id,
            orderIndex: spineDoc.orderIndex,
            title: spineDoc.title ?? undefined,
            sourceLocation: spineDoc.path,
          });
          results.push({ chapter, sourceDocPath: spineDoc.path });
        }
        return results;
      });

      let totalSegments = 0;
      for (const { chapter, sourceDocPath } of createdChapters) {
        const segmentCount = await runStep(
          jobRepo,
          job.id,
          'segmentation',
          'chapter',
          chapter.id,
          async () => {
            const xhtml = archive.readText(sourceDocPath);
            if (xhtml === null) {
              throw new ProcessingError('SEGMENTATION_FAILED');
            }
            const paragraphs = segmentChapterText(xhtml);
            let charTotal = 0;
            for (const paragraph of paragraphs) {
              await textSegmentRepo.create({
                chapterId: chapter.id,
                orderIndex: paragraph.orderIndex,
                sourceText: paragraph.sourceText,
                normalizedText: paragraph.normalizedText,
                charCount: paragraph.charCount,
                sourceReference: paragraph.sourceReference,
                contentHash: paragraph.contentHash,
                narratorVoiceId: input.narratorVoiceId,
              });
              charTotal += paragraph.charCount;
            }
            await chapterRepo.update(chapter.id, {
              status: 'segmented',
              segmentCount: paragraphs.length,
              textCharCount: charTotal,
            });
            return paragraphs.length;
          },
        );
        totalSegments += segmentCount;
      }

      await bookRepo.update(book.id, {
        chapterCount: createdChapters.length,
        segmentCount: totalSegments,
        status: 'processing', // structural processing complete; narration not yet run
      });
      await jobRepo.updateJobStatus(job.id, { status: 'completed', completedAt: new Date() });

      return {
        bookId: book.id,
        processingJobId: job.id,
        chapterCount: createdChapters.length,
        segmentCount: totalSegments,
      };
    }

    // ==================== TXT / DOCX / PDF branch — Multi-Format Ingestion workstream ====================
    await runStep(jobRepo, job.id, 'validation', 'book', null, () => validateDocumentUpload(input.buffer, format));

    const checksum = computeFileChecksum(input.buffer);
    try {
      const storageRef = await storage.write(`books/${book.id}/source.${format}`, input.buffer);
      await bookRepo.createSource({
        bookId: book.id,
        userId: input.userId,
        originalFileStorageRef: storageRef,
        originalFilename: input.filename,
        fileSizeBytes: input.buffer.byteLength,
        checksum,
        mimeType: input.mimeType,
      });
    } catch (error) {
      if (isUniqueViolation(error, 'book_sources_user_checksum_unique')) {
        await jobRepo.updateJobStatus(job.id, { status: 'failed', completedAt: new Date() });
        await bookRepo.update(book.id, { status: 'failed' });
        throw new DuplicateBookError();
      }
      throw error;
    }

    const parsedDocument = await runStep(jobRepo, job.id, 'extraction', 'book', null, () =>
      parseNonEpubDocument(format, input.buffer),
    );

    if (parsedDocument.metadata.title || parsedDocument.metadata.author || parsedDocument.metadata.language) {
      await bookRepo.update(book.id, {
        title: parsedDocument.metadata.title ?? placeholderTitle,
        author: parsedDocument.metadata.author ?? null,
        language: parsedDocument.metadata.language ?? 'en',
      });
    }

    const createdChapters = await runStep(jobRepo, job.id, 'chapter_detection', 'book', null, async () => {
      const results = [];
      for (const parsedChapter of parsedDocument.chapters) {
        const chapter = await chapterRepo.create({
          bookId: book.id,
          orderIndex: parsedChapter.orderIndex,
          title: parsedChapter.title ?? undefined,
          sourceLocation: parsedChapter.sourceLocation,
        });
        results.push({ chapter, rawParagraphs: parsedChapter.paragraphs });
      }
      return results;
    });

    let totalSegments = 0;
    for (const { chapter, rawParagraphs } of createdChapters) {
      const segmentCount = await runStep(jobRepo, job.id, 'segmentation', 'chapter', chapter.id, async () => {
        const paragraphs = buildParagraphSegments(rawParagraphs);
        if (paragraphs.length === 0) {
          // Covers both a genuinely empty source document and a scanned/image-only PDF
          // with no extractable text layer -- neither is fabricated, both are reported
          // honestly as this same safe error.
          throw new EpubValidationError('EMPTY_DOCUMENT');
        }
        let charTotal = 0;
        for (const paragraph of paragraphs) {
          await textSegmentRepo.create({
            chapterId: chapter.id,
            orderIndex: paragraph.orderIndex,
            sourceText: paragraph.sourceText,
            normalizedText: paragraph.normalizedText,
            charCount: paragraph.charCount,
            sourceReference: paragraph.sourceReference,
            contentHash: paragraph.contentHash,
            narratorVoiceId: input.narratorVoiceId,
          });
          charTotal += paragraph.charCount;
        }
        await chapterRepo.update(chapter.id, {
          status: 'segmented',
          segmentCount: paragraphs.length,
          textCharCount: charTotal,
        });
        return paragraphs.length;
      });
      totalSegments += segmentCount;
    }

    await bookRepo.update(book.id, {
      chapterCount: createdChapters.length,
      segmentCount: totalSegments,
      status: 'processing',
    });
    await jobRepo.updateJobStatus(job.id, { status: 'completed', completedAt: new Date() });

    return {
      bookId: book.id,
      processingJobId: job.id,
      chapterCount: createdChapters.length,
      segmentCount: totalSegments,
    };
  } catch (error) {
    if (!(error instanceof DuplicateBookError)) {
      await jobRepo.updateJobStatus(job.id, { status: 'failed', completedAt: new Date() });
      await bookRepo.update(book.id, { status: 'failed' });
    }
    throw error;
  }
}

/**
 * Resumes processing for a book whose prior attempt was interrupted or partially failed.
 * Re-reads the stored source file via StorageProvider (no re-upload needed) and re-runs
 * only the stages that have not yet completed. Format-aware in the same way as
 * ingestBook -- the EPUB branch is unchanged from the original implementation.
 */
export async function resumeBookProcessing(
  deps: PipelineDeps,
  input: { bookId: string; userId: string; narratorVoiceId: string },
): Promise<PipelineResult> {
  const { storage, bookRepo, chapterRepo, textSegmentRepo, jobRepo, voiceRepo } = deps;

  const book = await bookRepo.findById(input.bookId, input.userId);
  if (!book) {
    throw new ProcessingError('EXTRACTION_FAILED');
  }

  const source = await bookRepo.findSourceByBookId(book.id);
  if (!source) {
    throw new ProcessingError('EXTRACTION_FAILED');
  }

  const voice = await voiceRepo.findById(input.narratorVoiceId);
  if (!voice) {
    throw new ProcessingError('VOICE_NOT_FOUND');
  }

  const format = detectFormat(source.originalFilename, source.mimeType);

  const job = await jobRepo.create({ bookId: book.id, userId: input.userId, jobType: 'reprocessing' });
  await jobRepo.updateJobStatus(job.id, { status: 'processing', startedAt: new Date() });

  try {
    const fileBuffer = await storage.read(source.originalFileStorageRef);

    if (format === 'epub') {
      // ==================== EPUB branch — unchanged from the original implementation ====================
      const archive = await EpubArchive.fromBuffer(fileBuffer);
      const parsed = parseEpub(archive);

      const existingChapters = await chapterRepo.listByBook(book.id);
      const chaptersToProcess =
        existingChapters.length > 0
          ? existingChapters.map((chapter) => ({
              chapter,
              sourceDocPath: chapter.sourceLocation,
            }))
          : await runStep(jobRepo, job.id, 'chapter_detection', 'book', null, async () => {
              const results = [];
              for (const spineDoc of parsed.spineDocuments) {
                const chapter = await chapterRepo.create({
                  bookId: book.id,
                  orderIndex: spineDoc.orderIndex,
                  title: spineDoc.title ?? undefined,
                  sourceLocation: spineDoc.path,
                });
                results.push({ chapter, sourceDocPath: spineDoc.path });
              }
              return results;
            });

      let totalSegments = 0;
      for (const { chapter, sourceDocPath } of chaptersToProcess) {
        if (chapter.status === 'segmented' || chapter.status === 'narrating' || chapter.status === 'ready') {
          const existingSegments = await textSegmentRepo.listByChapter(chapter.id);
          totalSegments += existingSegments.length;
          continue;
        }

        const segmentCount = await runStep(jobRepo, job.id, 'segmentation', 'chapter', chapter.id, async () => {
          const xhtml = archive.readText(sourceDocPath);
          if (xhtml === null) throw new ProcessingError('SEGMENTATION_FAILED');
          const paragraphs = segmentChapterText(xhtml);
          let charTotal = 0;
          for (const paragraph of paragraphs) {
            await textSegmentRepo.create({
              chapterId: chapter.id,
              orderIndex: paragraph.orderIndex,
              sourceText: paragraph.sourceText,
              normalizedText: paragraph.normalizedText,
              charCount: paragraph.charCount,
              sourceReference: paragraph.sourceReference,
              contentHash: paragraph.contentHash,
              narratorVoiceId: input.narratorVoiceId,
            });
            charTotal += paragraph.charCount;
          }
          await chapterRepo.update(chapter.id, {
            status: 'segmented',
            segmentCount: paragraphs.length,
            textCharCount: charTotal,
          });
          return paragraphs.length;
        });
        totalSegments += segmentCount;
      }

      await bookRepo.update(book.id, {
        chapterCount: chaptersToProcess.length,
        segmentCount: totalSegments,
        status: 'processing',
      });
      await jobRepo.updateJobStatus(job.id, { status: 'completed', completedAt: new Date() });

      return {
        bookId: book.id,
        processingJobId: job.id,
        chapterCount: chaptersToProcess.length,
        segmentCount: totalSegments,
      };
    }

    // ==================== TXT / DOCX / PDF branch ====================
    const parsedDocument = await parseNonEpubDocument(format, fileBuffer);

    const existingChapters = await chapterRepo.listByBook(book.id);
    const chaptersToProcess =
      existingChapters.length > 0
        ? existingChapters.map((chapter, i) => ({
            chapter,
            rawParagraphs: parsedDocument.chapters[i]?.paragraphs ?? [],
          }))
        : await runStep(jobRepo, job.id, 'chapter_detection', 'book', null, async () => {
            const results = [];
            for (const parsedChapter of parsedDocument.chapters) {
              const chapter = await chapterRepo.create({
                bookId: book.id,
                orderIndex: parsedChapter.orderIndex,
                title: parsedChapter.title ?? undefined,
                sourceLocation: parsedChapter.sourceLocation,
              });
              results.push({ chapter, rawParagraphs: parsedChapter.paragraphs });
            }
            return results;
          });

    let totalSegments = 0;
    for (const { chapter, rawParagraphs } of chaptersToProcess) {
      if (chapter.status === 'segmented' || chapter.status === 'narrating' || chapter.status === 'ready') {
        const existingSegments = await textSegmentRepo.listByChapter(chapter.id);
        totalSegments += existingSegments.length;
        continue;
      }

      const segmentCount = await runStep(jobRepo, job.id, 'segmentation', 'chapter', chapter.id, async () => {
        const paragraphs = buildParagraphSegments(rawParagraphs);
        if (paragraphs.length === 0) {
          throw new EpubValidationError('EMPTY_DOCUMENT');
        }
        let charTotal = 0;
        for (const paragraph of paragraphs) {
          await textSegmentRepo.create({
            chapterId: chapter.id,
            orderIndex: paragraph.orderIndex,
            sourceText: paragraph.sourceText,
            normalizedText: paragraph.normalizedText,
            charCount: paragraph.charCount,
            sourceReference: paragraph.sourceReference,
            contentHash: paragraph.contentHash,
            narratorVoiceId: input.narratorVoiceId,
          });
          charTotal += paragraph.charCount;
        }
        await chapterRepo.update(chapter.id, {
          status: 'segmented',
          segmentCount: paragraphs.length,
          textCharCount: charTotal,
        });
        return paragraphs.length;
      });
      totalSegments += segmentCount;
    }

    await bookRepo.update(book.id, {
      chapterCount: chaptersToProcess.length,
      segmentCount: totalSegments,
      status: 'processing',
    });
    await jobRepo.updateJobStatus(job.id, { status: 'completed', completedAt: new Date() });

    return {
      bookId: book.id,
      processingJobId: job.id,
      chapterCount: chaptersToProcess.length,
      segmentCount: totalSegments,
    };
  } catch (error) {
    await jobRepo.updateJobStatus(job.id, { status: 'failed', completedAt: new Date() });
    throw error;
  }
}

/**
 * Postgres unique-violation detection, robust to how the driver/ORM wraps the error.
 *
 * drizzle-orm >=0.45 wraps the raw pg error inside a DrizzleQueryError, with the
 * original error (which carries .code/.constraint) at `.cause` rather than at the top
 * level — a real behavior change discovered during the drizzle-orm 0.36.4 -> 0.45.2
 * security-advisory remediation (Phase 9 finding H-1). Checking both the top level and
 * `.cause` keeps this helper correct regardless of which shape a given driver/ORM
 * version produces, rather than being silently coupled to one specific version's
 * internal wrapping behavior.
 */
function isUniqueViolation(error: unknown, constraintName: string): boolean {
  const candidates = [error, (error as { cause?: unknown } | null)?.cause];
  return candidates.some(
    (candidate) =>
      typeof candidate === 'object' &&
      candidate !== null &&
      'code' in candidate &&
      (candidate as { code: unknown }).code === '23505' &&
      'constraint' in candidate &&
      (candidate as { constraint: unknown }).constraint === constraintName,
  );
}
