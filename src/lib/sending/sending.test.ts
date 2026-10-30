import { describe, expect, it } from 'vitest';

import {
  isBlockedContactCode,
  isInvalidNumberCode,
  isWindowViolationCode,
  isRetryableHttpStatus,
  WaSendError,
} from './types';
import { isWindowOpen, assertWindowOpen, WINDOW_MS } from './window';
import { ComplianceError } from './types';
import { normalizeLanguageCode } from './client';

const HOUR = 60 * 60 * 1000;

describe('window — 24-hour rule derived from last_inbound_at', () => {
  it('is open when last message is younger than 24h', () => {
    expect(isWindowOpen(new Date(Date.now() - HOUR).toISOString())).toBe(true);
  });

  it('is closed when last message is older than 24h', () => {
    expect(
      isWindowOpen(new Date(Date.now() - WINDOW_MS - 1000).toISOString())
    ).toBe(false);
  });

  it('is closed when there is no last message at all', () => {
    expect(isWindowOpen(null)).toBe(false);
  });

  it('is closed on an unparseable timestamp', () => {
    expect(isWindowOpen('not-a-date')).toBe(false);
  });

  it('rejects free-form text outside the window (compliance)', () => {
    const old = new Date(Date.now() - WINDOW_MS - 1000).toISOString();
    expect(() => assertWindowOpen(old, 'text')).toThrow(ComplianceError);
  });

  it('allows free-form text inside the window', () => {
    const fresh = new Date(Date.now() - HOUR).toISOString();
    expect(() => assertWindowOpen(fresh, 'text')).not.toThrow();
  });

  it('always allows template sends regardless of window state', () => {
    expect(() => assertWindowOpen(null, 'template')).not.toThrow();
    const old = new Date(Date.now() - 7 * 24 * HOUR).toISOString();
    expect(() => assertWindowOpen(old, 'template')).not.toThrow();
  });
});

describe('Meta error-code classification', () => {
  it('recognises blocked / opted-out codes', () => {
    expect(isBlockedContactCode(131026)).toBe(true);
    expect(isBlockedContactCode(131049)).toBe(true);
  });

  it('recognises invalid-number codes', () => {
    for (const code of [131047, 131048, 131051]) {
      expect(isInvalidNumberCode(code)).toBe(true);
      expect(isBlockedContactCode(code)).toBe(false);
    }
  });

  it('treats out-of-window codes as neither blocked nor invalid', () => {
    for (const code of [131040, 131043]) {
      expect(isWindowViolationCode(code)).toBe(true);
      expect(isBlockedContactCode(code)).toBe(false);
      expect(isInvalidNumberCode(code)).toBe(false);
    }
  });

  it('ignores null / other codes', () => {
    expect(isBlockedContactCode(null)).toBe(false);
    expect(isInvalidNumberCode(123456)).toBe(false);
  });
});

describe('retryability policy', () => {
  it('retries throttled and 5xx statuses', () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504]) {
      expect(isRetryableHttpStatus(status)).toBe(true);
    }
  });

  it('does not retry business 4xx statuses', () => {
    for (const status of [400, 401, 403, 404, 409]) {
      expect(isRetryableHttpStatus(status)).toBe(false);
    }
  });

  it('classifies a blocked-recipient WaSendError accordingly', () => {
    const error = new WaSendError('recipient blocked', {
      waErrorCode: 131049,
      httpStatus: 400,
      recipient: '+971500000000',
      retryable: false,
    });
    expect(error.isBlockedContact).toBe(true);
    expect(error.isInvalidNumber).toBe(false);
  });
});

describe('normalizeLanguageCode', () => {
  it('maps the stored short code to Meta locale', () => {
    expect(normalizeLanguageCode('en')).toBe('en_US');
  });

  it('passes full locale codes through', () => {
    expect(normalizeLanguageCode('ar')).toBe('ar');
    expect(normalizeLanguageCode('en_GB')).toBe('en_GB');
  });
});
