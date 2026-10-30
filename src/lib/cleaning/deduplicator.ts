import type { NormalisedContact } from './types';

export interface DedupeResult<T extends NormalisedContact> {
  clean: T[];
  duplicates: T[];
  reviews: T[];
}

/**
 * Exact duplicates collapse on the full E.164 (first row wins; later rows
 * are marked 'duplicate' and never written — bookkeeping only). Near-dups
 * share the first 10 digits but differ beyond that (e.g. a trailing-digit
 * typo) and are flagged 'review' for a human. Near-dups are never merged
 * automatically.
 */
export function deduplicateContacts<T extends NormalisedContact>(
  contacts: T[],
): DedupeResult<T> {
  const seenE164 = new Map<string, number>(); // e164 → first row index
  const seenPrefix = new Map<string, string>(); // first10digits → first e164
  const clean: T[] = [];
  const duplicates: T[] = [];
  const reviews: T[] = [];

  for (const contact of contacts) {
    const e164 = contact.e164;
    if (e164 === null) {
      clean.push(contact);
      continue;
    }
    if (seenE164.has(e164)) {
      duplicates.push(contact);
      continue;
    }
    const prefix = e164.slice(0, 10);
    if (seenPrefix.has(prefix)) {
      reviews.push(contact);
      continue;
    }
    seenE164.set(e164, contact.rowIndex);
    seenPrefix.set(prefix, e164);
    clean.push(contact);
  }
  return { clean, duplicates, reviews };
}