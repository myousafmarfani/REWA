-- touch_presence no-op stub.
--
-- The retired wacrm baseline (migrations 001-039, now in
-- supabase/migrations/_wacrm_retired/) defined a touch_presence RPC backed
-- by the member_presence table. rewa does not use presence, but
-- src/components/presence/presence-heartbeat.tsx still calls
-- public.touch_presence(p_status) on an interval, so the call fails on every
-- heartbeat and spams the browser console. This stub keeps the call a
-- successful no-op until the heartbeat component is retired with the rest of
-- the dead wacrm UI (see MEMORY.md entry 19).

CREATE OR REPLACE FUNCTION public.touch_presence(p_status text DEFAULT 'online')
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- no-op stub: presence is not used in rewa (see MEMORY.md entry 19)
  RETURN;
END;
$$;

GRANT EXECUTE ON FUNCTION public.touch_presence(text) TO authenticated;
