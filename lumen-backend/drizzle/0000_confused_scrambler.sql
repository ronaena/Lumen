CREATE TYPE "public"."audio_format" AS ENUM('mp3', 'wav', 'ogg_opus');--> statement-breakpoint
CREATE TYPE "public"."audio_segment_status" AS ENUM('active', 'superseded', 'orphaned');--> statement-breakpoint
CREATE TYPE "public"."book_status" AS ENUM('uploaded', 'processing', 'ready', 'partially_ready', 'failed', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."chapter_status" AS ENUM('pending', 'extracting', 'segmented', 'narrating', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."job_step_scope_type" AS ENUM('book', 'chapter');--> statement-breakpoint
CREATE TYPE "public"."narration_attempt_status" AS ENUM('queued', 'processing', 'succeeded', 'failed', 'retried', 'fallback_triggered', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."narration_status" AS ENUM('pending', 'queued', 'generating', 'ready', 'failed', 'stale', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."processing_job_status" AS ENUM('queued', 'processing', 'completed', 'failed', 'paused', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."processing_job_step_type" AS ENUM('upload', 'validation', 'extraction', 'chapter_detection', 'segmentation', 'narration', 'audio_finalization');--> statement-breakpoint
CREATE TYPE "public"."processing_job_type" AS ENUM('full_processing', 'reprocessing', 'single_chapter_retry');--> statement-breakpoint
CREATE TYPE "public"."provider_usage_outcome" AS ENUM('success', 'failure');--> statement-breakpoint
CREATE TYPE "public"."voice_role" AS ENUM('narrator', 'character');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(320) NOT NULL,
	"display_name" varchar(200),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "book_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"book_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"original_file_storage_ref" text NOT NULL,
	"original_filename" varchar(500) NOT NULL,
	"file_size_bytes" bigint NOT NULL,
	"checksum" varchar(64) NOT NULL,
	"mime_type" varchar(100) NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "books" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" varchar(500) NOT NULL,
	"author" varchar(300),
	"description" text,
	"language" varchar(20) NOT NULL,
	"cover_storage_ref" text,
	"status" "book_status" DEFAULT 'uploaded' NOT NULL,
	"chapter_count" integer DEFAULT 0 NOT NULL,
	"segment_count" integer DEFAULT 0 NOT NULL,
	"audio_duration_ms" bigint DEFAULT 0 NOT NULL,
	"processing_progress_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chapters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"book_id" uuid NOT NULL,
	"order_index" integer NOT NULL,
	"title" varchar(500),
	"source_location" text NOT NULL,
	"status" "chapter_status" DEFAULT 'pending' NOT NULL,
	"text_char_count" integer DEFAULT 0 NOT NULL,
	"segment_count" integer DEFAULT 0 NOT NULL,
	"audio_duration_ms" bigint DEFAULT 0 NOT NULL,
	"processing_progress_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "voice_provider_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"voice_id" uuid NOT NULL,
	"provider" varchar(50) NOT NULL,
	"provider_voice_id" varchar(200) NOT NULL,
	"provider_model" varchar(100),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "voices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"book_id" uuid,
	"display_name" varchar(200) NOT NULL,
	"role" "voice_role" DEFAULT 'narrator' NOT NULL,
	"language" varchar(20) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "text_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chapter_id" uuid NOT NULL,
	"order_index" integer NOT NULL,
	"source_text" text NOT NULL,
	"normalized_text" text NOT NULL,
	"char_count" integer NOT NULL,
	"source_reference" text NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"narrator_voice_id" uuid NOT NULL,
	"character_voice_id" uuid,
	"delivery_direction" jsonb,
	"delivery_direction_version" integer DEFAULT 1 NOT NULL,
	"narration_status" "narration_status" DEFAULT 'pending' NOT NULL,
	"text_version" integer DEFAULT 1 NOT NULL,
	"current_audio_segment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "narration_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"text_segment_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"provider" varchar(50) NOT NULL,
	"provider_job_id" varchar(200),
	"request_id" uuid NOT NULL,
	"request_signature" varchar(64) NOT NULL,
	"status" "narration_attempt_status" DEFAULT 'queued' NOT NULL,
	"normalized_error_code" varchar(50),
	"error_message" text,
	"warnings" jsonb,
	"is_fallback_attempt" boolean DEFAULT false NOT NULL,
	"triggering_attempt_id" uuid,
	"estimated_cost" numeric(12, 6),
	"actual_cost" numeric(12, 6),
	"cost_ceiling_at_request" numeric(12, 6),
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audio_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"text_segment_id" uuid NOT NULL,
	"produced_by_attempt_id" uuid NOT NULL,
	"storage_ref" text NOT NULL,
	"provider" varchar(50) NOT NULL,
	"provider_job_id" varchar(200),
	"model_used" varchar(100) NOT NULL,
	"provider_voice_id" varchar(200) NOT NULL,
	"duration_ms" integer NOT NULL,
	"format" "audio_format" NOT NULL,
	"sample_rate_hz" integer NOT NULL,
	"file_size_bytes" bigint NOT NULL,
	"checksum" varchar(64) NOT NULL,
	"estimated_cost" numeric(12, 6) NOT NULL,
	"actual_cost" numeric(12, 6),
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"generation_signature" varchar(64) NOT NULL,
	"status" "audio_segment_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "processing_job_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"processing_job_id" uuid NOT NULL,
	"step_type" "processing_job_step_type" NOT NULL,
	"scope_type" "job_step_scope_type" NOT NULL,
	"scope_id" uuid,
	"status" "processing_job_status" DEFAULT 'queued' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "processing_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"book_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"job_type" "processing_job_type" NOT NULL,
	"scope_id" uuid,
	"status" "processing_job_status" DEFAULT 'queued' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"narration_attempt_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"chapter_id" uuid NOT NULL,
	"text_segment_id" uuid NOT NULL,
	"provider" varchar(50) NOT NULL,
	"model" varchar(100) NOT NULL,
	"char_count" integer NOT NULL,
	"estimated_cost" numeric(12, 6) NOT NULL,
	"actual_cost" numeric(12, 6),
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"outcome" "provider_usage_outcome" NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "listening_progress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"chapter_id" uuid NOT NULL,
	"audio_segment_id" uuid,
	"playback_position_ms" integer DEFAULT 0 NOT NULL,
	"completion_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	"last_listened_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reading_progress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"chapter_id" uuid NOT NULL,
	"text_segment_id" uuid,
	"reading_position_offset" integer,
	"completion_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "character_voice_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"character_id" uuid NOT NULL,
	"voice_id" uuid NOT NULL,
	"confidence" numeric(3, 2),
	"is_user_confirmed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "characters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"book_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"description" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scenes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chapter_id" uuid NOT NULL,
	"start_segment_id" uuid NOT NULL,
	"end_segment_id" uuid NOT NULL,
	"scene_type" varchar(50),
	"emotional_classification" varchar(100),
	"intensity" numeric(3, 2),
	"confidence" numeric(3, 2),
	"direction" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "book_sources" ADD CONSTRAINT "book_sources_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "book_sources" ADD CONSTRAINT "book_sources_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "books" ADD CONSTRAINT "books_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chapters" ADD CONSTRAINT "chapters_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "voice_provider_mappings" ADD CONSTRAINT "voice_provider_mappings_voice_id_voices_id_fk" FOREIGN KEY ("voice_id") REFERENCES "public"."voices"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "voices" ADD CONSTRAINT "voices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "voices" ADD CONSTRAINT "voices_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "text_segments" ADD CONSTRAINT "text_segments_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapters"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "text_segments" ADD CONSTRAINT "text_segments_narrator_voice_id_voices_id_fk" FOREIGN KEY ("narrator_voice_id") REFERENCES "public"."voices"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "text_segments" ADD CONSTRAINT "text_segments_character_voice_id_voices_id_fk" FOREIGN KEY ("character_voice_id") REFERENCES "public"."voices"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "narration_attempts" ADD CONSTRAINT "narration_attempts_text_segment_id_text_segments_id_fk" FOREIGN KEY ("text_segment_id") REFERENCES "public"."text_segments"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "narration_attempts" ADD CONSTRAINT "narration_attempts_triggering_attempt_id_narration_attempts_id_fk" FOREIGN KEY ("triggering_attempt_id") REFERENCES "public"."narration_attempts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audio_segments" ADD CONSTRAINT "audio_segments_text_segment_id_text_segments_id_fk" FOREIGN KEY ("text_segment_id") REFERENCES "public"."text_segments"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audio_segments" ADD CONSTRAINT "audio_segments_produced_by_attempt_id_narration_attempts_id_fk" FOREIGN KEY ("produced_by_attempt_id") REFERENCES "public"."narration_attempts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "processing_job_steps" ADD CONSTRAINT "processing_job_steps_processing_job_id_processing_jobs_id_fk" FOREIGN KEY ("processing_job_id") REFERENCES "public"."processing_jobs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "provider_usage" ADD CONSTRAINT "provider_usage_narration_attempt_id_narration_attempts_id_fk" FOREIGN KEY ("narration_attempt_id") REFERENCES "public"."narration_attempts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "provider_usage" ADD CONSTRAINT "provider_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "provider_usage" ADD CONSTRAINT "provider_usage_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "provider_usage" ADD CONSTRAINT "provider_usage_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapters"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "provider_usage" ADD CONSTRAINT "provider_usage_text_segment_id_text_segments_id_fk" FOREIGN KEY ("text_segment_id") REFERENCES "public"."text_segments"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "listening_progress" ADD CONSTRAINT "listening_progress_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "listening_progress" ADD CONSTRAINT "listening_progress_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "listening_progress" ADD CONSTRAINT "listening_progress_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapters"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "listening_progress" ADD CONSTRAINT "listening_progress_audio_segment_id_audio_segments_id_fk" FOREIGN KEY ("audio_segment_id") REFERENCES "public"."audio_segments"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reading_progress" ADD CONSTRAINT "reading_progress_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reading_progress" ADD CONSTRAINT "reading_progress_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reading_progress" ADD CONSTRAINT "reading_progress_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapters"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reading_progress" ADD CONSTRAINT "reading_progress_text_segment_id_text_segments_id_fk" FOREIGN KEY ("text_segment_id") REFERENCES "public"."text_segments"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "character_voice_assignments" ADD CONSTRAINT "character_voice_assignments_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "character_voice_assignments" ADD CONSTRAINT "character_voice_assignments_voice_id_voices_id_fk" FOREIGN KEY ("voice_id") REFERENCES "public"."voices"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "characters" ADD CONSTRAINT "characters_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scenes" ADD CONSTRAINT "scenes_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapters"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scenes" ADD CONSTRAINT "scenes_start_segment_id_text_segments_id_fk" FOREIGN KEY ("start_segment_id") REFERENCES "public"."text_segments"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scenes" ADD CONSTRAINT "scenes_end_segment_id_text_segments_id_fk" FOREIGN KEY ("end_segment_id") REFERENCES "public"."text_segments"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_unique" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "book_sources_book_id_unique" ON "book_sources" USING btree ("book_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "book_sources_user_checksum_unique" ON "book_sources" USING btree ("user_id","checksum");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "books_user_status_idx" ON "books" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chapters_book_order_unique" ON "chapters" USING btree ("book_id","order_index");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "voice_provider_mappings_active_unique" ON "voice_provider_mappings" USING btree ("voice_id","provider") WHERE "voice_provider_mappings"."is_active" = true;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "text_segments_chapter_order_unique" ON "text_segments" USING btree ("chapter_id","order_index");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "text_segments_content_hash_idx" ON "text_segments" USING btree ("content_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "narration_attempts_request_id_unique" ON "narration_attempts" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "narration_attempts_segment_attempt_unique" ON "narration_attempts" USING btree ("text_segment_id","attempt_number");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "narration_attempts_one_processing_unique" ON "narration_attempts" USING btree ("text_segment_id") WHERE "narration_attempts"."status" = 'processing';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "narration_attempts_status_provider_idx" ON "narration_attempts" USING btree ("status","provider");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "audio_segments_produced_by_unique" ON "audio_segments" USING btree ("produced_by_attempt_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audio_segments_text_segment_status_idx" ON "audio_segments" USING btree ("text_segment_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "processing_jobs_book_level_active_unique" ON "processing_jobs" USING btree ("book_id","job_type") WHERE "processing_jobs"."scope_id" IS NULL AND "processing_jobs"."status" IN ('queued','processing');--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "processing_jobs_scoped_active_unique" ON "processing_jobs" USING btree ("book_id","job_type","scope_id") WHERE "processing_jobs"."scope_id" IS NOT NULL AND "processing_jobs"."status" IN ('queued','processing');--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "provider_usage_attempt_unique" ON "provider_usage" USING btree ("narration_attempt_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_usage_user_recorded_idx" ON "provider_usage" USING btree ("user_id","recorded_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_usage_book_recorded_idx" ON "provider_usage" USING btree ("book_id","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "listening_progress_user_book_unique" ON "listening_progress" USING btree ("user_id","book_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reading_progress_user_book_unique" ON "reading_progress" USING btree ("user_id","book_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "character_voice_assignments_character_unique" ON "character_voice_assignments" USING btree ("character_id");