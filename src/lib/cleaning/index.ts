import type { SupabaseClient } from '@supabase/supabase-js';

import { classifyEmail, classifyNumber, type NumberClassification } from './classifier';
import { deduplicateContacts } from './deduplicator';
import { writeContacts } from './importer';
import { parseContactFile } from './loader';
import { bestEffortKey, normalise } from './normaliser';
import { assignPriorityRanks } from './sorter';
import type {
  CleanedContact,
  CleaningCounts,
  CleaningPartitions,
  EmailType,
  InvalidReason,
  ParsedContact,
} from './types';

export * from './types';
export * from './normaliser';
export * from './deduplicator';
export * from './classifier';
export * from './sorter';
export * from './importer';
export * from './loader';

export interface CleanPipelineParams {
  buffer: ArrayBuffer;
  filename: string;
  defaultCountry: string;
  regionPriority: string[];
}

export interface RunAndImportParams extends CleanPipelineParams {
  clientId: string;
  userId: string;
}

export interface RunAndImportResult extends CleaningPartitions {
  importId: string;
  counts: CleaningCounts;
}

interface PipelineContact extends ParsedContact {
  e164: string | null;
  invalidReason: InvalidReason | null;
  emailType: EmailType | null;
  classification: NumberClassification | null; // null → invalid row
}

function toCleaned(contact: PipelineContact, status: CleanedContact['status']): CleanedContact {
  if (contact.e164 === null) {
    return {
      // Invalid rows keep a best-effort key for the NOT NULL unique column
      // (EMPTY sentinel / digits-only / cleaned raw string).
      phoneE164: bestEffortKey(contact.invalidReason, contact.rawPhone),
      fullName: contact.rawName,
      email: contact.rawEmail,
      emailType: contact.emailType,
      status,
      invalidReason: contact.invalidReason,
      numberType: 'unknown',
      region: null,
      carrier: null,
      isPremium: false,
      priorityRank: null,
      rawImport: contact.raw,
    };
  }
  const cls =
    contact.classification ?? { numberType: 'unknown' as const, region: null, carrier: null, isPremium: false };
  return {
    phoneE164: contact.e164,
    fullName: contact.rawName,
    email: contact.rawEmail,
    emailType: contact.emailType,
    status,
    invalidReason: null,
    numberType: cls.numberType,
    region: cls.region,
    carrier: cls.carrier,
    isPremium: cls.isPremium,
    priorityRank: null,
    rawImport: contact.raw,
  };
}

/**
 * Full cleaning pipeline without persistence: parse → normalise →
 * classify → dedupe → priority ranks. Returns the four partitions.
 */
export async function runCleanPipeline(
  params: CleanPipelineParams,
): Promise<CleaningPartitions> {
  const { rows } = parseContactFile(params.buffer, params.filename);

  const pending: PipelineContact[] = [];
  for (const row of rows) {
    const rawEmail = typeof row.rawEmail === 'string' ? row.rawEmail.trim() : '';
    const emailType = rawEmail === '' ? null : classifyEmail(rawEmail);
    const { e164, reason } = normalise(row.rawPhone, params.defaultCountry);
    pending.push(
      e164 === null
        ? { ...row, e164, invalidReason: reason ?? 'parse_failed', emailType, classification: null }
        : { ...row, e164, invalidReason: null, emailType, classification: classifyNumber(e164) },
    );
  }

  const invalid = pending
    .filter((c) => c.e164 === null)
    .map((c) => toCleaned(c, 'invalid'));

  const { clean, duplicates, reviews } = deduplicateContacts(
    pending.filter((c) => c.e164 !== null),
  );

  const cleanContacts = clean.map((c) => toCleaned(c, 'clean'));
  const reviewContacts = reviews.map((c) => toCleaned(c, 'review'));
  const duplicateContacts = duplicates.map((c) => toCleaned(c, 'duplicate'));

  return {
    clean: assignPriorityRanks(cleanContacts, params.regionPriority),
    invalid,
    review: assignPriorityRanks(reviewContacts, params.regionPriority),
    duplicate: duplicateContacts,
  };
}

/**
 * runCleanPipeline + persistence via writeContacts. Returns partitions,
 * the new importId and the response counts.
 */
export async function runAndImport(
  supabase: SupabaseClient,
  params: RunAndImportParams,
): Promise<RunAndImportResult> {
  const partitions = await runCleanPipeline(params);
  const importId = await writeContacts(supabase, {
    clientId: params.clientId,
    userId: params.userId,
    filename: params.filename,
    ...partitions,
  });
  const counts: CleaningCounts = {
    raw:
      partitions.clean.length +
      partitions.invalid.length +
      partitions.review.length +
      partitions.duplicate.length,
    clean: partitions.clean.length,
    invalid: partitions.invalid.length,
    review: partitions.review.length,
    duplicate: partitions.duplicate.length,
  };
  return { ...partitions, importId, counts };
}