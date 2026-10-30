import type { AgentSignals, IntentType, LeadScore } from '../agent/types';
import { isTerminalIntent } from './types';

/**
 * Score assignment from the agent's classified intent + signals
 * (spec 5). Signal semantics follow the real-estate-outreach-domain
 * skill: cold = browsing/no budget, warm = unit/payment-plan/timeline
 * questions, hot = explicit closing signals (visit, final price,
 * negotiation, contract).
 */

const SCORE_ORDER: Record<LeadScore, number> = { cold: 0, warm: 1, hot: 2 };

/**
 * Compute the score implied by this exchange.
 *
 * Terminal intents short-circuit to 'cold' FIRST: a contact who has
 * disengaged can still trip hot/warm flags mid-sentence ("I'd have
 * visited but I bought elsewhere"), and those signals must not keep the
 * escalation machinery warm for a dead lead.
 */
export function computeLeadScore(
  intentType: IntentType,
  signals: AgentSignals
): LeadScore {
  // Terminal disengagement — never an upgrade path.
  if (isTerminalIntent(intentType)) {
    return 'cold';
  }

  // HOT: any closing signal present (MEMORY entry 9).
  if (
    signals.requested_visit ||
    signals.negotiating ||
    signals.asked_for_contract ||
    intentType === 'closing'
  ) {
    return 'hot';
  }

  // WARM: qualified interest signals.
  if (
    signals.mentioned_budget ||
    signals.requested_pricing ||
    signals.mentioned_timeline ||
    intentType === 'interested' ||
    intentType === 'qualifying'
  ) {
    return 'warm';
  }

  // COLD: default (browsing / vague interest, no budget signal).
  return 'cold';
}

/**
 * Apply the score to the contact's current score.
 *
 * Default rule (spec 5): the score only moves UP automatically — a
 * warm lead answering one weak message stays warm; only a human agent
 * downgrades (manual override route).
 *
 * Carve-out — lost / unsubscribed: terminal intents are the one
 * automatic exception. Their computed score is 'cold' and it is applied
 * even when it lowers a warm/hot score, so a disengaged contact stops
 * carrying a star in the UI and a stale hot row in the daily export.
 * Without the carve-out the monotonic rule would pin dead leads at hot
 * forever.
 *
 * The third argument is optional so two-argument monotonic callers
 * (and existing tests) keep their exact behaviour.
 */
export function resolveScoreUpdate(
  currentScore: LeadScore,
  newScore: LeadScore,
  intentType?: IntentType
): LeadScore {
  if (intentType && isTerminalIntent(intentType)) {
    // Lower-only: the terminal path can never manufacture an upgrade,
    // even if a caller hands it a non-cold score.
    return SCORE_ORDER[newScore] < SCORE_ORDER[currentScore]
      ? newScore
      : currentScore;
  }
  return SCORE_ORDER[newScore] > SCORE_ORDER[currentScore]
    ? newScore
    : currentScore;
}
