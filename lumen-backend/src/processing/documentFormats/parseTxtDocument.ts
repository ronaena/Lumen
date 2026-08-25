import type { ParsedDocument } from './ParsedDocument.js';

/**
 * TXT has no chapter structure of any kind -- always the single-generated-chapter
 * fallback, per the approved no-chapter-fallback decision. No title is fabricated.
 * Paragraphs are split on one-or-more blank lines, matching ordinary plain-text
 * paragraph conventions; no sentence splitting, no artificial content generation.
 */
export function parseTxtDocument(buffer: Buffer): ParsedDocument {
  const text = buffer.toString('utf8');
  const paragraphs = text
    .split(/\r\n\r\n|\n\n+/)
    .map((p) => p.replace(/\r\n/g, '\n').trim())
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
