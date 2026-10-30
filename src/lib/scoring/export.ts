import * as XLSX from 'xlsx';

import { supabaseAdmin } from '@/lib/supabase/admin';
import type { ContactExportRow } from './types';

/**
 * Continuous contacts export (spec 5, MEMORY entry 9): reflects the
 * CURRENT state of every contact — score, stage, signals, consent —
 * for the client. Same column contract whether it is streamed by
 * GET /api/contacts/export or written by the daily scheduled task.
 */

const EXPORT_COLUMNS = [
  'name',
  'phone',
  'email',
  'lead_score',
  'pipeline_stage',
  'status',
  'number_type',
  'region',
  'priority_rank',
  'human_controlled',
  'opted_out',
  'last_contacted_at',
  'last_reply_at',
  'hot_flagged_at',
] as const;

type ExportContact = {
  full_name: string | null;
  phone_e164: string;
  email: string | null;
  lead_score: string;
  pipeline_stage: string;
  status: string;
  number_type: string | null;
  region: string | null;
  priority_rank: number | null;
  human_controlled: boolean;
  opted_out: boolean;
  last_contacted_at: string | null;
  last_reply_at: string | null;
  hot_flagged_at: string | null;
};

/** Pure mapping — exported for unit tests of the export contract. */
export function toExportRow(contact: ExportContact): ContactExportRow {
  return {
    name: contact.full_name ?? '',
    phone: contact.phone_e164,
    email: contact.email,
    lead_score: contact.lead_score,
    pipeline_stage: contact.pipeline_stage,
    status: contact.status,
    number_type: contact.number_type ?? '',
    region: contact.region,
    priority_rank: contact.priority_rank,
    human_controlled: contact.human_controlled,
    opted_out: contact.opted_out,
    last_contacted_at: contact.last_contacted_at,
    last_reply_at: contact.last_reply_at,
    hot_flagged_at: contact.hot_flagged_at,
  };
}

export async function generateContactsExport(params: {
  clientId: string;
  format: 'csv' | 'xlsx';
}): Promise<Buffer> {
  const { data: contacts, error } = await supabaseAdmin()
    .from('contacts')
    .select(
      `full_name, phone_e164, email, lead_score, pipeline_stage,
       status, number_type, region, priority_rank, human_controlled,
       opted_out, last_contacted_at, last_reply_at, hot_flagged_at`
    )
    .eq('client_id', params.clientId)
    .order('priority_rank', { ascending: true, nullsFirst: false });

  if (error) {
    throw new Error(`contacts export query failed: ${error.message}`);
  }

  const rows = (contacts as ExportContact[]).map(toExportRow);

  // SheetJS: fixed column order regardless of row order/undefined keys.
  const worksheet = XLSX.utils.json_to_sheet(rows, {
    header: [...EXPORT_COLUMNS],
  });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Contacts');

  if (params.format === 'xlsx') {
    return Buffer.from(
      XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })
    );
  }
  return Buffer.from(XLSX.utils.sheet_to_csv(worksheet));
}
