// ============================================================
// Resolve (or create) the conversation for a phone number.
//
// The dashboard composer always has a `conversation_id` in hand. The
// public API doesn't — an external automation knows a *phone number*,
// not an internal UUID. This helper bridges that: given an E.164
// phone, it finds-or-creates the contact and its conversation so the
// shared `sendMessageToConversation` core can run unchanged.
//
// It deliberately reuses the exact find-or-create logic the inbound
// webhook uses (the `findExistingContact` dedupe helper, the
// one-conversation-per-(client, contact) convention) so a contact
// created via the API is indistinguishable from one created by an
// inbound message.
//
// Rewired to the rewa schema (MEMORY.md entry 19): tenancy is
// `client_id`, the stored number is `contacts.phone_e164`, the label is
// `contacts.full_name`, WhatsApp credentials live on `client_config`
// (not `whatsapp_config`), and there is no audit `user_id` on contacts
// or conversations — so no audit attribution is needed here.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { isValidE164, toE164 } from '@/lib/whatsapp/phone-utils';
import { SendMessageError } from '@/lib/whatsapp/send-message';

export interface ResolvedConversation {
  conversationId: string;
  contactId: string;
  /** True if this call created the contact (vs matched an existing one). */
  contactCreated: boolean;
}

/**
 * Find or create the contact + conversation for `phone` within
 * `clientId`. Throws `SendMessageError` (shared with the send core,
 * so the route maps one error family) on a bad phone, a missing
 * WhatsApp config, or a DB failure.
 */
export async function resolveConversationByPhone(
  db: SupabaseClient,
  clientId: string,
  phone: string,
  name?: string | null
): Promise<ResolvedConversation> {
  const phoneE164 = toE164(phone);
  if (!isValidE164(phoneE164)) {
    throw new SendMessageError(
      'bad_request',
      "'to' must be a valid phone number in E.164 format (e.g. +14155550123)",
      400
    );
  }

  // Fail fast (and create nothing) when the client has no WhatsApp
  // connected — the same error the send would raise anyway. rewa holds
  // these on client_config (see src/trigger/send-campaign.ts).
  const { data: config } = await db
    .from('client_config')
    .select('wa_phone_number_id, wa_access_token')
    .eq('client_id', clientId)
    .maybeSingle();
  if (!config?.wa_phone_number_id || !config.wa_access_token) {
    throw new SendMessageError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.',
      400
    );
  }

  // ---- contact -------------------------------------------------
  let contactId: string;
  let contactCreated = false;

  const existing = await findExistingContact(db, clientId, phoneE164);
  if (existing) {
    contactId = existing.id;
    if (name && name !== existing.name) {
      await db
        .from('contacts')
        .update({ full_name: name, updated_at: new Date().toISOString() })
        .eq('id', existing.id);
    }
  } else {
    const { data: created, error: createErr } = await db
      .from('contacts')
      .insert({
        client_id: clientId,
        phone_e164: phoneE164,
        full_name: name || phoneE164,
      })
      .select('id')
      .single();

    if (createErr || !created) {
      // Lost a race against a concurrent inbound/API create — the
      // unique (client_id, phone_e164) index rejected the duplicate.
      // Re-resolve.
      if (isUniqueViolation(createErr)) {
        const raced = await findExistingContact(db, clientId, phoneE164);
        if (raced) {
          contactId = raced.id;
        } else {
          throw new SendMessageError(
            'db_error',
            'Failed to create contact',
            500
          );
        }
      } else {
        console.error(
          '[resolve-conversation] contact create error:',
          createErr
        );
        throw new SendMessageError('db_error', 'Failed to create contact', 500);
      }
    } else {
      contactId = created.id;
      contactCreated = true;
    }
  }

  // ---- conversation -------------------------------------------
  // One conversation per (client, contact) — same convention as the
  // webhook. Order oldest-first and take one row rather than
  // `.maybeSingle()`, which errors on ≥2 rows: if duplicates predate the
  // unique index, we resolve to the canonical survivor instead of
  // falling through and creating yet another (issue #363).
  const conversationId = await findOrCreateConversationRow(
    db,
    clientId,
    contactId
  );

  return { conversationId, contactId, contactCreated };
}

/**
 * Find (oldest-first) or create the single conversation for
 * `(clientId, contactId)`. Handles the unique-index race the same way
 * the inbound webhook does: on a 23505 from a concurrent create,
 * re-resolve the winning row rather than failing the send.
 */
async function findOrCreateConversationRow(
  db: SupabaseClient,
  clientId: string,
  contactId: string
): Promise<string> {
  const { data: existing, error: findErr } = await db
    .from('conversations')
    .select('id')
    .eq('client_id', clientId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1);

  if (findErr) {
    console.error('[resolve-conversation] conversation lookup error:', findErr);
    throw new SendMessageError('db_error', 'Failed to resolve conversation', 500);
  }

  if (existing && existing.length > 0) {
    return existing[0].id;
  }

  const { data: newConv, error: convErr } = await db
    .from('conversations')
    .insert({
      client_id: clientId,
      contact_id: contactId,
    })
    .select('id')
    .single();

  if (convErr || !newConv) {
    if (isUniqueViolation(convErr)) {
      const { data: raced } = await db
        .from('conversations')
        .select('id')
        .eq('client_id', clientId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1);
      if (raced && raced.length > 0) {
        return raced[0].id;
      }
    }
    console.error('[resolve-conversation] conversation create error:', convErr);
    throw new SendMessageError('db_error', 'Failed to create conversation', 500);
  }

  return newConv.id;
}
