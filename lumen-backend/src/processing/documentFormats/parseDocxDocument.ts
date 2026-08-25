import mammoth from 'mammoth';
import type { ParsedDocument } from './ParsedDocument.js';
import { EpubValidationError } from '../errors/ProcessingErrors.js';

/**
 * DOCX CHAPTER POLICY — APPROVED, SETTLED BEHAVIOR (not a pending TODO):
 * DOCX does NOT infer chapters from Heading1/Heading2/or any other paragraph style.
 * Every DOCX upload is normalized into exactly ONE generated chapter (title: null,
 * never fabricated) containing all extracted paragraphs in original document order —
 * identical in structure to how TXT and PDF are handled. This was evaluated and
 * explicitly approved as-is: heading styles are not a reliable signal of real chapter
 * boundaries (not every author uses them, and even when used they don't always align
 * with the book's actual structure), so building a separate heading-detection/HTML
 * parsing subsystem was judged not worth the added complexity for an unreliable result.
 * Future heading-based chapter detection is a distinct, separately-approvable
 * workstream, not an implied next step of this one.
 *
 * Uses mammoth.extractRawText() specifically -- NOT convertToHtml(). extractRawText
 * ignores all DOCX formatting/markup entirely and returns plain text directly, which
 * means NO HTML IS EVER PRODUCED at any point in this path -- a stronger, simpler
 * safety property than extracting HTML and stripping it afterward. Per mammoth's own
 * documented output convention, each paragraph is followed by two newlines.
 *
 * The resulting plain-text paragraphs flow into the same normalized ParsedDocument
 * shape as every other format, consumed downstream by the exact same format-agnostic
 * Chapter/TextSegment persistence, NarrationEngine, and Reader/Player code paths --
 * none of which contain any DOCX-specific (or any format-specific) logic.
 */
export async function parseDocxDocument(buffer: Buffer): Promise<ParsedDocument> {
  let result: { value: string };
  try {
    result = await mammoth.extractRawText({ buffer });
  } catch (cause) {
    throw new EpubValidationError('INVALID_DOCX', { cause });
  }

  const paragraphs = result.value
    .split(/\n{2,}/)
    .map((p) => p.replace(/\n/g, ' ').trim())
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
