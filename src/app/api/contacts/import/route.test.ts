import { afterEach, describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';

import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}));

// Never exercises the service-role fallback (scoped config read succeeds),
// but keeps the module-load surface inert.
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { region_priority: [] }, error: null }),
        }),
      }),
    }),
  }),
}));

import { createClient } from '@/lib/supabase/server';
import { POST } from './route';

const mockedCreateClient = vi.mocked(createClient);

function toArrayBuffer(data: unknown): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  const buf = data as { buffer: ArrayBuffer; byteOffset: number; byteLength: number };
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function xlsxBuffer(rows: unknown[][]): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
  return toArrayBuffer(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
}

interface SupabaseOverrides {
  getUser?: () => { data: { user: { id: string } | null }; error: { message: string } | null };
  usersMaybeSingle?: () => {
    data: { client_id: string | null; role: string | null } | null;
    error: { message: string } | null;
  };
  clientsMaybeSingle?: () => {
    data: { id: string; name: string } | null;
    error: { message: string } | null;
  };
  configMaybeSingle?: () => {
    data: { region_priority: string[] };
    error: { message: string } | null;
  };
}

function makeSupabaseMock(overrides: SupabaseOverrides = {}) {
  const getUser = overrides.getUser ?? (() => ({ data: { user: { id: 'user-1' } }, error: null }));
  const usersMaybeSingle =
    overrides.usersMaybeSingle ??
    (() => ({ data: { client_id: 'client-1', role: 'admin' }, error: null }));
  const clientsMaybeSingle =
    overrides.clientsMaybeSingle ??
    (() => ({ data: { id: 'client-1', name: 'Client One' }, error: null }));
  const configMaybeSingle =
    overrides.configMaybeSingle ?? (() => ({ data: { region_priority: ['UAE'] }, error: null }));

  const from = (table: string) => {
    if (table === 'users') {
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => usersMaybeSingle() }) }),
      };
    }
    if (table === 'clients') {
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => clientsMaybeSingle() }) }),
      };
    }
    if (table === 'client_config') {
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => configMaybeSingle() }) }),
      };
    }
    // contacts + contact_imports — write path always succeeds.
    return {
      select: () => ({ in: () => Promise.resolve({ data: [], error: null }) }),
      insert: (payload: unknown) => ({
        select: () => ({
          single: async () => ({ data: { id: 'import-0001' }, error: null }),
        }),
      }),
      upsert: async (_payload: unknown) => ({ error: null }),
      update: (_payload: unknown) => ({ eq: () => Promise.resolve({ error: null }) }),
    };
  };

  return {
    auth: { getUser: async () => getUser() },
    from,
  } as unknown as SupabaseClient;
}

async function importRequest(body: FormData, mime = 'multipart/form-data') {
  return POST(new Request('http://localhost/api/contacts/import', { method: 'POST', body }));
}

function formWithFile(rows: unknown[][], filename = 'leads.xlsx'): FormData {
  const form = new FormData();
  form.append('file', new File([xlsxBuffer(rows)], filename, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  return form;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/contacts/import', () => {
  it('derives client_id from the auth session and returns counts', async () => {
    (mockedCreateClient).mockResolvedValue(makeSupabaseMock());

    const res = await importRequest(
      formWithFile([
        ['Phone', 'Name'],
        ['+971501234567', 'Alice'],
        ['123', 'Bob'],
      ]),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.import_id).toBeTruthy();
    expect(body.counts).toEqual({ raw: 2, clean: 1, invalid: 1, review: 0, duplicate: 0 });
  });

  it('rejects unauthenticated requests with 401', async () => {
    (mockedCreateClient).mockResolvedValue(
      makeSupabaseMock({ getUser: () => ({ data: { user: null }, error: { message: 'no' } }) }),
    );

    const res = await importRequest(formWithFile([['Phone'], ['+971501234567']]));
    expect(res.status).toBe(401);
  });

  it('rejects a session with no users row via 403', async () => {
    (mockedCreateClient).mockResolvedValue(
      makeSupabaseMock({
        usersMaybeSingle: () => ({ data: null, error: { message: 'no profile' } }),
      }),
    );

    const res = await importRequest(formWithFile([['Phone'], ['+971501234567']]));
    expect(res.status).toBe(403);
  });

  it('rejects an agent role below admin with 403', async () => {
    (mockedCreateClient).mockResolvedValue(
      makeSupabaseMock({
        usersMaybeSingle: () => ({ data: { client_id: 'client-1', role: 'agent' }, error: null }),
      }),
    );

    const res = await importRequest(formWithFile([['Phone'], ['+971501234567']]));
    expect(res.status).toBe(403);
  });

  it('rejects unsupported file extensions with 400', async () => {
    (mockedCreateClient).mockResolvedValue(makeSupabaseMock());

    const res = await importRequest(formWithFile([['Phone'], ['+971501234567']], 'leads.txt'));
    expect(res.status).toBe(400);
  });

  it('rejects an invalid default_country with 400', async () => {
    (mockedCreateClient).mockResolvedValue(makeSupabaseMock());

    const form = formWithFile([['Phone'], ['+971501234567']]);
    form.set('default_country', 'not-a-country');
    const res = await importRequest(form);
    expect(res.status).toBe(400);
  });
});