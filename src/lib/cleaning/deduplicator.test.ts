import { describe, expect, it } from 'vitest';

import { deduplicateContacts } from './deduplicator';
import type { NormalisedContact } from './types';

function row(e164: string | null, rowIndex: number): NormalisedContact {
  return {
    rawPhone: e164 ?? '',
    rawName: null,
    rawEmail: null,
    rowIndex,
    raw: {},
    e164,
    invalidReason: e164 === null ? 'parse_failed' : null,
  };
}

describe('deduplicateContacts', () => {
  it('marks an exact duplicate while keeping the first occurrence', () => {
    const first = row('+971501234567', 0);
    const again = row('+971501234567', 1);

    const { clean, duplicates, reviews } = deduplicateContacts([first, again]);
    expect(clean).toEqual([first]);
    expect(duplicates).toEqual([again]);
    expect(reviews).toHaveLength(0);
  });

  it('flags a near-duplicate (first 10 digits match) as review, not merged', () => {
    const a = row('+971501234567', 0);
    const b = row('+971501234568', 1);

    const { clean, duplicates, reviews } = deduplicateContacts([a, b]);
    expect(clean).toEqual([a]);
    expect(duplicates).toHaveLength(0);
    expect(reviews).toEqual([b]);
  });

  it('leaves distinct numbers uncollapsed', () => {
    const a = row('+971501234567', 0);
    const b = row('+923001234567', 1);
    const c = row('+971501234568', 2);

    const { clean, duplicates, reviews } = deduplicateContacts([a, b, c]);
    expect(clean).toEqual([a, b]);
    expect(duplicates).toHaveLength(0);
    expect(reviews).toEqual([c]);
  });

  it('does not auto-merge a repeat of a reviewed number — still review', () => {
    const a = row('+971501234567', 0);
    const b = row('+971501234568', 1);
    const c = row('+971501234568', 2);

    const { clean, reviews } = deduplicateContacts([a, b, c]);
    expect(clean).toEqual([a]);
    expect(reviews.map((r) => r.rowIndex)).toEqual([1, 2]);
    expect(new Set(reviews).size).toBe(2);
  });
});