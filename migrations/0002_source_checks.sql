-- Last liveness check per job source: when it ran, what it found and a short
-- note (HTTP status or reason). Idempotent.

ALTER TABLE public.job_sources ADD COLUMN IF NOT EXISTS last_checked_at timestamp with time zone;
ALTER TABLE public.job_sources ADD COLUMN IF NOT EXISTS last_check_result text;
ALTER TABLE public.job_sources ADD COLUMN IF NOT EXISTS last_check_note text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_sources_last_check_result_check') THEN
    ALTER TABLE public.job_sources ADD CONSTRAINT job_sources_last_check_result_check
      CHECK (last_check_result IS NULL OR last_check_result IN ('live', 'closed', 'unknown'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_sources_last_check_note_check') THEN
    ALTER TABLE public.job_sources ADD CONSTRAINT job_sources_last_check_note_check
      CHECK (last_check_note IS NULL OR char_length(last_check_note) <= 200);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS job_sources_check_due_idx ON public.job_sources USING btree (last_checked_at NULLS FIRST);
