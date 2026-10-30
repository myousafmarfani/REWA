import type { SupabaseClient } from '@supabase/supabase-js';

import { EMPTY_SENTINEL } from './normaliser';
import type { CleanedContact } from './types';

export interface WriteContactsInput {
  clientId: string;
  userId: string;
  filename: string;
  clean: CleanedContact[];
  invalid: CleanedContact[];
  review: CleanedContact[];
  duplicate: CleanedContact[];
}

export interface ImportCounts {
  clean: number;
  invalid: number;
  review: number;
  duplicate: number;
}

const BATCH_SIZE = 100;
const ON_CONFLICT_TARGET = 'client_id,phone_e164';

// Cleaning-owned columns ONLY. Everything else on the contacts row —
// lead_score, pipeline_stage, requirements, follow_up_at, lead_source,
// hot_flagged_at, opted_out*, consent_*, human_controlled, assigned_to,
// last_contacted_at, last_inbound_at, created_at — is deliberately never
// written here, so a re-import can never clobber downstream CRM state.
// The merge for full_name/email happens in JS (see mergeAndUpsert) so a
// null on the incoming row never blanks richer existing data.
function contactRow(
  contact: CleanedContact,
  clientId: string,
  fullName: string | null,
  email: string | null,
): Record<string, unknown> {
  const row: Record<string, unknown> = {
    client_id: clientId,
    phone_e164: contact.phoneE164 ?? EMPTY_SENTINEL,
    full_name: fullName,
    email,
    email_type: contact.emailType,
    status: contact.status,
    invalid_reason: contact.invalidReason,
    number_type: contact.numberType,
    region: contact.region,
    carrier: contact.carrier,
    is_premium: contact.isPremium,
    priority_rank: contact.priorityRank,
    updated_at: new Date().toISOString(),
  };
  if (Object.keys(contact.rawImport).length > 0) {
    row.raw_import = contact.rawImport;
  }
  return row;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Invalid rows collapse under shared best-effort keys (all blank rows →
// 'EMPTY', matching too-short digits → the same string). Without this,
// one upsert statement would list the same ON CONFLICT key twice and
// Postgres rejects it ("cannot affect row a second time"). Keep the first
// occurrence; counts still reflect the full input partition.
function uniqueByKey(contacts: CleanedContact[]): CleanedContact[] {
  const seen = new Set<string>();
  return contacts.filter((c) => {
    const key = c.phoneE164 ?? EMPTY_SENTINEL;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Read existing full_name/email for each batch's keys so the merge keeps
// the richer of existing vs incoming values, then upsert all 100 at once
// (onConflict merge touches only the columns present in the payload).
async function mergeAndUpsert(
  supabase: SupabaseClient,
  clientId: string,
  contacts: CleanedContact[],
): Promise<void> {
  const batches = chunk(contacts, BATCH_SIZE);
  await Promise.all(
    batches.map(async (batch) => {
      const rowKeys: string[] = batch.map((c) => c.phoneE164 ?? EMPTY_SENTINEL);
      const existing = new Map<string, { fullName: string | null; email: string | null }>();
      const { data, error } = await supabase
        .from('contacts')
        .select('phone_e164, full_name, email')
        .in('phone_e164', rowKeys);
      if (error) throw new Error(`Failed to read existing contacts: ${error.message}`);
      for (const row of data ?? []) {
        existing.set(row.phone_e164, {
          fullName: row.full_name,
          email: row.email,
        });
      }

      const payload = batch.map((contact) => {
        const prior = existing.get(contact.phoneE164 ?? EMPTY_SENTINEL);
        const fullName = contact.fullName ?? prior?.fullName ?? null;
        const email = contact.email ?? prior?.email ?? null;
        return contactRow(contact, clientId, fullName, email);
      });
      const { error: upsertError } = await supabase
        .from('contacts')
        .upsert(payload, { onConflict: ON_CONFLICT_TARGET });
      if (upsertError) {
        throw new Error(`Failed to upsert contacts: ${upsertError.message}`);
      }
    }),
  );
}

export async function markImportComplete(
  supabase: SupabaseClient,
  importId: string,
  counts: ImportCounts,
): Promise<void> {
  const { error } = await supabase
    .from('contact_imports')
    .update({
      row_count_clean: counts.clean,
      row_count_invalid: counts.invalid,
      row_count_review: counts.review,
      row_count_duplicate: counts.duplicate,
      status: 'completed',
      completed_at: new Date().toISOString(),
    })
    .eq('id', importId);
  if (error) throw new Error(`Failed to complete import record: ${error.message}`);
}

export async function markImportFailed(
  supabase: SupabaseClient,
  importId: string,
  message: string,
): Promise<void> {
  // Best-effort — never masks the original failure.
  await supabase
    .from('contact_imports')
    .update({ status: 'failed', error_message: message })
    .eq('id', importId);
}

export async function writeContacts(
  supabase: SupabaseClient,
  input: WriteContactsInput,
): Promise<string> {
  const { clean, invalid, review, duplicate } = input;
  const rowCountRaw = clean.length + invalid.length + review.length + duplicate.length;

  const { data: created, error: createError } = await supabase
    .from('contact_imports')
    .insert({
      client_id: input.clientId,
      filename: input.filename,
      row_count_raw: rowCountRaw,
      status: 'processing',
      imported_by: input.userId,
    })
    .select('id')
    .single();
  if (createError || !created) {
    throw new Error(
      `Failed to create contact_imports row: ${createError?.message ?? 'no id returned'}`,
    );
  }
  const importId = created.id as string;

  try {
    // Duplicate rows are bookkeeping only (counted, never upserted).
    // Invalids are key-collapsed so one statement never repeats a key.
    await mergeAndUpsert(supabase, input.clientId, uniqueByKey([...clean, ...review, ...invalid]));
    await markImportComplete(supabase, importId, {
      clean: clean.length,
      invalid: invalid.length,
      review: review.length,
      duplicate: duplicate.length,
    });
    return importId;
  } catch (err) {
    await markImportFailed(
      supabase,
      importId,
      err instanceof Error ? err.message : 'Unknown error',
    );
    throw err;
  }
}