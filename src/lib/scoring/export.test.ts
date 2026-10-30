import { describe, expect, it } from 'vitest';

import { toExportRow } from './export';

const CONTACT = {
  full_name: 'Aisha Khan',
  phone_e164: '+971501234567',
  email: 'aisha@example.com',
  lead_score: 'hot',
  pipeline_stage: 'viewing_booked',
  status: 'clean',
  number_type: 'mobile',
  region: 'AE',
  priority_rank: 3,
  human_controlled: false,
  opted_out: false,
  last_contacted_at: '2026-09-20T10:00:00+00:00',
  last_reply_at: '2026-09-21T08:30:00+00:00',
  hot_flagged_at: '2026-09-21T08:31:00+00:00',
} as const;

describe('toExportRow', () => {
  it('maps every export-contract column (spec 5)', () => {
    expect(toExportRow(CONTACT)).toEqual({
      name: 'Aisha Khan',
      phone: '+971501234567',
      email: 'aisha@example.com',
      lead_score: 'hot',
      pipeline_stage: 'viewing_booked',
      status: 'clean',
      number_type: 'mobile',
      region: 'AE',
      priority_rank: 3,
      human_controlled: false,
      opted_out: false,
      last_contacted_at: '2026-09-20T10:00:00+00:00',
      last_reply_at: '2026-09-21T08:30:00+00:00',
      hot_flagged_at: '2026-09-21T08:31:00+00:00',
    });
  });

  it('defaults absent name / number_type to empty strings', () => {
    const row = toExportRow({
      ...CONTACT,
      full_name: null,
      number_type: null,
    });
    expect(row.name).toBe('');
    expect(row.number_type).toBe('');
  });

  it('preserves null timestamps and priority_rank', () => {
    const row = toExportRow({
      ...CONTACT,
      last_contacted_at: null,
      last_reply_at: null,
      hot_flagged_at: null,
      priority_rank: null,
    });
    expect(row.last_reply_at).toBeNull();
    expect(row.hot_flagged_at).toBeNull();
    expect(row.priority_rank).toBeNull();
  });

  it('carries opt-out + human takeover flags (compliance columns)', () => {
    const row = toExportRow({
      ...CONTACT,
      opted_out: true,
      human_controlled: true,
    });
    expect(row.opted_out).toBe(true);
    expect(row.human_controlled).toBe(true);
  });
});
