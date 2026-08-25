import { EpubValidationError } from '../errors/ProcessingErrors.js';

export type SupportedFormat = 'epub' | 'txt' | 'docx' | 'pdf';

const EXTENSION_TO_FORMAT: Record<string, SupportedFormat> = {
  '.epub': 'epub',
  '.txt': 'txt',
  '.docx': 'docx',
  '.pdf': 'pdf',
};

const FORMAT_TO_MIME: Record<SupportedFormat, string> = {
  epub: 'application/epub+zip',
  txt: 'text/plain',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
};

/**
 * Detects the upload format from its extension, and separately validates the declared
 * MIME type matches what that format actually requires. Extension is the primary
 * signal (matches the existing EPUB validation's own approach); MIME must agree, not
 * merely be present -- this prevents a client-controlled MIME type alone from selecting
 * a different parser than the extension implies.
 *
 * .doc (legacy binary Word) is explicitly and deliberately NOT in EXTENSION_TO_FORMAT --
 * per the approved scope, it is excluded, not silently unsupported by omission.
 */
export function detectFormat(filename: string, mimeType: string): SupportedFormat {
  const lowerFilename = filename.toLowerCase();
  const extension = Object.keys(EXTENSION_TO_FORMAT).find((ext) => lowerFilename.endsWith(ext));

  if (!extension) {
    throw new EpubValidationError('UNSUPPORTED_FORMAT');
  }

  const format = EXTENSION_TO_FORMAT[extension]!;
  if (mimeType !== FORMAT_TO_MIME[format]) {
    throw new EpubValidationError('UNSUPPORTED_FORMAT');
  }

  return format;
}
