import { supabaseAdmin } from '@/lib/supabase/admin'

export interface GateResult {
  blocked: boolean
  reason: 'human_controlled' | 'opted_out' | 'window_closed' | null
}

const WINDOW_HOURS = 24

/**
 * Hard stops before any agent processing. Order matters and is
 * non-negotiable (MEMORY entry 11): human_controlled first, then
 * opted_out, then the 24-hour window.
 *
 * The window is derived from last_inbound_at — there is no
 * wa_window_open column (Spec 1 A5). The webhook route writes
 * last_inbound_at = now() when it persists the inbound message, so a
 * fresh inbound always reports an open window here. A task that runs
 * stale (exhausted retries, manual replay) will see the window state
 * as of its read-time, which is the correct compliant behaviour.
 */
export async function runGateChecks(
  contactId: string,
  clientId: string,
): Promise<GateResult> {
  const { data: contact, error } = await supabaseAdmin()
    .from('contacts')
    .select('human_controlled, opted_out, last_inbound_at')
    .eq('id', contactId)
    .eq('client_id', clientId)
    .maybeSingle()

  if (error) {
    console.error('[agent:gates] failed to load contact', {
      contactId,
      clientId,
      error: error.message,
    })
    return { blocked: true, reason: null }
  }

  if (!contact) {
    // Contact vanished between the webhook and the task. Never respond
    // to a contact we can't verify.
    console.error('[agent:gates] contact not found', { contactId, clientId })
    return { blocked: true, reason: null }
  }

  // Gate 1 — human_controlled (ALWAYS CHECKED FIRST, MEMORY 11).
  if (contact.human_controlled) {
    return { blocked: true, reason: 'human_controlled' }
  }

  // Gate 2 — opted_out.
  if (contact.opted_out) {
    return { blocked: true, reason: 'opted_out' }
  }

  // Gate 3 — 24-hour window, derived from last_inbound_at.
  if (contact.last_inbound_at) {
    const windowStart = new Date(
      Date.now() - WINDOW_HOURS * 60 * 60 * 1000,
    )
    if (new Date(contact.last_inbound_at) < windowStart) {
      return { blocked: true, reason: 'window_closed' }
    }
  }

  return { blocked: false, reason: null }
}