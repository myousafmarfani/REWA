import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentSignals, IntentType } from '../agent/types';

const { escalate, maybeSingle, updateRows, insertHistory } = vi.hoisted(() => {
  const maybeSingle = vi.fn();
  const escalate = vi.fn().mockResolvedValue(undefined);
  const updateRows: Record<string, unknown>[] = [];
  const insertHistory = vi.fn().mockResolvedValue({ error: null });
  return { escalate, maybeSingle, updateRows, insertHistory };
});

vi.mock('./escalation', () => ({
  triggerEscalation: escalate,
}));

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'contacts') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ maybeSingle }),
            }),
          }),
          update: (payload: Record<string, unknown>) => {
            updateRows.push(payload);
            return { eq: () => ({ eq: async () => ({ error: null }) }) };
          },
        };
      }
      if (table === 'lead_score_history') {
        return { insert: insertHistory };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

import { updateLeadScore } from './index';

const NO_SIGNALS: AgentSignals = {
  mentioned_budget: false,
  mentioned_timeline: false,
  requested_visit: false,
  requested_pricing: false,
  negotiating: false,
  asked_for_contract: false,
};

function output(intent: IntentType, suggested: 'new_lead' | 'negotiation') {
  return {
    message: 'reply body',
    intent_type: intent,
    signals: NO_SIGNALS,
    suggested_stage: suggested,
  };
}

function contactRow(
  overrides: Partial<{
    lead_score: string;
    pipeline_stage: string;
    opted_out: boolean;
  }> = {}
) {
  return {
    lead_score: 'cold',
    pipeline_stage: 'new_lead',
    opted_out: false,
    ...overrides,
  };
}

beforeEach(() => {
  updateRows.length = 0;
  insertHistory.mockClear();
  escalate.mockClear();
});

describe('updateLeadScore', () => {
  it('flags opted_out and returns optedOut on an unsubscribe, even with no score change', async () => {
    maybeSingle.mockResolvedValue({ data: contactRow(), error: null });

    const result = await updateLeadScore({
      clientId: 'c1',
      contactId: 'ct1',
      messageId: 'm1',
      optOutMessageId: 'inbound-1',
      agentOutput: output('unsubscribed', 'new_lead'),
    });

    expect(result?.optedOut).toBe(true);
    expect(result?.scoreChanged).toBe(false); // already cold → no history
    expect(updateRows).toHaveLength(1);
    expect(updateRows[0]).toMatchObject({
      opted_out: true,
      opted_out_source: 'contact_reply',
      opt_out_message_id: 'inbound-1', // audit symmetry with the webhook keyword path
      lead_score: 'cold',
    });
    expect(updateRows[0].opted_out_at).toEqual(expect.any(String));
    expect(insertHistory).not.toHaveBeenCalled();
    expect(escalate).not.toHaveBeenCalled();
  });

  it('carve-out: lost intent downgrades hot → cold, clears the star flag, writes raw history, never escalates', async () => {
    maybeSingle.mockResolvedValue({
      data: contactRow({ lead_score: 'hot', pipeline_stage: 'negotiation' }),
      error: null,
    });

    const result = await updateLeadScore({
      clientId: 'c1',
      contactId: 'ct1',
      messageId: 'm1',
      agentOutput: output('lost', 'new_lead'), // backward suggestion must also be ignored
    });

    expect(result).toMatchObject({
      previousScore: 'hot',
      newScore: 'cold',
      scoreChanged: true,
      newlyHot: false,
      optedOut: false,
      pipelineStage: 'negotiation', // terminal intent freezes the stage
    });
    expect(updateRows[0]).toMatchObject({
      lead_score: 'cold',
      pipeline_stage: 'negotiation',
      hot_flagged_at: null,
    });
    expect(insertHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        previous_score: 'hot',
        new_score: 'cold',
        reason: 'agent: intent=lost',
      })
    );
    expect(escalate).not.toHaveBeenCalled();
  });

  it('writes nothing when score, stage, and consent are all unchanged', async () => {
    maybeSingle.mockResolvedValue({ data: contactRow(), error: null });

    const result = await updateLeadScore({
      clientId: 'c1',
      contactId: 'ct1',
      messageId: 'm1',
      agentOutput: output('browsing', 'new_lead'),
    });

    expect(result).toMatchObject({
      scoreChanged: false,
      stageChanged: false,
      optedOut: false,
    });
    expect(updateRows).toHaveLength(0);
    expect(insertHistory).not.toHaveBeenCalled();
    expect(escalate).not.toHaveBeenCalled();
  });

  it('sets hot_flagged_at, records history, and escalates on the cold → hot edge', async () => {
    maybeSingle.mockResolvedValue({ data: contactRow(), error: null });

    const result = await updateLeadScore({
      clientId: 'c1',
      contactId: 'ct1',
      messageId: 'm1',
      agentOutput: output('closing', 'negotiation'),
    });

    expect(result).toMatchObject({
      newScore: 'hot',
      newlyHot: true,
      scoreChanged: true,
      stageChanged: true,
      pipelineStage: 'negotiation',
    });
    expect(updateRows[0]).toMatchObject({
      lead_score: 'hot',
      pipeline_stage: 'negotiation',
      hot_flagged_at: expect.any(String),
    });
    expect('opt_out_message_id' in updateRows[0]).toBe(false); // only written on opt-out
    expect(insertHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        previous_score: 'cold',
        new_score: 'hot',
        message_id: 'm1',
      })
    );
    expect(escalate).toHaveBeenCalledTimes(1);
    expect(escalate).toHaveBeenCalledWith({
      clientId: 'c1',
      contactId: 'ct1',
      lastMessage: 'reply body',
    });
  });

  it('does not re-flag an already opted-out contact', async () => {
    maybeSingle.mockResolvedValue({
      data: contactRow({ opted_out: true }),
      error: null,
    });

    const result = await updateLeadScore({
      clientId: 'c1',
      contactId: 'ct1',
      messageId: 'm1',
      agentOutput: output('unsubscribed', 'new_lead'),
    });

    expect(result?.optedOut).toBe(false);
    expect(updateRows).toHaveLength(0);
  });
});
