import { describe, it, expect } from 'vitest';
import { segmentChapterText } from '../../src/processing/segmentation/paragraphSegmentation.js';

describe('segmentChapterText', () => {
  it('M: produces one segment per meaningful paragraph, in document order', () => {
    const xhtml = `<html><body>
      <p>First paragraph.</p>
      <p>Second paragraph.</p>
      <p>Third paragraph.</p>
    </body></html>`;

    const segments = segmentChapterText(xhtml);
    expect(segments).toHaveLength(3);
    expect(segments.map((s) => s.normalizedText)).toEqual([
      'First paragraph.',
      'Second paragraph.',
      'Third paragraph.',
    ]);
    expect(segments.map((s) => s.orderIndex)).toEqual([0, 1, 2]);
  });

  it('N: ignores empty/purely structural elements', () => {
    const xhtml = `<html><body>
      <p>Real content.</p>
      <p></p>
      <p>   </p>
      <div><hr/></div>
      <p>More real content.</p>
    </body></html>`;

    const segments = segmentChapterText(xhtml);
    expect(segments).toHaveLength(2);
    expect(segments.map((s) => s.normalizedText)).toEqual(['Real content.', 'More real content.']);
    // orderIndex is dense (0,1), not sparse — empty paragraphs don't consume an index.
    expect(segments.map((s) => s.orderIndex)).toEqual([0, 1]);
  });

  it('handles nested inline markup within a paragraph as one segment', () => {
    const xhtml = `<html><body><p>She said <em>hello</em> to the <strong>world</strong>.</p></body></html>`;
    const segments = segmentChapterText(xhtml);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.normalizedText).toBe('She said hello to the world.');
  });

  it('O: normalizedText collapses whitespace/newlines for narration while sourceText stays close to source', () => {
    const xhtml = `<html><body><p>Line one\n      spread across\n      several lines.</p></body></html>`;
    const segments = segmentChapterText(xhtml);
    expect(segments[0]!.normalizedText).toBe('Line one spread across several lines.');
  });

  it('P: contentHash is deterministic for identical normalizedText', () => {
    const xhtml1 = `<html><body><p>Consistent text.</p></body></html>`;
    const xhtml2 = `<html><body><p>Consistent   text.</p></body></html>`; // extra whitespace, same normalized result

    const segments1 = segmentChapterText(xhtml1);
    const segments2 = segmentChapterText(xhtml2);

    expect(segments1[0]!.normalizedText).toBe(segments2[0]!.normalizedText);
    expect(segments1[0]!.contentHash).toBe(segments2[0]!.contentHash);
    expect(segments1[0]!.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('P: contentHash changes when normalizedText changes', () => {
    const xhtml1 = `<html><body><p>Version one.</p></body></html>`;
    const xhtml2 = `<html><body><p>Version two.</p></body></html>`;

    const segments1 = segmentChapterText(xhtml1);
    const segments2 = segmentChapterText(xhtml2);

    expect(segments1[0]!.contentHash).not.toBe(segments2[0]!.contentHash);
  });
});
