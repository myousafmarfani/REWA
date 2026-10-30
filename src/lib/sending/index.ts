/**
 * sendWhatsAppMessage — the single sending entry point used by the agent
 * (STEP 9 handoff) and by outbound orchestration. Enforces, in order:
 *
 *   1. Hard opted-out gate (MEMORY entry 8) — opted-out contacts are
 *      never sent to, at any layer, no matter what prompted the send.
 *   2. Per-client config loading (wa_phone_number_id + wa_access_token),
 *      always decrypted from client_config — never from env vars.
 *   3. Compliance window routing: free-form text ONLY inside the open
 *      24-hour window; campaign sends require an approved template.
 *   4. Rate limiting via the shared per-phone-number token bucket.
 *
 * On success it records `contacts.last_contacted_at` and, when a
 * persisted outbound messages row is supplied, flips that row from
 * 'pending' to 'sent' with the Meta message id (the agent handoff
 * contract). On a blocked-recipient error it records the opt-out with
 * provenance `opted_out_source='blocked'` before rethrowing.
 */

import { supabaseAdmin } from '@/lib/supabase/admin';
import { decrypt } from '@/lib/whatsapp/encryption';
import { acquireSendSlot } from './rate-limiter';
import { sendTemplateMessage, sendTextMessage } from './client';
import { assertWindowOpen } from './window';
import {
  DeterministicSendingError,
  OptedOutError,
  SendingNotConfiguredError,
  WaSendError,
  type MessageType,
  type SendResult,
  type TemplateSendSpec,
} from './types';

export interface SendWhatsAppMessageParams {
  clientId: string;
  contactId: string;
  messageBody: string;
  messageType: MessageType;
  /** Required when messageType === 'campaign'; ignored otherwise. */
  template?: TemplateSendSpec;
  /** Persisted outbound messages row to move from 'pending' → 'sent'. */
  messageId?: string;
}

export async function sendWhatsAppMessage(
  params: SendWhatsAppMessageParams
): Promise<SendResult> {
  try {
    return await sendWhatsAppMessageInner(params);
  } catch (error) {
    // Reconcile consent/validity state from Meta's own error signals
    // (compliance finding: blocked must never be recorded as 'manual').
    if (error instanceof WaSendError) {
      if (error.isBlockedContact) {
        await recordBlockedOptOut(params.clientId, params.contactId);
      } else if (error.isInvalidNumber) {
        await recordInvalidNumber(params.clientId, params.contactId);
      }
    }
    if (params.messageId) {
      await markMessageFailed(params.clientId, params.messageId);
    }
    throw error;
  }
}

async function sendWhatsAppMessageInner(
  params: SendWhatsAppMessageParams
): Promise<SendResult> {
  const { clientId, contactId, messageBody, messageType } = params;

  // 1. Load contact + hard opted-out gate.
  const { data: contact, error: contactError } = await supabaseAdmin()
    .from('contacts')
    .select('id, phone_e164, opted_out, last_inbound_at')
    .eq('id', contactId)
    .eq('client_id', clientId)
    .maybeSingle();

  if (contactError || !contact) {
    throw new DeterministicSendingError(
      `Contact ${contactId} not found for client ${clientId} (send aborted)`
    );
  }
  if (contact.opted_out) {
    throw new OptedOutError(
      `Contact ${contactId} is opted out — send suppressed by hard gate`
    );
  }

  // 2. Load + decrypt per-client credentials.
  const { data: config, error: configError } = await supabaseAdmin()
    .from('client_config')
    .select('wa_phone_number_id, wa_access_token')
    .eq('client_id', clientId)
    .maybeSingle();

  if (configError || !config?.wa_phone_number_id || !config.wa_access_token) {
    throw new SendingNotConfiguredError(
      `Client ${clientId} has no WhatsApp credentials in client_config`
    );
  }
  let accessToken: string;
  try {
    accessToken = decrypt(config.wa_access_token);
  } catch {
    throw new SendingNotConfiguredError(
      `Client ${clientId} WhatsApp access token could not be decrypted`
    );
  }

  const to = contact.phone_e164;

  // 3. Compliance window routing.
  let result: SendResult;
  if (messageType === 'campaign') {
    if (!params.template) {
      throw new DeterministicSendingError(
        'Campaign send called without a template spec'
      );
    }
    await acquireSendSlot(config.wa_phone_number_id);
    result = await sendTemplateMessage({
      phoneNumberId: config.wa_phone_number_id,
      accessToken,
      to,
      templateName: params.template!.name,
      languageCode: params.template!.language,
      components: params.template!.components,
    });
  } else {
    assertWindowOpen(contact.last_inbound_at, 'text');
    await acquireSendSlot(config.wa_phone_number_id);
    result = await sendTextMessage({
      phoneNumberId: config.wa_phone_number_id,
      accessToken,
      to,
      body: messageBody,
    });
  }

  // 4. Post-send bookkeeping.
  await touchContactAfterSend(clientId, contactId);
  if (params.messageId) {
    await markMessageSent(clientId, params.messageId, result.waMessageId);
  }
  return result;
}

/**
 * Success side effects shared by every send path. last_contacted_at is
 * set on EVERY successful outbound send (spec 4 A4 / carry-forward).
 */
async function touchContactAfterSend(
  clientId: string,
  contactId: string
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabaseAdmin()
    .from('contacts')
    .update({ last_contacted_at: now, updated_at: now })
    .eq('id', contactId)
    .eq('client_id', clientId);
  if (error) {
    console.error('[sending] last_contacted_at update failed', {
      clientId,
      contactId,
      error: error.message,
    });
  }
}

async function markMessageSent(
  clientId: string,
  messageId: string,
  waMessageId: string
): Promise<void> {
  const { error } = await supabaseAdmin()
    .from('messages')
    .update({ status: 'sent', wa_message_id: waMessageId })
    .eq('id', messageId)
    .eq('client_id', clientId)
    .eq('status', 'pending');
  if (error) {
    console.error('[sending] outbound message row could not be marked sent', {
      clientId,
      messageId,
      error: error.message,
    });
  }
}

async function markMessageFailed(
  clientId: string,
  messageId: string
): Promise<void> {
  const { error } = await supabaseAdmin()
    .from('messages')
    .update({ status: 'failed' })
    .eq('id', messageId)
    .eq('client_id', clientId)
    .eq('status', 'pending');
  if (error) {
    console.error('[sending] outbound message row could not be marked failed', {
      clientId,
      messageId,
      error: error.message,
    });
  }
}

/**
 * Meta told us this recipient opted out / blocked the number. This is
 * consent evidence with provenance (spec 1 A7) — record it explicitly.
 */
async function recordBlockedOptOut(
  clientId: string,
  contactId: string
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabaseAdmin()
    .from('contacts')
    .update({
      opted_out: true,
      opted_out_at: now,
      opted_out_source: 'blocked',
      updated_at: now,
    })
    .eq('id', contactId)
    .eq('client_id', clientId);
  if (error) {
    console.error('[sending] blocked opt-out could not be recorded', {
      clientId,
      contactId,
      error: error.message,
    });
  }
}

/** Undeliverable number (not a block) → contacts.status='invalid'. */
async function recordInvalidNumber(
  clientId: string,
  contactId: string
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabaseAdmin()
    .from('contacts')
    .update({
      status: 'invalid',
      invalid_reason: 'parse_failed',
      updated_at: now,
    })
    .eq('id', contactId)
    .eq('client_id', clientId);
  if (error) {
    console.error('[sending] invalid-number state could not be recorded', {
      clientId,
      contactId,
      error: error.message,
    });
  }
}
