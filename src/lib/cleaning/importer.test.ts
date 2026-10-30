import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { writeContacts } from './importer';
import type { CleanedContact } from './types';

interface ExistingRow {
  phone_e164: string;
  full_name: string | null;
  email: string | null;
}

function clean(overrides: Partial<CleanedContact> = {}): CleanedContact {
  return {
    phoneE164: '+971501234567',
    fullName: null,
    email: null,
    emailType: null,
    status: 'clean',
    invalidReason: null,
    numberType: 'mobile',
    region: 'AE',
    carrier: null,
    isPremium: false,
    priorityRank: 0,
    rawImport: {},
    ...overrides,
  };
}

function makeFakeSupabase() {
  let existingRows: ExistingRow[] = [];
  let insertError: { message: string } | null = null;
  let upsertError: { message: string } | null = null;

  const contactImportsInserts: unknown[] = [];
  const contactImportsUpdates: unknown[] = [];
  const contactUpserts: unknown[] = [];
  const contactSelectKeys: string[][] = [];

  const from = (table: string) => {
    if (table === 'contacts') {
      return {
        select: () => ({
          in: async (_col: string, values: string[]) => {
            contactSelectKeys.push(values);
            return { data: existingRows, error: null };
          },
        }),
        upsert: async (payload: unknown) => {
          contactUpserts.push(payload);
          return { error: upsertError };
        },
      };
    }
    return {
      insert: (payload: unknown) => {
        contactImportsInserts.push(payload);
        return {
          select: () => ({
            single: async () => ({ data: { id: 'import-0001' }, error: insertError }),
          }),
        };
      },
      update: (payload: unknown) => {
        contactImportsUpdates.push(payload);
        return { eq: () => Promise.resolve({ error: upsertError }) };
      },
    };
  };

  return {
    supabase: { from } as unknown as SupabaseClient,
    contactImportsInserts,
    contactImportsUpdates,
    contactUpserts,
    contactSelectKeys,
    setExistingRows(rows: ExistingRow[]) {
      existingRows = rows;
    },
    setInsertError(error: { message: string } | null) {
      insertError = error;
    },
    setUpsertError(error: { message: string } | null) {
      upsertError = error;
    },
  };
}

const BASE_INPUT = {
  clientId: 'client-1',
  userId: 'user-1',
  filename: 'leads.xlsx',
  clean: [] as CleanedContact[],
  invalid: [] as CleanedContact[],
  review: [] as CleanedContact[],
  duplicate: [] as CleanedContact[],
};

