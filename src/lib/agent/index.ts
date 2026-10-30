import { runGateChecks } from './gates';
import { loadHistory, buildRetrievalQuery } from './history';
import { retrievePropertyContext } from './retrieval';
import { runGuardrails } from './guardrails';
import { generateAgentResponse } from './generate';
import {
  persistInboundMessage,
  persistAgentResponse,
  ensureConversation,
} from './persist';
import { updateLeadScore } from '@/lib/scoring';
import { sendWhatsAppMessage } from '@/lib/sending';
import { isOptOut } from '@/lib/compliance/opt-out';
import { supabaseAdmin } from '@/lib/supabase/admin';
import type { Database } from '@/types/supabase';

export interface ProcessInboundParams {
  clientId: string;
  contactId: string;
  inboundMessage: string;
  waMessageId: string | null;
  waTimestamp: Date;
  /**
   * Row id of the inbound message the webhook already persisted —
   * carried through the task payload so an agent-classified unsubscribe
   * can record contacts.opt_out_message_id (same column the webhook
   * keyword path sets). Optional: absent on manual replays.
   */
  inboundMessageRowId?: string | null;
}

/**
 * Autonomous agent entry point. Runs from a Trigger.dev background task
 * (never from the webhook response path). Follows the exact step order
 * from spec 3 / MEMORY entry 8: gates → history → retrieval → guardrails
 * → generate → persist → score → send. Hot-lead escalation (spec 5) is
 * fired from inside updateLeadScore() on the cold/warm → hot edge, so
 * there is no separate STEP 10 body.
 *
 * The inbound message is ALREADY persisted by the webhook route before
 * this task runs — so a message blocked by human_controlled or
 * opted_out is still recorded. Step 6 re-runs the insert only as an
 * idempotent backstop for manual task replays; on the normal webhook
 * path it hits the unique wa_message_id index and changes nothing.
 */
