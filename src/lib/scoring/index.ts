import { supabaseAdmin } from '@/lib/supabase/admin';
import type { Database } from '@/types/supabase';
import type { IntentType, LeadScore, PipelineStage } from '../agent/types';
import { computeLeadScore, resolveScoreUpdate } from './scorer';
import { triggerEscalation } from './escalation';
import {
  isTerminalIntent,
  PIPELINE_STAGE_ORDER,
  type ScoreUpdateResult,
  type UpdateLeadScoreParams,
} from './types';

export { triggerEscalation } from './escalation';
export { computeLeadScore, resolveScoreUpdate } from './scorer';

const KNOWN_SCORES: readonly string[] = ['cold', 'warm', 'hot'];

/**
 * Persist the score for one agent exchange (spec 5 index.ts), then
 * escalate if the contact just went hot.
 *
 * Order is deliberate:
 *   1. read current score/stage/consent (the diff baseline),
 *   2. compute + resolve (scorer.ts — monotonic, terminal carve-out),
 *   3. advance the pipeline stage (forward-only; terminal intents leave
 *      it alone — a lost contact must not be marched forward),
 *   4. write contacts + append-only lead_score_history, flagging
 *      opted_out on an agent-classified unsubscribe (compliance),
 *   5. fire triggerEscalation() on the cold/warm → hot edge only.
 *
 * This is the ONLY writer of contacts.lead_score from the agent path —
 * persist.ts no longer touches it (spec 5 separation: persistence stores
 * the exchange, scoring owns the score).
 */
export async function updateLeadScore(
  params: UpdateLeadScoreParams
): Promise<ScoreUpdateResult | null> {
  const { clientId, contactId, agentOutput } = params;

  const { data: contact, error } = await supabaseAdmin()
    .from('contacts')
    .select('lead_score, pipeline_stage, opted_out')
    .eq('client_id', clientId)
    .eq('id', contactId)
    .maybeSingle();

  if (error || !contact) {
    console.error('[scoring] contact read failed', {
      clientId,
      contactId,
      error: error?.message,
    });
    return null;
  }

  const previousScore = normalizeScore(contact.lead_score);
  const computed = computeLeadScore(
    agentOutput.intent_type,
    agentOutput.signals
  );
  const newScore = resolveScoreUpdate(
    previousScore,
    computed,
    agentOutput.intent_type
  );
  const newStage = resolvePipelineStage({
    currentStage: contact.pipeline_stage,
    suggestedStage: agentOutput.suggested_stage,
    intentType: agentOutput.intent_type,
  });

  const scoreChanged =
    newScore !== previousScore ||
    !KNOWN_SCORES.includes(contact.lead_score ?? ''); // corrupt/legacy value → write the correction
  const stageChanged = newStage !== contact.pipeline_stage;
  const newlyHot = newScore === 'hot' && previousScore !== 'hot';
  const leftHot = previousScore === 'hot' && newScore !== 'hot';
  // Compliance (outreach-compliance skill): an unsubscribe the webhook
  // regex missed still has to be honoured — the agent's 'unsubscribed'
  // classification is the "equivalent" opt-out path. gates.ts blocks
  // every subsequent exchange from here on.
  const newlyOptedOut =
    agentOutput.intent_type === 'unsubscribed' && !contact.opted_out;

  if (scoreChanged || stageChanged || newlyOptedOut) {
    const update: Database['public']['Tables']['contacts']['Update'] = {
      lead_score: newScore,
      pipeline_stage: newStage,
      updated_at: new Date().toISOString(),
    };
    if (newlyHot) update.hot_flagged_at = new Date().toISOString();
    // hot_flagged_at is a CURRENT-state column (symmetric with the set
    // above): clearing it on a downgrade keeps the export's star column
    // from advertising a lead that is no longer hot. The transition
    // itself stays auditable in lead_score_history.
    if (leftHot) update.hot_flagged_at = null;
    if (newlyOptedOut) {
      update.opted_out = true;
      update.opted_out_at = new Date().toISOString();
      update.opted_out_source = 'contact_reply';
      // Audit symmetry with the webhook keyword path (route.ts sets the
      // same column to the inbound row). Skipped when the caller could
      // not supply the row id — never written with a wrong id.
      if (params.optOutMessageId) {
        update.opt_out_message_id = params.optOutMessageId;
      }
    }

    const { error: updateError } = await supabaseAdmin()
      .from('contacts')
      .update(update)
      .eq('client_id', clientId)
      .eq('id', contactId);

    if (updateError) {
      console.error('[scoring] contact update failed', {
        clientId,
        contactId,
        error: updateError.message,
      });
      return null;
    }
  }

  if (scoreChanged) {
    await recordScoreChange({
      clientId,
      contactId,
      // Raw previous value (not the normalized one): when a corrupt
      // score triggered the correction, history must show what was
      // actually stored, not the 'cold' we collapsed it to.
      previousScore: contact.lead_score ?? null,
      newScore,
      messageId: params.messageId,
      reason: `agent: intent=${agentOutput.intent_type}`,
    });
  }

  if (newlyHot) {
    await triggerEscalation({
      clientId,
      contactId,
      lastMessage: agentOutput.message,
    });
  }

  return {
    previousScore,
    newScore,
    scoreChanged,
    newlyHot,
    stageChanged,
    pipelineStage: newStage,
    optedOut: newlyOptedOut,
  };
}

/**
 * Append a row to lead_score_history (spec 1 — append-only audit).
 * Shared by the agent path (updateLeadScore) and the human override
 * route (POST /api/contacts/[id]/score, reason = 'manual').
 */
export async function recordScoreChange(params: {
  clientId: string;
  contactId: string;
  previousScore: string | null;
  newScore: string;
  messageId?: string | null;
  reason: string;
}): Promise<void> {
  if (params.previousScore === params.newScore) return;

  const { error } = await supabaseAdmin()
    .from('lead_score_history')
    .insert({
      client_id: params.clientId,
      contact_id: params.contactId,
      previous_score: params.previousScore,
      new_score: params.newScore,
      message_id: params.messageId ?? null,
      reason: params.reason,
    });

  if (error) {
    console.error('[scoring] lead score history insert failed', {
      contactId: params.contactId,
      error: error.message,
    });
  }
}

/**
 * Forward-only stage progression: take the higher of current vs
 * suggested (spec 5 step 4). Terminal intents freeze the stage.
 * Unknown values on either side degrade safely to "keep current" —
 * never to a hole in the order list.
 */
export function resolvePipelineStage(params: {
  currentStage: string;
  suggestedStage: PipelineStage;
  intentType: IntentType;
}): string {
  if (isTerminalIntent(params.intentType)) return params.currentStage;

  const currentIdx = PIPELINE_STAGE_ORDER.indexOf(
    params.currentStage as PipelineStage
  );
  const suggestedIdx = PIPELINE_STAGE_ORDER.indexOf(params.suggestedStage);

  if (suggestedIdx === -1) return params.currentStage;
  if (currentIdx === -1 || suggestedIdx > currentIdx) {
    return params.suggestedStage;
  }
  return params.currentStage;
}

/**
 * The column is `text` (spec 1) so a hand-edited or legacy value could
 * be anything. Unknown values collapse to 'cold' — the correction is
 * then written back by the update below and lands in history.
 */
function normalizeScore(value: string | null): LeadScore {
  return KNOWN_SCORES.includes(value ?? '') ? (value as LeadScore) : 'cold';
}
