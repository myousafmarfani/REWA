// ============================================================
// Shared contact logic for the public API (v1) contact endpoints.
//
// Kept out of the route files so `GET/POST /api/v1/contacts` and
// `GET/PATCH /api/v1/contacts/{id}` share one serializer and one
// find-or-create (built on the same `findExistingContact` dedupe the
// webhook and send path use).
//
// Rewired to the rewa schema (MEMORY.md entry 19):
//   - tenancy      = `client_id` (the "account id" callers pass is this)
//   - number       = `contacts.phone_e164`
//   - label        = `contacts.full_name`
//   - no tags      = `tags`/`contact_tags` are retired wacrm code
//
// The public JSON field names (`phone`, `name`) are unchanged — they
// are simply mapped onto the rewa columns on the way out.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { isValidE164, toE164 } from '@/lib/whatsapp/phone-utils';

/** Row select for a single contact — no embedded joins (no tags). */
export const CONTACT_SELECT = '*';

export interface ApiContact {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  created_at: string;
  updated_at: string;
}

/** Thrown by the helpers below; routes map `.status`/`.message`. */
export class ContactError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ContactError';
    this.status = status;
  }
}

/** Map a rewa `contacts` row onto the public contact shape. */
export function serializeContact(row: Record<string, unknown>): ApiContact {
  return {
    id: row.id as string,
    phone: (row.phone_e164 as string) ?? '',
    name: (row.full_name as string | null) ?? null,
    email: (row.email as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

/**
 * Resolve the audit `user_id` for API-created rows — the SINGLE source
 * of truth used by every public-API write (contacts, messages,
 * broadcasts, resolve-conversation), so the same key's writes are
 * always attributed to the same human.
 *
 * NOTE: this reads wacrm-era `whatsapp_config`/`accounts` (absent from
 * the rewa schema) and exists only for the broadcast/v1 routes that are
 * still to be migrated. rewa contacts carry no audit `user_id` — the
 * find-or-create below does not use it. Retained for spec 6.
 */
export async function resolveAuditUserId(
  db: SupabaseClient,
  accountId: string
): Promise<string> {
  const { data: config } = await db
    .from('whatsapp_config')
    .select('user_id')
    .eq('account_id', accountId)
    .maybeSingle();
  const configOwner = config?.user_id as string | undefined;
  if (configOwner) return configOwner;

  const { data: account } = await db
    .from('accounts')
    .select('owner_user_id')
    .eq('id', accountId)
    .maybeSingle();
  const owner = account?.owner_user_id as string | undefined;
  if (!owner) {
    throw new ContactError('Account owner could not be resolved', 500);
  }
  return owner;
}

export interface ContactInput {
  phone: string;
  name?: string | null;
  email?: string | null;
}

/**
 * Find (by fuzzy phone match) or create a contact in `clientId`.
 * Returns the contact id and whether it was created. Reuses the shared
 * `findExistingContact` dedupe + unique-violation race backstop so an
 * API-created contact is indistinguishable from a webhook-created one.
 *
 * rewa has no `user_id` audit column on contacts, so writes are keyed
 * purely by `client_id` + `phone_e164`.
 */
export async function findOrCreateContact(
  db: SupabaseClient,
  clientId: string,
  input: ContactInput
): Promise<{ id: string; created: boolean }> {
  const phoneE164 = toE164(input.phone);
  if (!isValidE164(phoneE164)) {
    throw new ContactError(
      "'phone' must be a valid phone number in E.164 format (e.g. +14155550123)",
      400
    );
  }

  const existing = await findExistingContact(db, clientId, phoneE164);
  if (existing) return { id: existing.id, created: false };

  const { data: created, error } = await db
    .from('contacts')
    .insert({
      client_id: clientId,
      phone_e164: phoneE164,
      full_name: input.name ?? phoneE164,
      email: input.email ?? null,
    })
    .select('id')
    .single();

  if (error || !created) {
    // Lost a race against a concurrent create — the unique index
    // rejected the duplicate. Re-resolve to the winner.
    if (isUniqueViolation(error)) {
      const raced = await findExistingContact(db, clientId, phoneE164);
      if (raced) return { id: raced.id, created: false };
    }
    console.error('[api/v1/contacts] create error:', error);
    throw new ContactError('Failed to create contact', 500);
  }

  return { id: created.id, created: true };
}

/** Fetch + serialize a single contact scoped to the client, or null. */
export async function getContactById(
  db: SupabaseClient,
  clientId: string,
  contactId: string
): Promise<ApiContact | null> {
  const { data, error } = await db
    .from('contacts')
    .select(CONTACT_SELECT)
    .eq('id', contactId)
    .eq('client_id', clientId)
    .maybeSingle();
  if (error || !data) return null;
  return serializeContact(data as Record<string, unknown>);
}