describe('writeContacts', () => {
  it('inserts a processing contact_imports row with raw count, then completes it', async () => {
    const fake = makeFakeSupabase();
    const importId = await writeContacts(fake.supabase, {
      ...BASE_INPUT,
      clean: [clean()],
      invalid: [clean({ phoneE164: 'EMPTY', status: 'invalid', invalidReason: 'empty' })],
      duplicate: [clean({ phoneE164: '+9990000000', status: 'duplicate' })],
    });

    expect(importId).toBe('import-0001');
    expect(fake.contactImportsInserts).toHaveLength(1);
    expect(fake.contactImportsInserts[0]).toMatchObject({
      client_id: 'client-1',
      filename: 'leads.xlsx',
      row_count_raw: 3,
      status: 'processing',
      imported_by: 'user-1',
    });

    const completed = fake.contactImportsUpdates.at(-1);
    expect(completed).toMatchObject({
      row_count_clean: 1,
      row_count_invalid: 1,
      row_count_review: 0,
      row_count_duplicate: 1,
      status: 'completed',
    });
    expect((completed as Record<string, unknown>).completed_at).toBeTruthy();
  });

  it('never writes downstream CRM state on conflict', async () => {
    const fake = makeFakeSupabase();
    await writeContacts(fake.supabase, {
      ...BASE_INPUT,
      clean: [clean({ fullName: 'Alice', email: 'alice@outlook.com' })],
    });

    const row = (fake.contactUpserts[0] as Record<string, unknown>[])[0];
    const forbidden = [
      'lead_score',
      'pipeline_stage',
      'requirements',
      'follow_up_at',
      'lead_source',
      'hot_flagged_at',
      'opted_out',
      'opted_out_at',
      'opted_out_source',
      'opt_out_message_id',
      'consent_source',
      'consent_at',
      'human_controlled',
      'assigned_to',
      'last_contacted_at',
      'last_inbound_at',
      'created_at',
    ];
    for (const key of forbidden) expect(row).not.toHaveProperty(key);
  });

  it('counts duplicates but never upserts them', async () => {
    const fake = makeFakeSupabase();
    await writeContacts(fake.supabase, {
      ...BASE_INPUT,
      clean: [clean()],
      duplicate: [clean({ phoneE164: '+97150AAAAAA', status: 'duplicate' })],
    });

    const upserted = fake.contactUpserts.flat() as Record<string, unknown>[];
    expect(upserted.every((r) => r.phone_e164 !== '+97150AAAAAA')).toBe(true);
    expect((fake.contactImportsUpdates.at(-1) as Record<string, unknown>).row_count_duplicate).toBe(1);
  });

  it('upserts in batches of exactly 100', async () => {
    const fake = makeFakeSupabase();
    const bulk = Array.from({ length: 250 }, (_, i) =>
      clean({ phoneE164: `+9715000000${String(i).padStart(3, '0')}` }),
    );
    await writeContacts(fake.supabase, { ...BASE_INPUT, clean: bulk });

    expect(fake.contactUpserts.map((b) => (b as unknown[]).length)).toEqual([100, 100, 50]);
    expect(fake.contactSelectKeys.map((k) => k.length)).toEqual([100, 100, 50]);
  });

  it('collapses shared invalid best-effort keys before one upsert statement', async () => {
    const fake = makeFakeSupabase();
    await writeContacts(fake.supabase, {
      ...BASE_INPUT,
      invalid: [
        clean({ phoneE164: 'EMPTY', status: 'invalid', invalidReason: 'empty' }),
        clean({ phoneE164: 'EMPTY', status: 'invalid', invalidReason: 'empty' }),
        clean({ phoneE164: '123', status: 'invalid', invalidReason: 'too_short' }),
      ],
    });

    const upserted = fake.contactUpserts.flat() as Record<string, unknown>[];
    expect(upserted.filter((r) => r.phone_e164 === 'EMPTY')).toHaveLength(1);
    expect(upserted.filter((r) => r.phone_e164 === '123')).toHaveLength(1);
    // Counts still reflect the full input partition, not the collapse.
    expect((fake.contactImportsUpdates.at(-1) as Record<string, unknown>).row_count_invalid).toBe(3);
  });

  it('keeps richer existing full_name/email when incoming values are null', async () => {
    const fake = makeFakeSupabase();
    fake.setExistingRows([
      { phone_e164: '+971501234567', full_name: 'Alice', email: 'alice@outlook.com' },
    ]);
    await writeContacts(fake.supabase, {
      ...BASE_INPUT,
      clean: [clean({ phoneE164: '+971501234567', fullName: null, email: null })],
    });

    const row = (fake.contactUpserts[0] as Record<string, unknown>[])[0];
    expect(row.full_name).toBe('Alice');
    expect(row.email).toBe('alice@outlook.com');
  });

  it('marks the import failed and rethrows on upsert error', async () => {
    const fake = makeFakeSupabase();
    fake.setUpsertError({ message: 'contacts constraint violated' });

    await expect(
      writeContacts(fake.supabase, { ...BASE_INPUT, clean: [clean()] }),
    ).rejects.toThrow(/Failed to upsert contacts/);

    const failed = fake.contactImportsUpdates.at(-1);
    expect(failed).toMatchObject({ status: 'failed' });
    expect((failed as Record<string, unknown>).error_message).toContain('contacts constraint violated');
  });
});