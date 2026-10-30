import { supabaseAdmin } from '@/lib/supabase/admin';
import type { AgentOutput } from './types';
import type { Json } from '@/types/supabase';

/**
 * Shared persistence for the agent pipeline. NOTE: this module NEVER
 * writes last_inbound_at — the webhook route is the only writer of that
 * column (compliance gate finding), so an inbound that arrives while
 * human_controlled/opted_out is still recorded and the window state is
 * always derived from the raw event, never from agent processing.
 */

interface InboundMessageParams {
  clientId: string;
  contactId: string;
  conversationId: string;
  body: string;
  waMessageId: string | null;
  waTimestamp: Date;
}

/**
 * Idempotent insert of a contact's inbound message. The unique index on
 * (client_id, wa_message_id) backstops webhook duplicates / Meta retries.
 */
export async function persistInboundMessage(
  params: InboundMessageParams
): Promise<string | null> {
  const row = {
    client_id: params.clientId,
    contact_id: params.contactId,
    conversation_id: params.conversationId,
    direction: 'inbound',
    sender_type: 'contact',
    body: params.body,
    wa_message_id: params.waMessageId,
    wa_timestamp: params.waTimestamp.toISOString(),
    status: 'sent',
  };

  const insert = params.waMessageId
    ? supabaseAdmin().from('messages').upsert(row, {
        onConflict: 'client_id,wa_message_id',
        ignoreDuplicates: true,
      })
    : supabaseAdmin().from('messages').insert(row);

  const { data, error } = await insert.select('id').maybeSingle();

  if (error) {
    console.error('[agent:persist] inbound insert failed', {
      clientId: params.clientId,
      contactId: params.contactId,
      error: error.message,
    });
    return null;
  }
  return data?.id ?? null;
}

interface AgentResponseParams {
  clientId: string;
  contactId: string;
  conversationId: string;
  output: AgentOutput;
  failed?: boolean;
  /** When set, the guardrail verdict is recorded on the message row via
   *  agent_signals so fallback replies are distinguishable from genuine
   *  cold/browsing output (spec 1: guardrail verdicts live in
   *  agent_signals). */
  guardrailVerdict?: string;
}

/**
 * Persist the generated agent reply plus all AgentOutput metadata, then
 * update the conversation preview. The actual WhatsApp send is owned by
 * sending-spec (STEP 9); rows are stored with status 'pending' until the
 * sending layer moves them.
 *
 * NOTE: this module never writes contacts — no lead_score, no
 * pipeline_stage. Score ownership moved to scoring/index.ts
 * (updateLeadScore, spec 5) so the monotonic rule, the terminal-intent
 * carve-out, history, and escalation live in exactly one place. A
 * guardrail-fallback exchange simply never reaches that step.
 */
export async function persistAgentResponse(
  params: AgentResponseParams
): Promise<string | null> {
  const {
    clientId,
    contactId,
    conversationId,
    output,
    failed = false,
  } = params;

  const agentSignals: Record<string, unknown> = {
    ...output.signals,
    ...(params.guardrailVerdict
      ? { guardrail_fired: true, guardrail_category: params.guardrailVerdict }
      : {}),
  };

  const { data, error } = await supabaseAdmin()
    .from('messages')
    .insert({
      client_id: clientId,
      contact_id: contactId,
      conversation_id: conversationId,
      direction: 'outbound',
      sender_type: 'agent',
      body: output.message,
      status: failed ? 'failed' : 'pending',
      agent_lead_score: output.lead_score,
      agent_intent_type: output.intent_type,
      agent_signals: agentSignals as unknown as Json,
      agent_suggested_stage: output.suggested_stage,
      agent_needs_follow_up: output.needs_follow_up,
      agent_follow_up_reason: output.follow_up_reason,
    })
    .select('id')
    .single();

  if (error || !data) {
    console.error('[agent:persist] agent response insert failed', {
      clientId,
      contactId,
      error: error?.message,
    });
    return null;
  }

  // A suppressed reply (unsubscribe — compliance: never delivered) must
  // not move the conversation preview forward as if the contact just
  // heard from us; the webhook's liveness update already recorded their
  // inbound message as the latest state. status='open' also stays put —
  // the contact opted out, they are not awaiting our answer.
  if (!failed) {
    await updateConversationAfterExchange(
      conversationId,
      clientId,
      output.message
    );
  }

  return data.id;
}

interface HumanResponseParams {
  clientId: string;
  contactId: string;
  conversationId: string;
  body: string;
}

/**
 * Persist a human-led outbound reply (dashboard takeover).
 *
 * Mirrors the agent path: the row is written first with sender_type
 * 'human' and status 'pending', then the sending-spec layer flips it to
 * 'sent'/'failed' using the returned id (the dashboard relies on the
 * realtime row to render the reply). Unlike a suppressed agent reply, a
 * human reply IS delivered, so it also advances the conversation preview.
 */
export async function persistHumanResponse(
  params: HumanResponseParams
): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from('messages')
    .insert({
      client_id: params.clientId,
      contact_id: params.contactId,
      conversation_id: params.conversationId,
      direction: 'outbound',
      sender_type: 'human',
      body: params.body,
      status: 'pending',
    })
    .select('id')
    .single();

  if (error || !data) {
    console.error('[agent:persist] human response insert failed', {
      clientId: params.clientId,
      contactId: params.contactId,
      error: error?.message,
    });
    return null;
  }

  await updateConversationAfterExchange(
    params.conversationId,
    params.clientId,
    params.body
  );
  return data.id;
}

async function updateConversationAfterExchange(
  conversationId: string,
  clientId: string,
  preview: string
): Promise<void> {
  const { error } = await supabaseAdmin()
    .from('conversations')
    .update({
      last_message_at: new Date().toISOString(),
      last_message_preview: preview.slice(0, 200),
      status: 'open',
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId)
    .eq('client_id', clientId);

  if (error) {
    console.error('[agent:persist] conversation update failed', {
      conversationId,
      error: error.message,
    });
  }
}

/**
 * Find the single conversation for a client+contact (unique constraint
 * client_id, contact_id), creating it if absent. If an existing row is
 * racing us, the unique index makes the insert a no-op and we re-select.
 */
export async function ensureConversation(
  clientId: string,
  contactId: string
): Promise<string | null> {
  const { data: existing } = await supabaseAdmin()
    .from('conversations')
    .select('id')
    .eq('client_id', clientId)
    .eq('contact_id', contactId)
    .maybeSingle();

  if (existing) return existing.id;

  const { data: created, error } = await supabaseAdmin()
    .from('conversations')
    .insert({
      client_id: clientId,
      contact_id: contactId,
      status: 'open',
      unread_count: 0,
    })
    .select('id')
    .maybeSingle();

  if (created) return created.id;

  if (error) {
    console.error('[agent:persist] conversation ensure failed', {
      clientId,
      contactId,
      error: error.message,
    });
  }

  // Likely a race on the unique index — re-select once.
  const { data: retry } = await supabaseAdmin()
    .from('conversations')
    .select('id')
    .eq('client_id', clientId)
    .eq('contact_id', contactId)
    .maybeSingle();

  return retry?.id ?? null;
}
