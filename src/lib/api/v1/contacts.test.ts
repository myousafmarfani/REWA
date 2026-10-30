import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  serializeContact,
  findOrCreateContact,
  ContactError,
} from './contacts';

type InsertRecord = { table: string; values: Record<string, unknown> };

/**
 * Minimal chainable stub: `.like()` returns `existing` (so the dedupe
 * lookup misses → create), and every `.insert()` payload is captured
 * so a test can assert the exact columns written.
 */
function makeDb(existing: unknown[], created: { id: string }) {
  const inserts: InsertRecord[] = [];
  let table = '';
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    like: () => Promise.resolve({ data: existing, error: null }),
    insert: (values: Record<string, unknown>) => {
      inserts.push({ table, values });
      return builder;
    },
    single: () => Promise.resolve({ data: created, error: null }),
  };
  const db = {
    from: (t: string) => {
      table = t;
      return builder;
    },
  } as unknown as SupabaseClient;
  return { db, inserts };
}

describe('serializeContact', () => {
  it('maps the rewa columns onto the public contact shape', () => {
    const row = {
      id: 'c1',
      client_id: 'cl1',
      phone_e164: '+14155550123',
      full_name: 'Jane',
      email: 'jane@acme.test',
      status: 'clean',
      lead_score: 'warm',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
    };
    expect(serializeContact(row)).toEqual({
      id: 'c1',
      phone: '+14155550123',
      name: 'Jane',
      email: 'jane@acme.test',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
    });
  });

  it('nulls a missing full_name / email rather than dropping the keys', () => {
    const row = {
      id: 'c2',
      phone_e164: '+1',
      full_name: null,
      email: null,
      created_at: 'a',
      updated_at: 'b',
    };
    expect(serializeContact(row)).toEqual({
      id: 'c2',
      phone: '+1',
      name: null,
      email: null,
      created_at: 'a',
      updated_at: 'b',
    });
  });
});

describe('findOrCreateContact', () => {
  it('rejects a non-E.164 phone with a 400 ContactError', async () => {
    const noopDb = {} as SupabaseClient;
    await expect(
      findOrCreateContact(noopDb, 'cl1', { phone: 'not-a-number' })
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      findOrCreateContact(noopDb, 'cl1', { phone: 'not-a-number' })
    ).rejects.toBeInstanceOf(ContactError);
  });

  it('writes the rewa columns (client_id / phone_e164 / full_name)', async () => {
    const { db, inserts } = makeDb([], { id: 'new1' });
    const res = await findOrCreateContact(db, 'cl1', {
      phone: '+14155550123',
      name: 'Jane',
    });
    expect(res).toEqual({ id: 'new1', created: true });
    expect(inserts).toEqual([
      {
        table: 'contacts',
        values: {
          client_id: 'cl1',
          phone_e164: '+14155550123',
          full_name: 'Jane',
          email: null,
        },
      },
    ]);
  });
});
