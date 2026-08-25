-- Follow-up migration: adds the second half of the circular reference between
-- text_segments and audio_segments.
--
-- Reason this is a separate, hand-written migration rather than part of the initial
-- generated one: text_segments.current_audio_segment_id -> audio_segments.id and
-- audio_segments.text_segment_id -> text_segments.id are mutually referencing. Drizzle's
-- schema files cannot express this as a single in-schema `.references()` on
-- current_audio_segment_id without text_segments.ts and audio_segments.ts importing each
-- other, which is not resolvable as TypeScript modules. The column itself was created as
-- a plain nullable uuid in migration 0000; this migration adds the actual foreign key
-- constraint now that both tables exist, which is the standard, documented pattern for
-- expressing a circular FK under a schema-diffing migration tool.
--
-- This satisfies corrections §11 (F / DB-6): "AudioSegment insert always precedes the
-- TextSegment.currentAudioSegmentId update, in one transaction" -- that write order was
-- always going to be required at the application layer regardless of how the constraint
-- itself is expressed in DDL.

DO $$ BEGIN
 ALTER TABLE "text_segments" ADD CONSTRAINT "text_segments_current_audio_segment_id_audio_segments_id_fk" FOREIGN KEY ("current_audio_segment_id") REFERENCES "public"."audio_segments"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
