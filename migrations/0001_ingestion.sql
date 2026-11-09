-- Ingestion: import sources, import runs and the job source links (final
-- state of platform migrations 0007 and 0008 for these tables). Idempotent.

CREATE TABLE IF NOT EXISTS public.import_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_id uuid NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    fetched integer DEFAULT 0 NOT NULL,
    created integer DEFAULT 0 NOT NULL,
    updated integer DEFAULT 0 NOT NULL,
    merged integer DEFAULT 0 NOT NULL,
    rejected integer DEFAULT 0 NOT NULL,
    expired integer DEFAULT 0 NOT NULL,
    error text,
    CONSTRAINT import_runs_created_check CHECK ((created >= 0)),
    CONSTRAINT import_runs_expired_check CHECK ((expired >= 0)),
    CONSTRAINT import_runs_fetched_check CHECK ((fetched >= 0)),
    CONSTRAINT import_runs_merged_check CHECK ((merged >= 0)),
    CONSTRAINT import_runs_rejected_check CHECK ((rejected >= 0)),
    CONSTRAINT import_runs_updated_check CHECK ((updated >= 0))
);

ALTER TABLE ONLY public.import_runs FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.import_sources (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    kind text NOT NULL,
    url text,
    enabled boolean DEFAULT false NOT NULL,
    republish_allowed boolean DEFAULT false NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    last_run_at timestamp with time zone,
    last_status text,
    CONSTRAINT import_sources_kind_check CHECK ((kind = ANY (ARRAY['api'::text, 'rss'::text])))
);

ALTER TABLE ONLY public.import_sources FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.job_sources (
    job_id uuid NOT NULL,
    import_source_id uuid NOT NULL,
    external_id text NOT NULL,
    source_url text NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    is_primary boolean DEFAULT true NOT NULL
);

ALTER TABLE ONLY public.job_sources FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'import_runs_pkey') THEN
    ALTER TABLE public.import_runs ADD CONSTRAINT import_runs_pkey PRIMARY KEY (id);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'import_sources_name_key') THEN
    ALTER TABLE public.import_sources ADD CONSTRAINT import_sources_name_key UNIQUE (name);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'import_sources_pkey') THEN
    ALTER TABLE public.import_sources ADD CONSTRAINT import_sources_pkey PRIMARY KEY (id);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_sources_pkey') THEN
    ALTER TABLE public.job_sources ADD CONSTRAINT job_sources_pkey PRIMARY KEY (import_source_id, external_id);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS import_runs_retention_idx ON public.import_runs USING btree (finished_at) WHERE (finished_at IS NOT NULL);

CREATE INDEX IF NOT EXISTS import_runs_source_started_idx ON public.import_runs USING btree (source_id, started_at DESC);

CREATE INDEX IF NOT EXISTS job_sources_job_idx ON public.job_sources USING btree (job_id);

CREATE UNIQUE INDEX IF NOT EXISTS job_sources_primary_idx ON public.job_sources USING btree (job_id) WHERE is_primary;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'import_runs_source_id_fkey') THEN
    ALTER TABLE public.import_runs ADD CONSTRAINT import_runs_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.import_sources(id) ON DELETE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_sources_import_source_id_fkey') THEN
    ALTER TABLE public.job_sources ADD CONSTRAINT job_sources_import_source_id_fkey FOREIGN KEY (import_source_id) REFERENCES public.import_sources(id) ON DELETE RESTRICT;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_sources_job_id_fkey') THEN
    ALTER TABLE public.job_sources ADD CONSTRAINT job_sources_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;
  END IF;
END
$$;

ALTER TABLE public.import_runs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'import_runs' AND policyname = 'import_runs_anon_deny') THEN
    CREATE POLICY import_runs_anon_deny ON public.import_runs TO anon USING (false) WITH CHECK (false);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'import_runs' AND policyname = 'import_runs_app_rw_all') THEN
    CREATE POLICY import_runs_app_rw_all ON public.import_runs TO app_rw USING (true) WITH CHECK (true);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'import_runs' AND policyname = 'import_runs_authenticated_deny') THEN
    CREATE POLICY import_runs_authenticated_deny ON public.import_runs TO authenticated USING (false) WITH CHECK (false);
  END IF;
END
$$;

ALTER TABLE public.import_sources ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'import_sources' AND policyname = 'import_sources_anon_deny') THEN
    CREATE POLICY import_sources_anon_deny ON public.import_sources TO anon USING (false) WITH CHECK (false);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'import_sources' AND policyname = 'import_sources_app_rw_all') THEN
    CREATE POLICY import_sources_app_rw_all ON public.import_sources TO app_rw USING (true) WITH CHECK (true);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'import_sources' AND policyname = 'import_sources_authenticated_deny') THEN
    CREATE POLICY import_sources_authenticated_deny ON public.import_sources TO authenticated USING (false) WITH CHECK (false);
  END IF;
END
$$;

ALTER TABLE public.job_sources ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'job_sources' AND policyname = 'job_sources_anon_deny') THEN
    CREATE POLICY job_sources_anon_deny ON public.job_sources TO anon USING (false) WITH CHECK (false);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'job_sources' AND policyname = 'job_sources_app_rw_all') THEN
    CREATE POLICY job_sources_app_rw_all ON public.job_sources TO app_rw USING (true) WITH CHECK (true);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'job_sources' AND policyname = 'job_sources_authenticated_deny') THEN
    CREATE POLICY job_sources_authenticated_deny ON public.job_sources TO authenticated USING (false) WITH CHECK (false);
  END IF;
END
$$;

-- Table rights for the app role, as on the platform.
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.import_runs TO app_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.import_sources TO app_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.job_sources TO app_rw;
