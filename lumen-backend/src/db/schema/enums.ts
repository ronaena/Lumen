import { pgEnum } from 'drizzle-orm/pg-core';

export const bookStatusEnum = pgEnum('book_status', [
  'uploaded',
  'processing',
  'ready',
  'partially_ready',
  'failed',
  'deleted',
]);

export const chapterStatusEnum = pgEnum('chapter_status', [
  'pending',
  'extracting',
  'segmented',
  'narrating',
  'ready',
  'failed',
]);

// Includes 'cancelled' per corrections §8 (C / CDC-4).
export const narrationStatusEnum = pgEnum('narration_status', [
  'pending',
  'queued',
  'generating',
  'ready',
  'failed',
  'stale',
  'cancelled',
]);

export const audioSegmentStatusEnum = pgEnum('audio_segment_status', [
  'active',
  'superseded',
  'orphaned',
]);

export const processingJobTypeEnum = pgEnum('processing_job_type', [
  'full_processing',
  'reprocessing',
  'single_chapter_retry',
]);

export const processingJobStatusEnum = pgEnum('processing_job_status', [
  'queued',
  'processing',
  'completed',
  'failed',
  'paused',
  'cancelled',
]);

// Includes 'validation' as its own step per corrections §6 (A / CDC-2 / PIPE-1).
export const processingJobStepTypeEnum = pgEnum('processing_job_step_type', [
  'upload',
  'validation',
  'extraction',
  'chapter_detection',
  'segmentation',
  'narration',
  'audio_finalization',
]);

export const jobStepScopeTypeEnum = pgEnum('job_step_scope_type', ['book', 'chapter']);

// Includes 'cancelled', distinct from 'failed', per corrections §8.
export const narrationAttemptStatusEnum = pgEnum('narration_attempt_status', [
  'queued',
  'processing',
  'succeeded',
  'failed',
  'retried',
  'fallback_triggered',
  'cancelled',
]);

export const providerUsageOutcomeEnum = pgEnum('provider_usage_outcome', ['success', 'failure']);

export const voiceRoleEnum = pgEnum('voice_role', ['narrator', 'character']);

/**
 * Voice Management v1 (approved workstream). Database-backed authorization, per the
 * approved Decision Gate: admin status comes ONLY from this column, never from a
 * client-supplied field, header, or environment variable. Every user defaults to
 * 'user' -- no existing user is silently promoted by this migration.
 */
export const userRoleEnum = pgEnum('user_role', ['user', 'admin']);

export const audioFormatEnum = pgEnum('audio_format', ['mp3', 'wav', 'ogg_opus']);
