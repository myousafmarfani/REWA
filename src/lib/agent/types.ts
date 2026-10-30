export interface AgentSignals {
  mentioned_budget: boolean;
  mentioned_timeline: boolean;
  requested_visit: boolean;
  requested_pricing: boolean;
  negotiating: boolean;
  asked_for_contract: boolean;
}

export type LeadScore = 'cold' | 'warm' | 'hot';
/**
 * Intent classification. The last two are terminal disengagement states
 * (spec 5 carve-out — see scoring/scorer.ts): `lost` = the contact bowed
 * out of the deal ("not interested anymore", bought elsewhere),
 * `unsubscribed` = the contact asked to stop being messaged. They never
 * upgrade a score and they freeze the pipeline stage.
 */
export type IntentType =
  | 'browsing'
  | 'qualifying'
  | 'interested'
  | 'closing'
  | 'lost'
  | 'unsubscribed';
export type PipelineStage =
  | 'new_lead'
  | 'contacted'
  | 'qualified'
  | 'viewing_booked'
  | 'offer_made'
  | 'negotiation';

export interface AgentOutput {
  message: string;
  lead_score: LeadScore;
  intent_type: IntentType;
  signals: AgentSignals;
  suggested_stage: PipelineStage;
  needs_follow_up: boolean;
  follow_up_reason: string | null;
}

export interface AgentContext {
  clientId: string;
  contactId: string;
  conversationId: string;
  inboundMessage: string;
  waMessageId: string;
  waTimestamp: Date;
}

export interface ConversationHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface RetrievedChunk {
  content: string;
  chunkType: string;
  metadata: Record<string, unknown>;
}
