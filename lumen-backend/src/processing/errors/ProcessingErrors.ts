/**
 * Safe, user-facing error categories for EPUB validation and processing.
 *
 * Per spec §22/23 (and corrections §6): errors must be understandable to normal users and
 * raw provider/parser/XML/ZIP exceptions must never be exposed. Every throw site in
 * src/processing wraps the underlying (possibly ugly) parser error and re-throws one of
 * these instead — the raw cause is kept only on `.cause` for server-side logging.
 */
export type ValidationErrorCode =
  | 'INVALID_EXTENSION'
  | 'INVALID_MIME'
  | 'FILE_TOO_LARGE'
  | 'MISSING_MIMETYPE_ENTRY'
  | 'MISSING_CONTAINER_XML'
  | 'INVALID_OPF_REFERENCE'
  | 'UNPARSEABLE_STRUCTURE'
  | 'CORRUPT_ZIP'
  | 'UNSUPPORTED_FORMAT'
  | 'INVALID_DOCX'
  | 'INVALID_PDF'
  | 'EMPTY_DOCUMENT';

const SAFE_MESSAGES: Record<ValidationErrorCode, string> = {
  INVALID_EXTENSION: 'The uploaded file must have a .epub extension.',
  INVALID_MIME: 'The uploaded file must be a valid EPUB (application/epub+zip).',
  FILE_TOO_LARGE: 'The uploaded file exceeds the maximum allowed size of 200 MB.',
  MISSING_MIMETYPE_ENTRY: 'This file is missing the required EPUB mimetype entry.',
  MISSING_CONTAINER_XML: 'This file is missing the required EPUB container.xml.',
  INVALID_OPF_REFERENCE: 'This EPUB\'s package file could not be located or resolved.',
  UNPARSEABLE_STRUCTURE: 'This file\'s EPUB structure could not be read.',
  CORRUPT_ZIP: 'This file could not be opened — it may be corrupted.',
  UNSUPPORTED_FORMAT: 'This file format is not supported. Supported formats: EPUB, TXT, DOCX, PDF.',
  INVALID_DOCX: 'This file could not be opened as a valid DOCX document.',
  INVALID_PDF: 'This file could not be opened as a valid PDF document.',
  EMPTY_DOCUMENT: 'This document contains no readable text. If it is a scanned or image-only PDF, text extraction is not supported.',
};

export class EpubValidationError extends Error {
  readonly code: ValidationErrorCode;

  constructor(code: ValidationErrorCode, options?: { cause?: unknown }) {
    super(SAFE_MESSAGES[code]);
    this.name = 'EpubValidationError';
    this.code = code;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/**
 * A processing-stage failure that is safe to surface (via ProcessingJobStep.lastError)
 * without leaking implementation details. Distinct from EpubValidationError, which is
 * specifically about the uploaded file's own validity.
 */
export type ProcessingErrorCode =
  | 'EXTRACTION_FAILED'
  | 'CHAPTER_DETECTION_FAILED'
  | 'SEGMENTATION_FAILED'
  | 'STORAGE_FAILED'
  | 'VOICE_NOT_FOUND'
  | 'SEGMENT_NOT_FOUND'
  | 'NO_ELIGIBLE_PROVIDER'
  | 'NARRATION_FAILED'
  | 'INVALID_PROGRESS_REFERENCE'
  | 'CHARACTER_NOT_FOUND'
  | 'VOICE_ASSIGNMENT_INVALID'
  | 'SCENE_NOT_FOUND'
  | 'INVALID_SCENE_REFERENCE'
  | 'EMAIL_ALREADY_REGISTERED'
  | 'AUTHENTICATION_FAILED'
  | 'CHAPTER_NOT_FOUND'
  | 'CANNOT_REMOVE_LAST_ADMIN'
  | 'CANNOT_DISABLE_SELF';

const SAFE_PROCESSING_MESSAGES: Record<ProcessingErrorCode, string> = {
  EXTRACTION_FAILED: 'This book could not be extracted for processing.',
  CHAPTER_DETECTION_FAILED: 'This book\'s chapters could not be identified.',
  SEGMENTATION_FAILED: 'This book\'s text could not be prepared for narration.',
  STORAGE_FAILED: 'This file could not be saved.',
  VOICE_NOT_FOUND: 'The requested narrator voice could not be found.',
  SEGMENT_NOT_FOUND: 'The requested text segment could not be found.',
  NO_ELIGIBLE_PROVIDER: 'No narration provider is currently available for this request.',
  NARRATION_FAILED: 'This segment could not be narrated at this time.',
  INVALID_PROGRESS_REFERENCE: 'This progress update refers to content that does not belong to this book.',
  CHARACTER_NOT_FOUND: 'The requested character could not be found.',
  VOICE_ASSIGNMENT_INVALID: 'This character does not have a voice assigned yet.',
  SCENE_NOT_FOUND: 'The requested scene could not be found.',
  INVALID_SCENE_REFERENCE: 'This scene refers to content that does not belong to the same chapter.',
  EMAIL_ALREADY_REGISTERED: 'This email is already registered.',
  // Deliberately identical for "wrong password" and "unknown email" — this is the exact
  // mechanism that prevents login from being used to enumerate registered accounts.
  AUTHENTICATION_FAILED: 'Invalid email or password.',
  CHAPTER_NOT_FOUND: 'The requested chapter could not be found.',
  CANNOT_REMOVE_LAST_ADMIN: 'This action would leave the system with no administrators.',
  CANNOT_DISABLE_SELF: 'You cannot disable your own account.',
};

/**
 * Thrown when a (userId, checksum) upload collides with the DB-1 unique constraint.
 * Callers use this to distinguish "you already uploaded this exact file" from any other
 * processing failure — never surfaced as a raw Postgres constraint-violation message.
 */
export class DuplicateBookError extends Error {
  constructor(readonly existingBookId?: string) {
    super('You have already uploaded this exact file.');
    this.name = 'DuplicateBookError';
  }
}

export class ProcessingError extends Error {
  readonly code: ProcessingErrorCode;

  constructor(code: ProcessingErrorCode, options?: { cause?: unknown }) {
    super(SAFE_PROCESSING_MESSAGES[code]);
    this.name = 'ProcessingError';
    this.code = code;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}
