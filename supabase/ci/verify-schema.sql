-- Post-migration assertions for the CI job in
-- `.github/workflows/migrations.yml`.
--
-- `supabase db reset` already fails on any statement Postgres rejects,
-- so this is not about syntax. It's about the quieter failure: a
-- migration that applies cleanly and does nothing. Every DDL statement
-- in this repo is guarded with IF NOT EXISTS / ON CONFLICT so the files
-- can be re-run safely, and that same guard turns a typo'd object name
-- into a silent no-op with a green checkmark.
--
-- Keep this thin. It is a smoke test for "did the migrations actually
-- build the rewa schema", not a spec of it — asserting every column here
-- would just be the migrations restated in a second place, drifting.
--
-- MEMORY entry 19: the wacrm baseline (001–039) was retired to
-- supabase/migrations/_wacrm_retired/ and is NOT replayed. The five rewa
-- migrations are the authoritative chain, so assert rewa objects only —
-- no whatsapp_config / accounts / broadcasts / flows / automations /
-- deals / chat-media / flow-media.
DO $$
DECLARE
  missing text[] := ARRAY[]::text[];
  t text;
BEGIN
  -- Every rewa table. A missing entry means the migration that creates
  -- it either did not run or silently no-op'd on a typo.
  FOREACH t IN ARRAY ARRAY[
    'clients',
    'client_config',
    'users',
    'contacts',
    'campaigns',
    'message_templates',
    'campaign_contacts',
    'conversations',
    'messages',
    'lead_score_history',
    'property_embeddings',
    'contact_imports',
    'push_subscriptions'
  ]
  LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      missing := missing || t;
    END IF;
  END LOOP;

  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION 'missing rewa table(s): % — migrations did not apply', array_to_string(missing, ', ');
  END IF;

  -- The pgvector retrieval RPC the agent depends on for grounded facts
  -- (MEMORY entry 8).
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'match_property_embeddings'
      AND pronamespace = 'public'::regnamespace
  ) THEN
    RAISE EXCEPTION 'function match_property_embeddings is missing — migrations did not apply';
  END IF;

  -- Supabase provides the storage schema; the scoring migration writes
  -- to it. If it is absent the bucket migration silently accomplishes
  -- nothing, which is precisely the case a plain "no errors" run hides.
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE EXCEPTION
      'storage.buckets is missing — the storage schema was not available when the bucket migration ran';
  END IF;

  -- Buckets are UPSERTed, so their absence means the INSERT never ran.
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'contacts-exports') THEN
    RAISE EXCEPTION 'the contacts-exports bucket row was not created (scoring spec 5)';
  END IF;

  RAISE NOTICE 'rewa schema verification passed';
END
$$;

-- Two things this file has already been burned by, both verified in CI
-- rather than assumed:
--
-- 1. It must contain EXACTLY ONE statement. `supabase db query --file`
--    sends the whole file as a prepared statement, and a second
--    top-level statement fails with the distinctly unhelpful "cannot
--    insert multiple commands into a prepared statement" (commit
--    f91a6c8). Add assertions INSIDE the DO block above; do not append
--    a second one.
--
-- 2. A RAISE in here really does fail the job. A deliberately false
--    assertion (commit 42c7db0, run 31579334056) surfaced as
--    `failed to execute query: error: ...` and exited 1. This is not a
--    decorative green tick.
