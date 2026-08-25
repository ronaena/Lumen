import { getDocumentProxy, extractText } from 'unpdf';
import type { ParsedDocument } from './ParsedDocument.js';
import { EpubValidationError } from '../errors/ProcessingErrors.js';

/**
 * Text-based PDFs only, per the approved scope. A scanned/image-only PDF produces zero
 * (or near-zero) extractable text -- this function does NOT attempt OCR and does NOT
 * fabricate content; it lets the resulting empty paragraph list flow through to the
 * caller, which is responsible for raising EMPTY_DOCUMENT (see parseDocumentUpload.ts).
 * That keeps "this PDF has no extractable text" and "this PDF is malformed" as
 * distinguishable, honestly-reported outcomes rather than collapsing them.
 *
 * Single-generated-chapter fallback, same as TXT/DOCX -- PDF bookmark/outline-based
 * chapter detection was classified as unreliable heuristic detection in the discovery
 * report and is not attempted here.
 */
export async function parsePdfDocument(buffer: Buffer): Promise<ParsedDocument> {
  let pageTexts: string[];
  try {
    const doc = await getDocumentProxy(new Uint8Array(buffer));
    const result = await extractText(doc, { mergePages: false });
    pageTexts = result.text;
  } catch (cause) {
    throw new EpubValidationError('INVALID_PDF', { cause });
  }

  const paragraphs = pageTexts
    .flatMap((pageText) => pageText.split(/\r\n\r\n|\n\n+/))
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 0);

  return {
    metadata: {},
    chapters: [
      {
        orderIndex: 0,
        title: null,
        sourceLocation: 'document',
        paragraphs,
      },
    ],
  };
}
