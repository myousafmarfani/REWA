import { describe, expect, it } from 'vitest';

import { resolvePipelineStage } from './index';

describe('resolvePipelineStage', () => {
  it('advances forward when the agent suggests a later stage', () => {
    expect(
      resolvePipelineStage({
        currentStage: 'contacted',
        suggestedStage: 'qualified',
        intentType: 'interested',
      })
    ).toBe('qualified');
    expect(
      resolvePipelineStage({
        currentStage: 'new_lead',
        suggestedStage: 'viewing_booked',
        intentType: 'closing',
      })
    ).toBe('viewing_booked');
  });

  it('never moves backward automatically (spec 5 step 4)', () => {
    expect(
      resolvePipelineStage({
        currentStage: 'viewing_booked',
        suggestedStage: 'qualified',
        intentType: 'browsing',
      })
    ).toBe('viewing_booked');
    expect(
      resolvePipelineStage({
        currentStage: 'negotiation',
        suggestedStage: 'new_lead',
        intentType: 'qualifying',
      })
    ).toBe('negotiation');
  });

  it('holds the stage when the suggestion equals the current stage', () => {
    expect(
      resolvePipelineStage({
        currentStage: 'qualified',
        suggestedStage: 'qualified',
        intentType: 'interested',
      })
    ).toBe('qualified');
  });

  it('terminal intents freeze the stage even on a forward suggestion', () => {
    expect(
      resolvePipelineStage({
        currentStage: 'contacted',
        suggestedStage: 'negotiation',
        intentType: 'lost',
      })
    ).toBe('contacted');
    expect(
      resolvePipelineStage({
        currentStage: 'qualified',
        suggestedStage: 'viewing_booked',
        intentType: 'unsubscribed',
      })
    ).toBe('qualified');
  });

  it('an unknown/legacy current stage adopts the valid suggestion', () => {
    expect(
      resolvePipelineStage({
        currentStage: 'some_legacy_value',
        suggestedStage: 'qualified',
        intentType: 'interested',
      })
    ).toBe('qualified');
  });
});
