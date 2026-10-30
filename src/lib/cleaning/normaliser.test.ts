import { describe, expect, it } from 'vitest';

import { bestEffortKey, EMPTY_SENTINEL, normalise } from './normaliser';

describe('normalise — ported Python pipeline edge cases', () => {
  it('passes through an already-E.164 number unchanged', () => {
    expect(normalise('+971501234567', 'AE')).toEqual({
      e164: '+971501234567',
      reason: null,
    });
  });

  it('resolves a local-format number against the default country', () => {
    expect(normalise('0501234567', 'AE')).toEqual({
      e164: '+971501234567',
      reason: null,
    });
  });

  it('strips spaces between digits', () => {
    expect(normalise('+971 50 123 4567', 'AE')).toEqual({
      e164: '+971501234567',
      reason: null,
    });
  });

  it('strips dashes between digits', () => {
    expect(normalise('+971-50-123-4567', 'AE')).toEqual({
      e164: '+971501234567',
      reason: null,
    });
  });

  it('strips the Excel float .0 suffix', () => {
    expect(normalise('971501234567.0', 'AE')).toEqual({
      e164: '+971501234567',
      reason: null,
    });
  });

  it('re-hydrates scientific-notation strings to the integer string', () => {
    expect(normalise('9.71501234567e11', 'AE')).toEqual({
      e164: '+971501234567',
      reason: null,
    });
  });

  it('flags empty / null / NaN / "NaN" as reasons empty', () => {
    const empty = { e164: null, reason: 'empty' };
    expect(normalise('', 'AE')).toEqual(empty);
    expect(normalise('   ', 'AE')).toEqual(empty);
    expect(normalise(null, 'AE')).toEqual(empty);
    expect(normalise(undefined, 'AE')).toEqual(empty);
    expect(normalise(NaN, 'AE')).toEqual(empty);
    expect(normalise('NaN', 'AE')).toEqual(empty);
  });

  it('flags too-short numbers (below 7 digits)', () => {
    expect(normalise('123', 'AE')).toEqual({ e164: null, reason: 'too_short' });
    expect(normalise('12-34', 'AE')).toEqual({ e164: null, reason: 'too_short' });
  });

  it('keeps a non-default-country number with its own country code', () => {
    expect(normalise('+923001234567', 'AE')).toEqual({
      e164: '+923001234567',
      reason: null,
    });
  });

  it('produces identical output for duplicate-context inputs (dedup key)', () => {
    const local = normalise('0501234567', 'AE');
    const international = normalise('+971 50 123 4567', 'AE');
    expect(local).toEqual(international);
    expect(local.e164).toBe('+971501234567');
  });

  it('flags a parseable number with no determinable region as invalid_region', () => {
    expect(normalise('+80012345678', 'AE')).toEqual({
      e164: null,
      reason: 'invalid_region',
    });
  });

  it('flags unparseable numeric garbage as parse_failed', () => {
    expect(normalise('0000000000', 'AE')).toEqual({
      e164: null,
      reason: 'parse_failed',
    });
  });
});

describe('bestEffortKey — NOT NULL phone_e164 fallback for invalid rows', () => {
  it('uses the EMPTY sentinel for empty rows', () => {
    expect(bestEffortKey('empty', '')).toBe(EMPTY_SENTINEL);
    expect(bestEffortKey(null, '')).toBe(EMPTY_SENTINEL);
    expect(bestEffortKey('empty', '971501234567')).toBe(EMPTY_SENTINEL);
  });

  it('uses the digits-only string for too_short rows', () => {
    expect(bestEffortKey('too_short', '123')).toBe('123');
    expect(bestEffortKey('too_short', '12-3')).toBe('123');
  });

  it('uses the post-.0-strip (and scientific-rehydrated) raw string otherwise', () => {
    expect(bestEffortKey('parse_failed', '9.71501234567e11')).toBe('971501234567');
    expect(bestEffortKey('invalid_region', '971501234567.0 ')).toBe('971501234567');
  });
});