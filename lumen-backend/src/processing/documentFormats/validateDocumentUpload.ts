import { EpubArchive } from '../epub/EpubArchive.js';
import { EpubValidationError } from '../errors/ProcessingErrors.js';
import type { SupportedFormat } from './detectFormat.js';

const MAX_FILE_SIZE_BYTES = 200 * 1024 * 1024; // 200 MB -- same limit already approved for EPUB

/**
 * Lightweight structural validation for TXT/DOCX/PDF, mirroring validateEpubUpload's own
 * cheap-before-expensive ordering (size check before any parsing). EPUB itself continues
 * to use validateEpubUpload exactly as before -- this function is never called for it.
 */
export async function validateDocumentUpload(buffer: Buffer, format: Exclude<SupportedFormat, 'epub'>): Promise<void> {
  if (buffer.byteLength > MAX_FILE_SIZE_BYTES) {
    throw new EpubValidationError('FILE_TOO_LARGE');
  }

  if (format === 'pdf') {
    // Standard PDF magic bytes -- catches an obviously-wrong file before an expensive
    // parse attempt, same cheap-check-first principle as EPUB's own validation.
    const header = buffer.subarray(0, 5).toString('latin1');
    if (header !== '%PDF-') {
      throw new EpubValidationError('INVALID_PDF');
    }
  }

  if (format === 'docx') {
    // DOCX is a ZIP containing word/document.xml -- reuses EpubArchive (a generic ZIP
    // reader despite its name/location) rather than importing unzipper a second time.
    let archive: EpubArchive;
    try {
      archive = await EpubArchive.fromBuffer(buffer);
    } catch (cause) {
      throw new EpubValidationError('INVALID_DOCX', { cause });
    }
    if (!archive.has('word/document.xml')) {
      throw new EpubValidationError('INVALID_DOCX');
    }
  }

  // TXT has no further structural check -- any byte sequence decodes as UTF-8 text
  // (possibly with replacement characters for invalid sequences, which is Node's
  // standard, safe behavior, not a crash).
}
