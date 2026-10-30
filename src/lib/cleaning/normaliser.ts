import { isValidPhoneNumber, parsePhoneNumber, type CountryCode } from 'libphonenumber-js';

import type { InvalidReason } from './types';

export interface NormaliseResult {
  e164: string | null;
  reason: InvalidReason | null;
}

// Sentinel storage key for rows with no usable digits. contacts.phone_e164
// is NOT NULL and the unique constraint is (client_id, phone_e164), so
// every invalid row collapses under this key — accepted trade-off (all
// such rows share the same key, so at most one persists per import cycle).
export const EMPTY_SENTINEL = 'EMPTY';

// Excel stores numeric cells whose text representation can carry a
// trailing .0 or scientific notation. Re-hydrate both back into the
// plain integer string the original pipeline produced.
function toIntegerString(raw: string): string {
  let s = raw.trim().replace(/\.0+$/, '');
  if (/[eE]/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) s = String(n);
  }
  return s;
}

/**
 * Normalise a raw phone value to E.164 using `defaultCountry` as the
 * region hint for numbers written in local format.
 *
 * Edge cases ported verbatim from the Python pipeline: already-E.164
 * pass-through, local format, spaces/dashes, Excel float + scientific
 * strings, empty/NaN, too-short, and non-default-country numbers that
 * carry their own country code (+923001234567 stays Pakistani).
 */
export function normalise(
  raw: string | number | null | undefined,
  defaultCountry: string,
): NormaliseResult {
  if (raw === null || raw === undefined) return { e164: null, reason: 'empty' };
  if (typeof raw === 'number' && !Number.isFinite(raw)) {
    return { e164: null, reason: 'empty' };
  }
  const rawStr = typeof raw === 'number' ? String(raw) : raw;
  const trimmed = rawStr.trim();
  if (trimmed === '' || trimmed === 'NaN') return { e164: null, reason: 'empty' };

  const cleaned = toIntegerString(trimmed);
  const digitsOnly = cleaned.replace(/\D/g, '');
  if (digitsOnly.length < 7) return { e164: null, reason: 'too_short' };

  try {
    if (!isValidPhoneNumber(cleaned, defaultCountry as CountryCode)) {
      return { e164: null, reason: 'parse_failed' };
    }
    const parsed = parsePhoneNumber(cleaned, defaultCountry as CountryCode);
    if (!parsed.country) return { e164: null, reason: 'invalid_region' };
    return { e164: parsed.format('E.164'), reason: null };
  } catch {
    return { e164: null, reason: 'parse_failed' };
  }
}

/**
 * Best-effort contacts.phone_e164 key for an invalid row, since the
 * column is NOT NULL. empty → EMPTY sentinel; too_short → digits only;
 * parse_failed / invalid_region → the cleaned raw string (post .0-strip).
 */
export function bestEffortKey(reason: InvalidReason | null, raw: string): string {
  const cleaned = toIntegerString(raw);
  switch (reason) {
    case 'empty':
      return EMPTY_SENTINEL;
    case 'too_short':
      return cleaned.replace(/\D/g, '') || EMPTY_SENTINEL;
    case 'parse_failed':
    case 'invalid_region':
      return cleaned || EMPTY_SENTINEL;
    default:
      return cleaned || EMPTY_SENTINEL;
  }
}