import { describe, expect, it } from 'vitest';

import type { AgentSignals, IntentType, LeadScore } from '../agent/types';
import { computeLeadScore, resolveScoreUpdate } from './scorer';

const NO_SIGNALS: AgentSignals = {
  mentioned_budget: false,
  mentioned_timeline: false,
  requested_visit: false,
  requested_pricing: false,
  negotiating: false,
  asked_for_contract: false,
};

const HOT_SIGNALS: AgentSignals = { ...NO_SIGNALS, requested_visit: true };
const WARM_SIGNALS: AgentSignals = { ...NO_SIGNALS, mentioned_budget: true };

describe('computeLeadScore', () => {
  it('scores closing intent hot', () => {
    expect(computeLeadScore('closing', NO_SIGNALS)).toBe('hot');
  });

  it.each<keyof AgentSignals>([
    'requested_visit',
    'negotiating',
    'asked_for_contract',
  ])('scores %s signal hot', (signal) => {
    expect(
      computeLeadScore('browsing', { ...NO_SIGNALS, [signal]: true })
    ).toBe('hot');
  });

  it('scores warm intent warm', () => {
    expect(computeLeadScore('interested', NO_SIGNALS)).toBe('warm');
    expect(computeLeadScore('qualifying', NO_SIGNALS)).toBe('warm');
  });

  it.each<keyof AgentSignals>([
    'mentioned_budget',
    'requested_pricing',
    'mentioned_timeline',
  ])('scores %s signal warm', (signal) => {
    expect(
      computeLeadScore('browsing', { ...NO_SIGNALS, [signal]: true })
    ).toBe('warm');
  });

  it('scores browsing with no signals cold', () => {
    expect(computeLeadScore('browsing', NO_SIGNALS)).toBe('cold');
  });

  it('terminal intents are cold even with hot/warm signals present', () => {
    // "I'd have visited, but I already bought elsewhere" still carries
    // a visit signal — the intent must win so dead leads never warm up.
    expect(computeLeadScore('lost', HOT_SIGNALS)).toBe('cold');
    expect(computeLeadScore('unsubscribed', WARM_SIGNALS)).toBe('cold');
    expect(computeLeadScore('unsubscribed', HOT_SIGNALS)).toBe('cold');
  });
});

describe('resolveScoreUpdate', () => {
  it('only moves up automatically (monotonic default)', () => {
    expect(resolveScoreUpdate('cold', 'warm')).toBe('warm');
    expect(resolveScoreUpdate('cold', 'hot')).toBe('hot');
    expect(resolveScoreUpdate('warm', 'hot')).toBe('hot');
    expect(resolveScoreUpdate('warm', 'cold')).toBe('warm');
    expect(resolveScoreUpdate('hot', 'cold')).toBe('hot');
    expect(resolveScoreUpdate('hot', 'warm')).toBe('hot');
  });

  it('holds current score when scores are equal', () => {
    expect(resolveScoreUpdate('warm', 'warm')).toBe('warm');
  });

  it('carve-out: lost intent downgrades hot → cold', () => {
    const computed = computeLeadScore('lost', NO_SIGNALS);
    expect(resolveScoreUpdate('hot', computed, 'lost')).toBe('cold');
  });

  it('carve-out: unsubscribed intent downgrades warm → cold', () => {
    const computed = computeLeadScore('unsubscribed', NO_SIGNALS);
    expect(resolveScoreUpdate('warm', computed, 'unsubscribed')).toBe('cold');
  });

  it('carve-out: terminal intent never upgrades a cold score', () => {
    const computed = computeLeadScore('lost', NO_SIGNALS);
    expect(resolveScoreUpdate('cold', computed, 'lost')).toBe('cold');
  });

  it('carve-out is lower-only — a terminal intent cannot manufacture hot', () => {
    expect(resolveScoreUpdate('warm', 'hot', 'lost')).toBe('warm');
  });

  it('non-terminal intents ignore the third argument and stay monotonic', () => {
    expect(resolveScoreUpdate('hot', 'cold', 'browsing')).toBe('hot');
    expect(resolveScoreUpdate('cold', 'hot', 'closing')).toBe('hot');
  });

  it('end-to-end: warm contact replying with terminal intent lands cold', () => {
    const intent: IntentType = 'unsubscribed';
    const computed = computeLeadScore(intent, WARM_SIGNALS);
    const current: LeadScore = 'warm';
    expect(resolveScoreUpdate(current, computed, intent)).toBe('cold');
  });
});
