import { describe, it, expect } from 'vitest';
import { validateEpubUpload } from '../../src/processing/validation/validateEpubUpload.js';
import { EpubValidationError } from '../../src/processing/errors/ProcessingErrors.js';
import {
  buildValidEpub,
  buildCorruptZip,
  buildZipMissingMimetype,
  buildZipMissingContainer,
  buildZipInvalidOpfReference,
} from '../fixtures/buildEpub.js';

const basicChapters = [
  { id: 'ch1', filename: 'ch1.xhtml', title: 'Chapter One', paragraphs: ['Once upon a time.'] },
];

describe('validateEpubUpload', () => {
  it('A: accepts a valid EPUB', async () => {
    const buffer = await buildValidEpub({ chapters: basicChapters });
    const archive = await validateEpubUpload({
      buffer,
      filename: 'book.epub',
      mimeType: 'application/epub+zip',
    });
    expect(archive.has('mimetype')).toBe(true);
  });

  it('B: rejects an invalid extension', async () => {
    const buffer = await buildValidEpub({ chapters: basicChapters });
    await expect(
      validateEpubUpload({ buffer, filename: 'book.txt', mimeType: 'application/epub+zip' }),
    ).rejects.toMatchObject({ code: 'INVALID_EXTENSION' });
  });

  it('C: rejects an invalid MIME type', async () => {
    const buffer = await buildValidEpub({ chapters: basicChapters });
    await expect(
      validateEpubUpload({ buffer, filename: 'book.epub', mimeType: 'text/plain' }),
    ).rejects.toMatchObject({ code: 'INVALID_MIME' });
  });

  it('D: rejects a file over 200MB', async () => {
    const oversized = Buffer.alloc(200 * 1024 * 1024 + 1);
    await expect(
      validateEpubUpload({ buffer: oversized, filename: 'book.epub', mimeType: 'application/epub+zip' }),
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });

  it('E: rejects a zip missing the mimetype entry', async () => {
    const buffer = await buildZipMissingMimetype();
    await expect(
      validateEpubUpload({ buffer, filename: 'book.epub', mimeType: 'application/epub+zip' }),
    ).rejects.toMatchObject({ code: 'MISSING_MIMETYPE_ENTRY' });
  });

  it('F: rejects a zip missing META-INF/container.xml', async () => {
    const buffer = await buildZipMissingContainer();
    await expect(
      validateEpubUpload({ buffer, filename: 'book.epub', mimeType: 'application/epub+zip' }),
    ).rejects.toMatchObject({ code: 'MISSING_CONTAINER_XML' });
  });

  it('G: rejects a container.xml that cannot resolve a valid OPF (caught during extraction)', async () => {
    // validateEpubUpload only checks mimetype + container.xml presence; deep OPF
    // resolution happens during parseEpub() in the pipeline (see pipeline.test.ts) to
    // avoid double-parsing. This test confirms the archive itself is still readable up
    // to that point and the failure surfaces with the same safe error type downstream.
    const buffer = await buildZipInvalidOpfReference();
    const archive = await validateEpubUpload({
      buffer,
      filename: 'book.epub',
      mimeType: 'application/epub+zip',
    });
    const { parseEpub } = await import('../../src/processing/epub/EpubParser.js');
    expect(() => parseEpub(archive)).toThrow(EpubValidationError);
    try {
      parseEpub(archive);
    } catch (error) {
      expect((error as EpubValidationError).code).toBe('INVALID_OPF_REFERENCE');
    }
  });

  it('H: rejects a corrupt ZIP container', async () => {
    const buffer = await buildCorruptZip();
    await expect(
      validateEpubUpload({ buffer, filename: 'book.epub', mimeType: 'application/epub+zip' }),
    ).rejects.toMatchObject({ code: 'CORRUPT_ZIP' });
  });

  it('I: accepts a valid EPUB with no NCX/nav at all', async () => {
    const buffer = await buildValidEpub({ chapters: basicChapters, includeNcx: false, includeNav: false });
    const archive = await validateEpubUpload({
      buffer,
      filename: 'book.epub',
      mimeType: 'application/epub+zip',
    });
    expect(archive.has('mimetype')).toBe(true);
  });

  it('never exposes a raw parser exception message to the caller', async () => {
    const buffer = await buildCorruptZip();
    try {
      await validateEpubUpload({ buffer, filename: 'book.epub', mimeType: 'application/epub+zip' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(EpubValidationError);
      expect((error as Error).message).not.toMatch(/unzipper|ENOENT|Buffer|stack/i);
    }
  });
});
