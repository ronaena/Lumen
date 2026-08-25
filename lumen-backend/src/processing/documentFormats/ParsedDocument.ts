/**
 * ParsedDocument — the normalized boundary between format-specific parsers and the
 * existing Chapter/TextSegment persistence layer. Deliberately minimal: only the fields
 * the existing database/pipeline actually needs (per Multi-Format Ingestion discovery
 * Phase F/G), nothing invented for theoretical future use.
 */
export interface ParsedDocumentMetadata {
  title?: string;
  author?: string;
  language?: string;
}

export interface ParsedChapter {
  orderIndex: number;
  /** Never fabricated -- null when the source has no reliable chapter title (e.g. the single-generated-chapter fallback). */
  title: string | null;
  /** Traceable back to the source -- an in-archive path for EPUB, a fixed literal for formats with no internal addressing. */
  sourceLocation: string;
  /** Raw paragraph text, in reading order. Plain text only -- never HTML/XML/markup. */
  paragraphs: string[];
}

export interface ParsedDocument {
  metadata: ParsedDocumentMetadata;
  chapters: ParsedChapter[];
}
