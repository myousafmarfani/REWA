import { describe, expect, it } from 'vitest';
import { isOptOut } from './opt-out';

describe('isOptOut', () => {
  it('matches the direct opt-out keywords', () => {
    expect(isOptOut('stop')).toBe(true);
    expect(isOptOut('STOP')).toBe(true);
    expect(isOptOut('please unsubscribe')).toBe(true);
    expect(isOptOut('unsub me')).toBe(true);
    expect(isOptOut('unsubs me')).toBe(true);
    expect(isOptOut('please opt-out')).toBe(true);
    expect(isOptOut('opt out')).toBe(true);
    expect(isOptOut('block me')).toBe(true);
  });

  it('matches unsubscribe-equivalent phrasings', () => {
    expect(isOptOut("don't contact me again")).toBe(true);
    expect(isOptOut('do not message me')).toBe(true);
    expect(isOptOut('never text me')).toBe(true);
    expect(isOptOut('do not reach out to me')).toBe(true);
    expect(isOptOut('remove me from your list')).toBe(true);
    expect(isOptOut('delete my number')).toBe(true);
    expect(isOptOut('take me off your list')).toBe(true);
    expect(isOptOut('no more messages')).toBe(true);
    expect(isOptOut('stop sending me updates')).toBe(true);
    expect(isOptOut('leave me alone')).toBe(true);
    expect(isOptOut('unsubscribe me')).toBe(true);
    expect(isOptOut('opt me out')).toBe(true);
    expect(isOptOut('please remove me')).toBe(true);
  });

  it('matches Arabic opt-out phrasings', () => {
    expect(isOptOut('لا تراسلني')).toBe(true);
    expect(isOptOut('إلغاء الاشتراك')).toBe(true);
    expect(isOptOut('احذف رقمي')).toBe(true);
  });

  it('does not match ordinary property enquiries', () => {
    expect(isOptOut('Hi, is the 2BR still available?')).toBe(false);
    expect(isOptOut('Can you send me the floor plan?')).toBe(false);
    expect(isOptOut('What is the payment plan for unit 1204?')).toBe(false);
    expect(isOptOut("I'd like to book a viewing on Saturday")).toBe(false);
    expect(isOptOut('Can you take me to see the apartment?')).toBe(false);
    expect(isOptOut('Could you take me through the payment plan?')).toBe(false);
    expect(isOptOut('What areas do you cover?')).toBe(false);
    expect(isOptOut('Which block is the unit in?')).toBe(false);
    expect(isOptOut('متى إيقاف البناء؟')).toBe(false);
  });
});
