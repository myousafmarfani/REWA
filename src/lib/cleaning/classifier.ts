import { parsePhoneNumber } from 'libphonenumber-js/max';

import type { EmailType, NumberType } from './types';

export interface NumberClassification {
  numberType: NumberType;
  region: string | null;
  carrier: string | null;
  isPremium: boolean;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Personal domains match the bare domain AND any subdomain via the
// `.${domain}` suffix test (sub.yahoo.co.uk is personal, notgmail.com is
// not). Extended beyond the spec list per domain review.
const PERSONAL_DOMAINS: string[] = [
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.uk',
  'yahoo.co.in',
  'ymail.com',
  'rocketmail.com',
  'hotmail.com',
  'outlook.com',
  'icloud.com',
  'me.com',
  'live.com',
  'aol.com',
  'protonmail.com',
  'proton.me',
];

// Exact local-part match, per spec.
const GENERIC_PREFIXES: string[] = [
  'info',
  'sales',
  'contact',
  'support',
  'admin',
  'hello',
  'team',
  'office',
  'enquiries',
  'enquiry',
];

// These come from libphonenumber-js's `PhoneNumber.getType()` (the `max`
// metadata build — the default `min` build yields `undefined` for UAE/PK
// mobiles, which would break send-eligibility). `getType()` returns:
// MOBILE, FIXED_LINE, FIXED_LINE_OR_MOBILE, VOIP, PREMIUM_RATE, ... or
// undefined when the metadata can't tell.
function mapNumberType(
  libType: string | undefined,
): { numberType: NumberType; isPremium: boolean } {
  switch (libType) {
    case 'MOBILE':
      return { numberType: 'mobile', isPremium: false };
    case 'FIXED_LINE':
    case 'FIXED_LINE_OR_MOBILE':
      return { numberType: 'landline', isPremium: false };
    case 'VOIP':
      return { numberType: 'voip', isPremium: false };
    case 'PREMIUM_RATE':
      return { numberType: 'unknown', isPremium: true };
    default:
      return { numberType: 'unknown', isPremium: false };
  }
}

/**
 * Classify a validated E.164. Region is the ISO2 country code, carrier is
 * where libphonenumber-js metadata holds one (often unavailable → null).
 */
export function classifyNumber(e164: string): NumberClassification {
  try {
    const parsed = parsePhoneNumber(e164);
    if (!parsed || !parsed.isValid()) {
      return { numberType: 'unknown', region: null, carrier: null, isPremium: false };
    }
    const { numberType, isPremium } = mapNumberType(parsed.getType());
    return {
      numberType,
      isPremium,
      region: parsed.country ?? null,
      // libphonenumber-js no longer ships carrier codes (metadata was
      // stripped upstream), so this is effectively always null.
      carrier: parsed.carrierCode ?? null,
    };
  } catch {
    return { numberType: 'unknown', region: null, carrier: null, isPremium: false };
  }
}

export function classifyEmail(email: string): EmailType {
  const lower = email.trim().toLowerCase();
  if (!EMAIL_RE.test(lower)) return 'invalid';
  const at = lower.indexOf('@');
  const local = lower.slice(0, at);
  const domain = lower.slice(at + 1);
  if (PERSONAL_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) {
    return 'personal';
  }
  if (GENERIC_PREFIXES.includes(local)) return 'generic';
  return 'business';
}