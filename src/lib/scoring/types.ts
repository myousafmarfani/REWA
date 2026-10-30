import type { IntentType, LeadScore, PipelineStage } from '../agent/types';

export type { IntentType, LeadScore, PipelineStage };

/**
 * Terminal disengagement intents (spec 5 extension).
 *
 * The model classifies a contact who has bowed out — "I bought
 * elsewhere", "I'm not interested anymore" → `lost`; "stop messaging
 * me", "take me off your list" → `unsubscribed` — into these two
 * intents instead of a browsing/qualifying score. They are the carve-out
 * to the monotonic score rule (see scorer.ts): a dead lead must not sit
 * in the export and the pipeline UI with a stale warm/hot star.
 */
export const TERMINAL_INTENTS = ['lost', 'unsubscribed'] as const;

export type TerminalIntent = (typeof TERMINAL_INTENTS)[number];

export function isTerminalIntent(intent: IntentType): intent is TerminalIntent {
  return (TERMINAL_INTENTS as readonly string[]).includes(intent);
}

/**
 * Pipeline stage progression order (spec 1 domain order). Only forward
 * motion is ever applied automatically — a human moves stages backward.
 * Unknown/legacy values are NOT in the list and are handled defensively
 * by the caller (never index into a missing position).
 */
export const PIPELINE_STAGE_ORDER: readonly PipelineStage[] = [
  'new_lead',
  'contacted',
  'qualified',
  'viewing_booked',
  'offer_made',
  'negotiation',
];

/** Outcome of one updateLeadScore() run — returned for callers/tests. */
export interface ScoreUpdateResult {
  previousScore: LeadScore;
  newScore: LeadScore;
  scoreChanged: boolean;
  /** True only on cold/warm → hot, the escalation trigger (entry 10). */
  newlyHot: boolean;
  stageChanged: boolean;
  pipelineStage: string;
  /**
   * True when this exchange flipped the contact to opted_out — the
   * agent classified intent 'unsubscribed' (compliance: "or
   * equivalent" — the webhook regex only catches keyword phrasings).
   * Callers MUST NOT send anything afterwards; gates.ts blocks every
   * subsequent exchange.
   */
  optedOut: boolean;
}

export interface UpdateLeadScoreParams {
  clientId: string;
  contactId: string;
  messageId: string;
  /**
   * The INBOUND message row that triggered the exchange — the same row
   * the webhook keyword path writes to contacts.opt_out_message_id.
   * Recorded on the agent-classified unsubscribe for audit symmetry
   * (FK → messages(id)). Absent on manual task replays; then the column
   * is simply left alone.
   */
  optOutMessageId?: string | null;
  agentOutput: {
    message: string;
    intent_type: IntentType;
    signals: {
      mentioned_budget: boolean;
      mentioned_timeline: boolean;
      requested_visit: boolean;
      requested_pricing: boolean;
      negotiating: boolean;
      asked_for_contract: boolean;
    };
    suggested_stage: PipelineStage;
  };
}

export interface EscalationParams {
  clientId: string;
  contactId: string;
  /** The agent's last reply preview — the alert body's context. */
  lastMessage: string;
}

/** One row of the continuous CSV/Excel export (spec 5 export contract). */
export interface ContactExportRow {
  name: string;
  phone: string;
  email: string | null;
  lead_score: string;
  pipeline_stage: string;
  status: string;
  number_type: string;
  region: string | null;
  priority_rank: number | null;
  human_controlled: boolean;
  opted_out: boolean;
  last_contacted_at: string | null;
  last_reply_at: string | null;
  hot_flagged_at: string | null;
}
