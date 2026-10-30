import { describe, expect, it } from 'vitest';

import { classifyEmail, classifyNumber } from './classifier';

describe('classifyEmail', () => {
  it('classifies personal domains (bare + subdomain suffix)', () => {
    expect(classifyEmail('bob@gmail.com')).toBe('personal');
    expect(classifyEmail('bob@sub.yahoo.co.uk')).toBe('personal');
    expect(classifyEmail('bob@protonmail.com')).toBe('personal');
    expect(classifyEmail('BOB@GMAIL.COM')).toBe('personal');
  });

  it('rejects lookalike personal domains', () => {
    expect(classifyEmail('bob@notgmail.com')).toBe('business');
    expect(classifyEmail('bob@fakeyahoo.com')).toBe('business');
  });

  it('classifies generic addresses on exact local-part match only', () => {
    expect(classifyEmail('info@acme.com')).toBe('generic');
    expect(classifyEmail('sales@acme.com')).toBe('generic');
    expect(classifyEmail('enquiry@acme.com')).toBe('generic');
    expect(classifyEmail('quick.sales@acme.com')).toBe('business');
    expect(classifyEmail('salesdirect@acme.com')).toBe('business');
  });

  it('classifies anything else well-formed as business', () => {
    expect(classifyEmail('jane@acme.com')).toBe('business');
    expect(classifyEmail('dev@acme.co.uk')).toBe('business');
  });

  it('flags non-conforming emails as invalid', () => {
    expect(classifyEmail('nope')).toBe('invalid');
    expect(classifyEmail('a@@b.com')).toBe('invalid');
    expect(classifyEmail('a b@c.com')).toBe('invalid');
    expect(classifyEmail('')).toBe('invalid');
  });
});

describe('classifyNumber', () => {
  it('detects mobile with region', () => {
    const mobile = classifyNumber('+971501234567');
    expect(mobile.numberType).toBe('mobile');
    expect(mobile.region).toBe('AE');
    expect(mobile.isPremium).toBe(false);
    expect(classifyNumber('+923001234567').numberType).toBe('mobile');
  });

  it('maps FIXED_LINE and FIXED_LINE_OR_MOBILE to landline', () => {
    expect(classifyNumber('+442071838750').numberType).toBe('landline');
    expect(classifyNumber('+14155552671').numberType).toBe('landline');
  });

  it('detects voip numbers', () => {
    expect(classifyNumber('+33908345678').numberType).toBe('voip');
  });

  it('flags premium-rate numbers and leaves the type unknown', () => {
    const premium = classifyNumber('+19005550123');
    expect(premium.isPremium).toBe(true);
    expect(premium.numberType).toBe('unknown');
    expect(premium.region).toBe('US');
  });
});