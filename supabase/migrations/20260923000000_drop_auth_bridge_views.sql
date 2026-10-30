-- ============================================================
-- Spec 6 (pipeline-ui-spec), Layer B: retire the wacrm auth bridge.
--
-- 20260824000002_auth_bridge.sql originally created `public.profiles`
-- and `public.accounts` as security_invoker VIEWS over rewa's
-- `users` / `clients` tables, plus INSTEAD OF UPDATE shims, so the
-- un-ported wacrm shell could boot. Spec 6 ported the UI auth layer to
-- query `public.users` + `public.clients` directly, so the views and
-- their shims are dead weight.
--
-- The auth-bridge migration file itself no longer creates them, so on a
-- cold replay this migration is a no-op. It exists to remove the objects
-- from any environment (e.g. the shared remote) where the original
-- bridge migration was already applied.
--
-- handle_new_user() is NOT dropped — it is still the signup bootstrap
-- that creates public.users rows.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- Drop the INSTEAD OF triggers before their functions and the views.
DO $$
BEGIN
  -- Remove accounts trigger only when the relation exists.
  IF to_regclass('public.accounts') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS accounts_update_shim ON public.accounts';
  END IF;

  -- Remove profiles trigger only when the relation exists.
  IF to_regclass('public.profiles') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS profiles_update_shim ON public.profiles';
  END IF;
END
$$;

DROP FUNCTION IF EXISTS public.accounts_update_shim();
DROP FUNCTION IF EXISTS public.profiles_update_shim();

DROP VIEW IF EXISTS public.profiles CASCADE;
DROP VIEW IF EXISTS public.accounts CASCADE;