export async function processInboundMessage(
  params: ProcessInboundParams
): Promise<void> {
  const {
    clientId,
    contactId,
    inboundMessage,
    waMessageId,
    waTimestamp,
    inboundMessageRowId,
  } = params;

  // STEP 1: Gate checks (gates.ts) — hard stops, no agent processing.
  const gates = await runGateChecks(contactId, clientId);
  if (gates.blocked) {
    console.log('[agent] blocked by gate', {
      clientId,
      contactId,
      reason: gates.reason,
    });
    return;
  }

  // Load persona config for this client (used in steps 4, 5, 7).
  const config = await loadClientConfig(clientId);
  if (!config) {
    console.error('[agent] no client config', { clientId });
    return;
  }

  // STEP 1.5 (compliance): deterministic opt-out short-circuit.
  //
  // A machine-checkable unsubscribe ("STOP", "unsubscribe", "do not
  // message me", …) must stop ALL outbound immediately. Relying on the
  // LLM intent classification at STEP 8 is not enough: guardrails
  // (STEP 4) run FIRST and can misread a terse opt-out as a scope
  // violation, sending a fallback reply — i.e. messaging someone who
  // just asked us to stop. So the deterministic patterns are checked
  // here, before guardrails can fire, and on a match we mark the contact
  // opted out and return WITHOUT generating or sending any reply (no
  // fallback, no confirmation — outreach-compliance: stop responding).
  //
  // The contact is not yet opted_out here (otherwise gates.ts would have
  // blocked us), so this is the first hop that honours a bare keyword.
  if (isOptOut(inboundMessage)) {
    await markContactOptedOut({
      clientId,
      contactId,
      inboundMessageRowId: inboundMessageRowId ?? null,
    });
    console.log('[agent] deterministic opt-out — no reply sent', {
      clientId,
      contactId,
    });
    return;
  }

  // STEP 2: Load conversation history (history.ts).
  const conversationId =
    (await ensureConversation(clientId, contactId)) ?? undefined;
  if (!conversationId) {
    console.error('[agent] failed to resolve conversation', {
      clientId,
      contactId,
    });
    return;
  }
  const history = await loadHistory(conversationId, clientId);

  // STEP 3: pgvector retrieval (retrieval.ts).
  const retrievalQuery = buildRetrievalQuery(inboundMessage, history);
  const retrievedContext = await retrievePropertyContext({
    clientId,
    query: retrievalQuery,
  });

  // STEP 4: Guardrails pre-check (guardrails.ts).
  const persona = {
    personaName: config.agent_persona_name,
    brandName: config.client_brand_name,
    agentTone: config.agent_tone,
  };
  const guardrails = await runGuardrails({
    inboundMessage,
    conversationHistory: history,
    ...persona,
  });

  if (!guardrails.pass) {
    const fallbackOutput = {
      message: guardrails.fallback_response,
      lead_score: 'cold' as const,
      intent_type: 'browsing' as const,
      signals: {
        mentioned_budget: false,
        mentioned_timeline: false,
        requested_visit: false,
        requested_pricing: false,
        negotiating: false,
        asked_for_contract: false,
      },
      suggested_stage: 'new_lead' as const,
      needs_follow_up: false,
      follow_up_reason: null,
    };

    // Persist the fallback reply WITHOUT touching the contact's lead
    // state — scoring (STEP 8) never runs on a blocked exchange, so a
    // warm/hot lead answering one off-scope message keeps its score.
    // The verdict is recorded on the message row via agent_signals.
    const fallbackMessageId = await persistAgentResponse({
      clientId,
      contactId,
      conversationId,
      output: fallbackOutput,
      guardrailVerdict: guardrails.category,
    });
    if (fallbackMessageId) {
      await sendPersistedReply({
        clientId,
        contactId,
        messageId: fallbackMessageId,
        body: fallbackOutput.message,
      });
    }
    return;
  }

  // STEP 5: Generate response (generate.ts).
  let output;
  try {
    output = await generateAgentResponse({
      personaName: config.agent_persona_name,
      agentTone: config.agent_tone,
      agentLanguage: config.agent_language,
      agentSignOff: config.agent_sign_off,
      brandName: config.client_brand_name,
      escalationPhrase: config.escalation_phrase,
      history,
      retrievedContext,
      inboundMessage,
    });
  } catch (error) {
    console.error('[agent] generation failed', {
      clientId,
      contactId,
      error: error instanceof Error ? error.message : error,
    });
    return;
  }

  // STEP 6: Persist inbound message — ALREADY persisted by the webhook
  // route before enqueue. Re-called here only as an idempotent
  // backstop (duplicates are ignored via the unique wa_message_id
  // index); it always reports the same conversation. The returned row
  // id is a fallback for opt_out_message_id when the task payload did
  // not carry one.
  const backstopRowId = await persistInboundMessage({
    clientId,
    contactId,
    conversationId,
    body: inboundMessage,
    waMessageId,
    waTimestamp,
  });

  // STEP 7: Persist agent response (persist.ts). On an unsubscribe the
  // reply is recorded as 'failed' from the start — it will never be
  // sent (compliance: stop responding immediately), but the row stays
  // as the audit trail and is never handed to the sending layer.
  const isUnsubscribe = output.intent_type === 'unsubscribed';
  const responseMessageId = await persistAgentResponse({
    clientId,
    contactId,
    conversationId,
    output,
    failed: isUnsubscribe,
  });
  if (!responseMessageId) {
    console.error('[agent] failed to persist agent response', {
      clientId,
      contactId,
    });
    return;
  }

  // STEP 8: Update lead score (scoring/index.ts updateLeadScore). The
  // ONLY writer of contacts.lead_score from the agent path: computes
  // the score from intent + signals, applies the monotonic rule (with
  // the lost/unsubscribed carve-out), advances the pipeline stage
  // forward-only, appends lead_score_history, flags opted_out on an
  // agent-classified unsubscribe, and fires hot-lead escalation on the
  // cold/warm → hot edge (spec 5).
  const scoreResult = await updateLeadScore({
    clientId,
    contactId,
    messageId: responseMessageId,
    optOutMessageId: inboundMessageRowId ?? backstopRowId,
    agentOutput: output,
  });

  // STEP 9: Send via WhatsApp (sending-spec). The orchestrator enforces
  // the opted-out hard gate and the 24-hour window (free-form text is
  // only sent inside the window — assertWindowOpen), acquires the
  // per-phone-number rate-limit slot, and on success flips this
  // outbound row from 'pending' → 'sent' with the Meta message id
  // (persist.ts handoff contract). On failure it marks the row 'failed';
  // on a blocked recipient it records the opt-out itself.
  //
  // An exchange that just opted the contact out is skipped here rather
  // than fed to the hard gate: nothing may go out, not even a
  // confirmation (outreach-compliance skill — stop responding
  // immediately). The row is already 'failed', so no 'pending' phantom
  // is left behind. scoreResult.optedOut implies the same intent, but
  // the check keys off the classification itself so it still holds if
  // the scoring read errored (scoreResult === null).
  if (isUnsubscribe || scoreResult?.optedOut) {
    console.log('[agent] unsubscribe intent — send skipped', {
      clientId,
      contactId,
      messageId: responseMessageId,
    });
    return;
  }

  await sendPersistedReply({
    clientId,
    contactId,
    messageId: responseMessageId,
    body: output.message,
  });

  // STEP 10: Hot lead escalation — owned by spec 5. It fires inside
  // updateLeadScore() (STEP 8) on the cold/warm → hot edge, BEFORE the
  // WhatsApp send: the human agent hears about the hot lead even if the
  // outbound reply then hits a closed window or rate limit.
}

