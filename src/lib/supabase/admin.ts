import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/supabase'

// Lazy, shared service-role client for agent work.
// Bypasses RLS by design: the agent runs in a background job (Trigger.dev)
// or an async webhook callback with no user session, so tenancy is enforced
// application-side by always scoping every query with client_id.
let _adminClient: SupabaseClient<Database> | null = null

export function supabaseAdmin(): SupabaseClient<Database> {
  if (!_adminClient) {
    _adminClient = createClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}