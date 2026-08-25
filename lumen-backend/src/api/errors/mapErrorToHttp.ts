import { EpubValidationError, ProcessingError, DuplicateBookError } from '../../processing/errors/ProcessingErrors.js';

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}

export interface MappedError {
  status: number;
  body: ApiErrorBody;
}

/**
 * The single place raw application/database errors are translated into safe HTTP
 * responses. Every route handler funnels its catch block through this function —
 * handlers never construct an error response body themselves, which is what prevents
 * a raw pg/parser/vendor error from ever reaching a client by accident.
 */
export function mapErrorToHttp(error: unknown): MappedError {
  if (error instanceof EpubValidationError) {
    return { status: 422, body: { error: { code: error.code, message: error.message } } };
  }

  if (error instanceof DuplicateBookError) {
    return { status: 409, body: { error: { code: 'DUPLICATE_BOOK', message: error.message } } };
  }

  if (error instanceof ProcessingError) {
    const status = processingErrorStatus(error.code);
    return { status, body: { error: { code: error.code, message: error.message } } };
  }

  // Anything else (raw pg errors, drizzle wrapper errors, unexpected exceptions) is
  // deliberately NOT inspected for message content here — that's exactly the leak this
  // function exists to prevent. A generic, safe message only.
  return {
    status: 500,
    body: { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong while processing this request.' } },
  };
}

function processingErrorStatus(code: string): number {
  switch (code) {
    case 'SEGMENT_NOT_FOUND':
    case 'CHARACTER_NOT_FOUND':
    case 'SCENE_NOT_FOUND':
    case 'CHAPTER_NOT_FOUND':
      return 404;
    case 'CANNOT_REMOVE_LAST_ADMIN':
      return 409;
    case 'CANNOT_DISABLE_SELF':
      return 403;
    case 'VOICE_NOT_FOUND':
    case 'NO_ELIGIBLE_PROVIDER':
      return 404;
    case 'INVALID_PROGRESS_REFERENCE':
    case 'INVALID_SCENE_REFERENCE':
    case 'VOICE_ASSIGNMENT_INVALID':
      return 422;
    case 'EMAIL_ALREADY_REGISTERED':
      return 409;
    case 'AUTHENTICATION_FAILED':
      return 401;
    case 'CHAPTER_DETECTION_FAILED':
    case 'EXTRACTION_FAILED':
    case 'SEGMENTATION_FAILED':
    case 'STORAGE_FAILED':
    case 'NARRATION_FAILED':
      return 500;
    default:
      return 500;
  }
}

/** For "no trusted identity was established for this request." */
export const IDENTITY_UNAVAILABLE: MappedError = {
  status: 401,
  body: {
    error: {
      code: 'IDENTITY_UNAVAILABLE',
      message: 'This request could not be attributed to an authenticated user.',
    },
  },
};

export const VALIDATION_FAILED = (message: string): MappedError => ({
  status: 400,
  body: { error: { code: 'VALIDATION_FAILED', message } },
});

export const NOT_FOUND: MappedError = {
  status: 404,
  body: { error: { code: 'NOT_FOUND', message: 'The requested resource could not be found.' } },
};
