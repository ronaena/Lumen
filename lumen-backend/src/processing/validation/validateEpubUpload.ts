import { EpubArchive } from '../epub/EpubArchive.js';
import { EpubValidationError } from '../errors/ProcessingErrors.js';

const MAX_FILE_SIZE_BYTES = 200 * 1024 * 1024; // 200 MB
const REQUIRED_MIME_TYPE = 'application/epub+zip';
const REQUIRED_EXTENSION = '.epub';

export interface EpubUploadInput {
  buffer: Buffer;
  filename: string;
  mimeType: string;
}

/**
 * Validates an uploaded file against the approved MVP rules. Throws EpubValidationError
 * (a safe, user-facing error) on any failure — never a raw parser/ZIP/XML exception.
 *
 * Order matters: cheap checks (extension, MIME, size) run before opening the ZIP, so an
 * obviously-wrong upload never pays the cost of a full archive read.
 */
export async function validateEpubUpload(input: EpubUploadInput): Promise<EpubArchive> {
  const lowerFilename = input.filename.toLowerCase();
  if (!lowerFilename.endsWith(REQUIRED_EXTENSION)) {
    throw new EpubValidationError('INVALID_EXTENSION');
  }

  if (input.mimeType !== REQUIRED_MIME_TYPE) {
    throw new EpubValidationError('INVALID_MIME');
  }

  if (input.buffer.byteLength > MAX_FILE_SIZE_BYTES) {
    throw new EpubValidationError('FILE_TOO_LARGE');
  }

  let archive: EpubArchive;
  try {
    archive = await EpubArchive.fromBuffer(input.buffer);
  } catch (cause) {
    throw new EpubValidationError('CORRUPT_ZIP', { cause });
  }

  // EPUB spec: the mimetype entry must exist, be the literal text 'application/epub+zip'.
  const mimetypeEntry = archive.readText('mimetype');
  if (!mimetypeEntry || mimetypeEntry.trim() !== REQUIRED_MIME_TYPE) {
    throw new EpubValidationError('MISSING_MIMETYPE_ENTRY');
  }

  if (!archive.has('META-INF/container.xml')) {
    throw new EpubValidationError('MISSING_CONTAINER_XML');
  }

  // Deeper OPF resolution is validated as a side effect of parseEpub() in the pipeline —
  // re-parsing here would duplicate work. Callers must treat a subsequent parseEpub()
  // failure with the same EpubValidationError semantics (it throws the same error type).
  return archive;
}
