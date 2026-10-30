import { NextResponse } from 'next/server';
import { isSupportedCountry } from 'libphonenumber-js/max';
import type { SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '@/lib/automations/admin-client';
import { groupToDefaultCountry, runAndImport } from '@/lib/cleaning';
import { requireRole, toErrorResponse } from '@/lib/auth/account';

const ALLOWED_EXTENSIONS = ['xlsx', 'xls', 'csv'];

// client_config SELECT is owner/admin-only in RLS. Try the user-scoped
// client first; when that yields nothing (an agent role gets filtered
// out), fall back to a service-role read of ONLY region_priority — never
// wa_access_token / wa_webhook_secret / notification_email.
async function readRegionPriority(
  supabase: SupabaseClient,
  clientId: string,
): Promise<string[]> {
  const { data, error } = await supabase
    .from('client_config')
    .select('region_priority')
    .eq('client_id', clientId)
    .maybeSingle();
  if (!error && Array.isArray(data?.region_priority) && data.region_priority.length > 0) {
    return data.region_priority as string[];
  }

  const { data: adminData } = await supabaseAdmin()
    .from('client_config')
    .select('region_priority')
    .eq('client_id', clientId)
    .maybeSingle();
  return Array.isArray(adminData?.region_priority) ? (adminData.region_priority as string[]) : [];
}

export async function POST(request: Request) {
  // Importing a cleaned contact list mutates the contact table, so it is
  // admin+ only (Spec 6 Layer B: an `agent` may read contacts, not write
  // them). client_id is derived from the resolved session context only —
  // never from the body.
  let ctx;
  try {
    ctx = await requireRole('admin');
  } catch (error) {
    return toErrorResponse(error);
  }
  const supabase = ctx.supabase;
  const userId = ctx.userId;
  const clientId = ctx.accountId;

  const form = await request.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ error: 'Expected multipart/form-data' }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: "'file' is required" }, { status: 400 });
  }
  const filename = file instanceof File ? file.name : '';
  const extension = filename.includes('.')
    ? filename.split('.').pop()!.toLowerCase()
    : '';
  if (!ALLOWED_EXTENSIONS.includes(extension)) {
    return NextResponse.json(
      { error: `Unsupported file type. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}` },
      { status: 400 },
    );
  }

  const explicitCountry =
    typeof form.get('default_country') === 'string'
      ? (form.get('default_country') as string).trim().toUpperCase()
      : '';
  if (explicitCountry && !isSupportedCountry(explicitCountry)) {
    return NextResponse.json(
      { error: `default_country must be a valid ISO2 code, got '${explicitCountry}'` },
      { status: 400 },
    );
  }

  const regionPriority = await readRegionPriority(supabase, clientId);
  // No country-first default (MEMORY.md entry 7): with an empty or
  // unmappable region_priority, local-format numbers degrade to
  // parse_failed while international (+<code>) numbers still parse.
  const defaultCountry =
    explicitCountry ||
    (regionPriority[0] ? groupToDefaultCountry(regionPriority[0]) : '') ||
    '';

  try {
    const result = await runAndImport(supabase, {
      clientId,
      userId,
      filename,
      buffer: await file.arrayBuffer(),
      regionPriority,
      defaultCountry,
    });
    return NextResponse.json({ import_id: result.importId, counts: result.counts });
  } catch (err) {
    console.error('[POST /api/contacts/import] pipeline error:', err);
    return NextResponse.json({ error: 'Import failed' }, { status: 500 });
  }
}