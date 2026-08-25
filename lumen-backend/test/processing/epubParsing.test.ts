import { describe, it, expect } from 'vitest';
import { EpubArchive } from '../../src/processing/epub/EpubArchive.js';
import { parseEpub } from '../../src/processing/epub/EpubParser.js';
import { buildValidEpub } from '../fixtures/buildEpub.js';

const threeChapters = [
  { id: 'ch1', filename: 'ch1.xhtml', title: 'The Beginning', paragraphs: ['Para one.'] },
  { id: 'ch2', filename: 'ch2.xhtml', title: 'The Middle', paragraphs: ['Para two.'] },
  { id: 'ch3', filename: 'ch3.xhtml', title: 'The End', paragraphs: ['Para three.'] },
];

describe('parseEpub', () => {
  it('K: spine order is authoritative and deterministic', async () => {
    const buffer = await buildValidEpub({ chapters: threeChapters, title: 'Test Book' });
    const archive = await EpubArchive.fromBuffer(buffer);
    const parsed = parseEpub(archive);

    expect(parsed.spineDocuments).toHaveLength(3);
    expect(parsed.spineDocuments.map((d) => d.orderIndex)).toEqual([0, 1, 2]);
    expect(parsed.spineDocuments.map((d) => d.path)).toEqual([
      'OEBPS/ch1.xhtml',
      'OEBPS/ch2.xhtml',
      'OEBPS/ch3.xhtml',
    ]);
  });

  it('L: chapter titles are extracted from NCX', async () => {
    const buffer = await buildValidEpub({ chapters: threeChapters, includeNcx: true });
    const archive = await EpubArchive.fromBuffer(buffer);
    const parsed = parseEpub(archive);

    expect(parsed.spineDocuments.map((d) => d.title)).toEqual([
      'The Beginning',
      'The Middle',
      'The End',
    ]);
  });

  it('L: chapter titles are extracted from EPUB3 nav when NCX is absent', async () => {
    const buffer = await buildValidEpub({ chapters: threeChapters, includeNcx: false, includeNav: true });
    const archive = await EpubArchive.fromBuffer(buffer);
    const parsed = parseEpub(archive);

    expect(parsed.spineDocuments.map((d) => d.title)).toEqual([
      'The Beginning',
      'The Middle',
      'The End',
    ]);
  });

  it('I: extracts correctly with no NCX/nav — titles are null, spine order still authoritative', async () => {
    const buffer = await buildValidEpub({ chapters: threeChapters, includeNcx: false, includeNav: false });
    const archive = await EpubArchive.fromBuffer(buffer);
    const parsed = parseEpub(archive);

    expect(parsed.spineDocuments).toHaveLength(3);
    expect(parsed.spineDocuments.every((d) => d.title === null)).toBe(true);
    expect(parsed.spineDocuments.map((d) => d.path)).toEqual([
      'OEBPS/ch1.xhtml',
      'OEBPS/ch2.xhtml',
      'OEBPS/ch3.xhtml',
    ]);
  });

  it('J: inconsistent navigation (NCX references a path not in the spine) does not break spine-based processing', async () => {
    const buffer = await buildValidEpub({ chapters: threeChapters, includeNcx: true });
    const archive = await EpubArchive.fromBuffer(buffer);
    // Corrupt only the NCX entry post-hoc to simulate inconsistent nav metadata, while
    // the spine/manifest/container remain perfectly valid.
    const zip = await import('jszip').then((m) => m.default.loadAsync(buffer));
    zip.file(
      'OEBPS/toc.ncx',
      `<?xml version="1.0"?><ncx><navMap><navPoint><navLabel><text>Ghost Chapter</text></navLabel><content src="does-not-exist.xhtml"/></navPoint></navMap></ncx>`,
    );
    const brokenNavBuffer = await zip.generateAsync({ type: 'nodebuffer' });
    const brokenArchive = await EpubArchive.fromBuffer(brokenNavBuffer);

    const parsed = parseEpub(brokenArchive);
    // Spine processing must still succeed — inconsistent nav must not override or block it.
    expect(parsed.spineDocuments).toHaveLength(3);
    // None of the titles resolve, since the NCX src doesn't match any real spine path.
    expect(parsed.spineDocuments.every((d) => d.title === null)).toBe(true);
  });

  it('extracts book metadata (title, author, language) from OPF', async () => {
    const buffer = await buildValidEpub({
      chapters: threeChapters,
      title: 'The Great Test',
      author: 'A. Writer',
      language: 'fr',
    });
    const archive = await EpubArchive.fromBuffer(buffer);
    const parsed = parseEpub(archive);

    expect(parsed.metadata.title).toBe('The Great Test');
    expect(parsed.metadata.author).toBe('A. Writer');
    expect(parsed.metadata.language).toBe('fr');
  });
});