/**
 * STEP 9 helper — hand the persisted outbound row to the sending
 * orchestrator. All state transitions (pending → sent/failed, contact
 * opted_out reconciliation, last_contacted_at) are owned by the sending
 * layer; the agent only logs the outcome.
 */
async function sendPersistedReply(params: {
  clientId: string;
  contactId: string;
  messageId: string;
  body: string;
}): Promise<void> {
  try {
    await sendWhatsAppMessage({
      clientId: params.clientId,
      contactId: params.contactId,
      messageBody: params.body,
      messageType: 'agent_response',
      messageId: params.messageId,
    });
  } catch (error) {
    console.error('[agent] outbound send failed', {
      clientId: params.clientId,
      contactId: params.contactId,
      messageId: params.messageId,
      errorType: error instanceof Error ? error.name : 'unknown',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Deterministic opt-out writer (STEP 1.5).
 *
 * Mirrors the opt-out columns scoring's updateLeadScore sets on an
 * agent-classified unsubscribe (opted_out / opted_out_at /
 * opted_out_source='contact_reply' / opt_out_message_id). It does NOT
 * touch lead_score or pipeline_stage — those stay owned by scoring, and
 * on an opt-out the monotonic carve-out leaves them unchanged anyway.
 * Idempotent: re-running only re-stamps the same terminal state.
 */
async function markContactOptedOut(params: {
  clientId: string;
  contactId: string;
  inboundMessageRowId: string | null;
}): Promise<void> {
  const update: Database['public']['Tables']['contacts']['Update'] = {
    opted_out: true,
    opted_out_at: new Date().toISOString(),
    opted_out_source: 'contact_reply',
    updated_at: new Date().toISOString(),
  };
  // Audit symmetry with the webhook keyword path (route.ts writes the
  // same column) — only when we actually have the inbound row id.
  if (params.inboundMessageRowId) {
    update.opt_out_message_id = params.inboundMessageRowId;
  }

  const { error } = await supabaseAdmin()
    .from('contacts')
    .update(update)
    .eq('client_id', params.clientId)
    .eq('id', params.contactId);

  if (error) {
    console.error('[agent] deterministic opt-out write failed', {
      clientId: params.clientId,
      contactId: params.contactId,
      error: error.message,
    });
  }
}

async function loadClientConfig(clientId: string) {
  const { data, error } = await supabaseAdmin()
    .from('client_config')
    .select(
      'agent_persona_name, agent_tone, agent_language, agent_sign_off, client_brand_name, escalation_phrase'
    )
    .eq('client_id', clientId)
    .maybeSingle();

  if (error || !data) {
    console.error('[agent] client config load failed', {
      clientId,
      error: error?.message,
    });
    return null;
  }

  return data;
}

export { ensureConversation };
