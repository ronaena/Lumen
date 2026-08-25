import { XMLParser } from 'fast-xml-parser';
import { createHash } from 'node:crypto';
import { EpubValidationError } from '../errors/ProcessingErrors.js';

export interface ParagraphSegment {
  orderIndex: number;
  sourceText: string;
  normalizedText: string;
  charCount: number;
  /** Traceable back to the source: the index of this <p> within its chapter document. */
  sourceReference: string;
  contentHash: string;
}

// preserveOrder: true is essential here — without it, fast-xml-parser groups all text
// nodes of an element together separately from its child elements, which silently
// REORDERS mixed content like "She said <em>hello</em> to the <strong>world</strong>."
// into something like "hello world She said to the ." — a real correctness bug for
// narration text, not just a formatting nicety. preserveOrder keeps text and child
// elements interleaved exactly as they appear in the source.
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  preserveOrder: true,
  trimValues: false, // we do our own whitespace normalization for narration text
  htmlEntities: true,
});

type XmlNode = Record<string, unknown>;

/** Concatenates text content from a preserveOrder node array, in original document order. */
function extractTextFromNodes(nodes: XmlNode[]): string {
  const parts: string[] = [];
  for (const node of nodes) {
    if ('#text' in node) {
      parts.push(String(node['#text']));
      continue;
    }
    for (const key of Object.keys(node)) {
      if (key === ':@') continue;
      const children = node[key];
      if (Array.isArray(children)) {
        parts.push(extractTextFromNodes(children as XmlNode[]));
      }
    }
  }
  return parts.join('');
}

/** Collects the raw (pre-normalization) text of every <p> element anywhere in the tree. */
function collectParagraphs(nodes: XmlNode[], out: string[]): void {
  for (const node of nodes) {
    if ('#text' in node) continue;
    for (const key of Object.keys(node)) {
      if (key === ':@') continue;
      const children = node[key];
      if (!Array.isArray(children)) continue;
      if (key.toLowerCase() === 'p') {
        out.push(extractTextFromNodes(children as XmlNode[]));
      } else {
        collectParagraphs(children as XmlNode[], out);
      }
    }
  }
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function computeContentHash(normalizedText: string): string {
  return createHash('sha256').update(normalizedText, 'utf8').digest('hex');
}

/**
 * Segments a chapter's XHTML content into paragraph-based TextSegments.
 *
 * Rules (per approved decision): one meaningful <p> = one segment; purely
 * structural/empty elements are ignored; no arbitrary character-count splitting; no
 * sentence splitting. sourceText preserves the paragraph's text closely enough for
 * read-along display; normalizedText is the whitespace-collapsed narration-ready version.
 */
export function segmentChapterText(xhtml: string): ParagraphSegment[] {
  let parsed: XmlNode[];
  try {
    parsed = xmlParser.parse(xhtml) as XmlNode[];
  } catch (cause) {
    throw new EpubValidationError('UNPARSEABLE_STRUCTURE', { cause });
  }

  const rawParagraphs: string[] = [];
  collectParagraphs(parsed, rawParagraphs);

  const segments: ParagraphSegment[] = [];
  let orderIndex = 0;
  rawParagraphs.forEach((raw, sourceIndex) => {
    const normalizedText = normalizeWhitespace(raw);
    // Ignore purely structural/empty elements that contain no meaningful text.
    if (normalizedText.length === 0) return;

    const sourceText = raw.trim();
    segments.push({
      orderIndex,
      sourceText,
      normalizedText,
      charCount: normalizedText.length,
      sourceReference: `p[${sourceIndex}]`,
      contentHash: computeContentHash(normalizedText),
    });
    orderIndex += 1;
  });

  return segments;
}
