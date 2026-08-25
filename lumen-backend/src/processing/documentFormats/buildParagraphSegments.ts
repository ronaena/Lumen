import { createHash } from 'node:crypto';
import type { ParagraphSegment } from '../segmentation/paragraphSegmentation.js';

/**
 * Applies the exact same normalize/filter/hash rules as the existing EPUB segmentation
 * path (paragraphSegmentation.ts's normalizeWhitespace/computeContentHash/empty-filter
 * logic) to a plain array of raw paragraph strings, from ANY source format.
 *
 * Deliberately DUPLICATED rather than extracted-and-shared with segmentChapterText: the
 * EPUB path is tested, working code, and per the approved scope ("preserve EPUB exactly
 * unless required by the new shared boundary"), refactoring it to share this ~10-line
 * block carries more regression risk than a small duplication does. This function never
 * touches XML/HTML parsing at all -- it only normalizes already-extracted plain text,
 * which is exactly what every non-EPUB parser produces.
 */
export function buildParagraphSegments(rawParagraphs: string[]): ParagraphSegment[] {
  const segments: ParagraphSegment[] = [];
  let orderIndex = 0;

  rawParagraphs.forEach((raw, sourceIndex) => {
    const normalizedText = raw.replace(/\s+/g, ' ').trim();
    if (normalizedText.length === 0) return;

    const sourceText = raw.trim();
    segments.push({
      orderIndex,
      sourceText,
      normalizedText,
      charCount: normalizedText.length,
      sourceReference: `p[${sourceIndex}]`,
      contentHash: createHash('sha256').update(normalizedText, 'utf8').digest('hex'),
    });
    orderIndex += 1;
  });

  return segments;
}
