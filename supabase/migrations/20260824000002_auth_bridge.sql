-- ============================================================
-- Signup bootstrap: auth.users → public.users
--
-- Spec 1 (data-model-spec) replaced wacrm's `profiles` / `accounts`
-- schema with rewa's `users` / `clients` model. This migration used to
-- also create `profiles` / `accounts` compatibility VIEWS so the
-- un-ported wacrm shell could boot. Spec 6 (pipeline-ui-spec, Layer B)
-- ports the auth layer to `public.users` + `public.clients`, so those
-- views (and their INSTEAD OF write shims) have been removed.
-- `20260923000000_drop_auth_bridge_views.sql` drops them from
-- environments where this migration was already applied.
--
-- The handle_new_user trigger remains: it is still the ONLY bootstrap
-- that creates a public.users row when a Supabase Auth user is created.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.users (id, client_id, full_name, email, role)
  VALUES (
    NEW.id,
    '00000000-0000-0000-0000-000000000001',  -- dev client seed
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    NEW.email,
    'owner'                                  -- first user is owner
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================================
-- Dev auth user (run ONCE, manually)
--
--   Prefer the Supabase Auth Admin API — a raw INSERT INTO
--   auth.users skips Gotrue invariants (aud/role/instance_id) and
--   the account ends up unable to sign in (invalid_credentials).
--
--   WITH YOUR SERVICE_ROLE KEY:
--
--   curl -X POST '<project>/auth/v1/admin/users' \
--     -H 'apikey: <SERVICE_ROLE>' \
--     -H 'Authorization: Bearer <SERVICE_ROLE>' \
--     -H 'Content-Type: application/json' \
--     -d '{
--       "email": "dev@rewa.local",
--       "password": "devpassword123",
--       "email_confirm": true,
--       "user_metadata": { "full_name": "Dev User" }
--     }'
--
--   The AFTER INSERT trigger above creates the matching public.users
--   row (role 'owner', dev client_id).
-- ============================================================
