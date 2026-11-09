-- The moderation module's migration (queue and reports), for rejected imports.
-- Moderation: review queue and user reports (final state of platform
-- migrations 0004, 0011 and 0055 for these tables). Idempotent.

-- Shared types: created only when missing (other modules use them too).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'moderation_status') THEN
    CREATE TYPE public.moderation_status AS ENUM ('pending', 'approved', 'rejected');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'report_reason') THEN
    CREATE TYPE public.report_reason AS ENUM ('scam', 'spam', 'fake_company', 'discrimination', 'wrong_info', 'inappropriate', 'other');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'report_status') THEN
    CREATE TYPE public.report_status AS ENUM ('open', 'confirmed', 'dismissed');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.moderation_queue (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    reason text NOT NULL,
    risk_flags jsonb DEFAULT '[]'::jsonb NOT NULL,
    status public.moderation_status DEFAULT 'pending'::public.moderation_status NOT NULL,
    assigned_to uuid,
    decided_by uuid,
    decision_note text,
    decided_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.moderation_queue FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.reports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    reporter_id uuid NOT NULL,
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    reason public.report_reason NOT NULL,
    details text,
    status public.report_status DEFAULT 'open'::public.report_status NOT NULL,
    decided_by uuid,
    decided_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT reports_details_check CHECK ((char_length(details) <= 1000)),
    CONSTRAINT reports_entity_type_check CHECK ((entity_type = ANY (ARRAY['job'::text, 'company'::text, 'user'::text, 'freelance_service'::text, 'freelance_order'::text])))
);

ALTER TABLE ONLY public.reports FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'moderation_queue_pkey') THEN
    ALTER TABLE public.moderation_queue ADD CONSTRAINT moderation_queue_pkey PRIMARY KEY (id);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reports_pkey') THEN
    ALTER TABLE public.reports ADD CONSTRAINT reports_pkey PRIMARY KEY (id);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reports_reporter_id_entity_type_entity_id_key') THEN
    ALTER TABLE public.reports ADD CONSTRAINT reports_reporter_id_entity_type_entity_id_key UNIQUE (reporter_id, entity_type, entity_id);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS moderation_queue_status_idx ON public.moderation_queue USING btree (status, created_at);

CREATE INDEX IF NOT EXISTS reports_entity_open_idx ON public.reports USING btree (entity_type, entity_id) WHERE (status = 'open'::public.report_status);

CREATE INDEX IF NOT EXISTS reports_status_created_idx ON public.reports USING btree (status, created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'moderation_queue_assigned_to_fkey') THEN
    ALTER TABLE public.moderation_queue ADD CONSTRAINT moderation_queue_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'moderation_queue_decided_by_fkey') THEN
    ALTER TABLE public.moderation_queue ADD CONSTRAINT moderation_queue_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reports_decided_by_fkey') THEN
    ALTER TABLE public.reports ADD CONSTRAINT reports_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reports_reporter_id_fkey') THEN
    ALTER TABLE public.reports ADD CONSTRAINT reports_reporter_id_fkey FOREIGN KEY (reporter_id) REFERENCES public.users(id) ON DELETE CASCADE;
  END IF;
END
$$;

ALTER TABLE public.moderation_queue ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'moderation_queue' AND policyname = 'moderation_queue_anon_deny') THEN
    CREATE POLICY moderation_queue_anon_deny ON public.moderation_queue TO anon USING (false) WITH CHECK (false);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'moderation_queue' AND policyname = 'moderation_queue_app_rw_all') THEN
    CREATE POLICY moderation_queue_app_rw_all ON public.moderation_queue TO app_rw USING (true) WITH CHECK (true);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'moderation_queue' AND policyname = 'moderation_queue_authenticated_deny') THEN
    CREATE POLICY moderation_queue_authenticated_deny ON public.moderation_queue TO authenticated USING (false) WITH CHECK (false);
  END IF;
END
$$;

ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'reports' AND policyname = 'reports_anon_deny') THEN
    CREATE POLICY reports_anon_deny ON public.reports TO anon USING (false) WITH CHECK (false);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'reports' AND policyname = 'reports_app_rw_all') THEN
    CREATE POLICY reports_app_rw_all ON public.reports TO app_rw USING (true) WITH CHECK (true);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'reports' AND policyname = 'reports_authenticated_deny') THEN
    CREATE POLICY reports_authenticated_deny ON public.reports TO authenticated USING (false) WITH CHECK (false);
  END IF;
END
$$;
