import { NextResponse, after } from 'next/server';
import crypto from 'node:crypto';
import { tasks } from '@trigger.dev/sdk';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { decrypt } from '@/lib/whatsapp/encryption';
import { isOptOut } from '@/lib/compliance/opt-out';

// The enqueue + persistence work runs inside this route's max duration.
// 60s gives headroom ack-ing Meta within their timeout for fan-out.
export const maxDuration = 60;

// ---------------------------------------------------------------------------
// Types for the Meta WhatsApp Business Cloud API webhook payload.
// ---------------------------------------------------------------------------

interface WhatsAppTextMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
}

interface WhatsAppWebhookEntry {
  id: string;
  changes: Array<{
    value: {
      messaging_product: string;
      metadata: { display_phone_number: string; phone_number_id: string };
      messages?: WhatsAppTextMessage[];
      statuses?: Array<{ id: string; status: string }>;
    };
    field: string;
  }>;
}

// ---------------------------------------------------------------------------
// HMAC verification using the per-client decrypted wa_webhook_secret.
// Meta signs the raw request body:  x-hub-signature-256: sha256=<hex>
// ---------------------------------------------------------------------------

function verifyHmac(
  rawBody: string,
  signatureHeader: string | null,
  secret: string
): boolean {
  if (!signatureHeader) return false;
  if (!signatureHeader.startsWith('sha256=')) return false;
  const expected =
    'sha256=' +
    crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// GET — webhook verification (Meta subscription handshake).
// hub.verify_token is matched against any client's decrypted
// wa_webhook_secret (per-client waterfall).
// ---------------------------------------------------------------------------

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get('hub.mode');
  const challenge = searchParams.get('hub.challenge');
  const verifyToken = searchParams.get('hub.verify_token');

  if (mode !== 'subscribe' || !challenge || !verifyToken) {
    return NextResponse.json(
      { error: 'Missing verification parameters' },
      { status: 400 }
    );
  }

  const { data: configs, error } = await supabaseAdmin()
    .from('client_config')
    .select('wa_webhook_secret')
    .not('wa_webhook_secret', 'is', null);

  if (error || !configs) {
    console.error(
      '[webhooks/whatsapp] failed to load client configs for verify:',
      error
    );
    return NextResponse.json({ error: 'Verification failed' }, { status: 403 });
  }

  for (const row of configs) {
    if (!row.wa_webhook_secret) continue;
    try {
      if (decrypt(row.wa_webhook_secret) === verifyToken) {
        return new Response(challenge, {
          status: 200,
          headers: { 'Content-Type': 'text/plain' },
        });
      }
    } catch {
      // Malformed / wrong-key ciphertext row — skip and keep checking.
    }
  }

  return NextResponse.json(
    { error: 'Verification token mismatch' },
    { status: 403 }
  );
}

// ---------------------------------------------------------------------------
// POST — receive inbound WhatsApp messages.
//
// Order is fixed by the compliance + domain gates:
//   1. Identify the client from metadata.phone_number_id.
//   2. Verify HMAC with that client's decrypted wa_webhook_secret.
//   3. Persist the inbound message (idempotent on wa_message_id).
//   4. Write last_inbound_at + last_reply_at (webhook is the ONLY
//      writer of both columns).
//   5. Check opt-out keywords — if matched, mark opted_out and stop.
//   6. Otherwise enqueue the Trigger.dev task, return 200 immediately.
// Gates (human_controlled / opted_out / window) are re-checked inside the
// task; a blocked message is still recorded because we persist first.
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  const rawBody = await request.text();
  const signature = request.headers.get('x-hub-signature-256');

  let body: { entry?: WhatsAppWebhookEntry[] };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // Client identity comes from the payload, not headers.
  const phoneNumberId = firstPhoneNumberId(body);
  if (!phoneNumberId) {
    return NextResponse.json(
      { error: 'No phone_number_id in payload' },
      { status: 400 }
    );
  }

  const client = await loadClientByPhoneNumberId(phoneNumberId);
  if (!client) {
    // Unknown number → nothing to route. 200 so Meta stops retrying.
    console.warn('[webhooks/whatsapp] no client for phone_number_id', {
      phoneNumberId,
    });
    return NextResponse.json({ status: 'ignored' }, { status: 200 });
  }

  if (!client.wa_webhook_secret) {
    console.error('[webhooks/whatsapp] client has no wa_webhook_secret', {
      clientId: client.id,
    });
    return NextResponse.json({ status: 'ignored' }, { status: 200 });
  }

  let secret: string;
  try {
    secret = decrypt(client.wa_webhook_secret);
  } catch (err) {
    console.error('[webhooks/whatsapp] failed to decrypt webhook secret', {
      clientId: client.id,
      error: err instanceof Error ? err.message : err,
    });
    return NextResponse.json({ status: 'ignored' }, { status: 200 });
  }

  if (!verifyHmac(rawBody, signature, secret)) {
    console.warn('[webhooks/whatsapp] rejected request with invalid signature');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  // Enqueue + persist AFTER the response so we ack Meta within their
  // ~20s timeout. `after()` keeps the function alive until done.
  after(async () => {
    try {
      await processInboundWebhook(client.id, body);
    } catch (error) {
      console.error('[webhooks/whatsapp] error processing webhook:', error);
    }
  });

  return NextResponse.json({ status: 'received' }, { status: 200 });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function firstPhoneNumberId(body: {
  entry?: WhatsAppWebhookEntry[];
}): string | null {
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes) {
      const numId = change.value?.metadata?.phone_number_id;
      if (numId) return numId;
    }
  }
  return null;
}

async function loadClientByPhoneNumberId(phoneNumberId: string) {
  const { data, error } = await supabaseAdmin()
    .from('client_config')
    .select('client_id, wa_webhook_secret')
    .eq('wa_phone_number_id', phoneNumberId)
    .maybeSingle();

  if (error) {
    console.error('[webhooks/whatsapp] client lookup failed:', error);
    return null;
  }
  return data
    ? { id: data.client_id, wa_webhook_secret: data.wa_webhook_secret }
    : null;
}

async function processInboundWebhook(
  clientId: string,
  body: { entry?: WhatsAppWebhookEntry[] }
) {
  if (!body.entry) return;

  for (const entry of body.entry) {
    for (const change of entry.changes) {
      const value = change.value;
      if (!value?.messages) continue;

      for (const message of value.messages) {
        if (message.type !== 'text' || !message.text?.body) {
          // Ignore media/reaction/non-text messages for now.
          continue;
        }
        await handleInboundTextMessage(clientId, message);
      }
    }
  }
}

async function handleInboundTextMessage(
  clientId: string,
  message: WhatsAppTextMessage
) {
  const body = message.text!.body;
  // Meta sends digits-only; contacts.phone_e164 is stored with a leading '+'.
  const phoneE164 = `+${message.from.replace(/\D/g, '')}`;
  const waTimestamp = new Date(parseInt(message.timestamp, 10) * 1000);

  // Find or create contact (spec: status clean, lead cold, new_lead).
  const contactId = await findOrCreateContact(clientId, phoneE164);
  if (!contactId) {
    console.error('[webhooks/whatsapp] failed to resolve contact', {
      clientId,
      phoneE164,
    });
    return;
  }

  const conversationId =
    (await ensureConversation(clientId, contactId)) ?? null;
  if (!conversationId) {
    console.error('[webhooks/whatsapp] failed to resolve conversation', {
      clientId,
      contactId,
    });
    return;
  }

  // 3. Persist inbound (idempotent) BEFORE anything can block it.
  const inboundMessageRowId = await persistInboundMessage({
    clientId,
    contactId,
    conversationId,
    body,
    waMessageId: message.id,
    waTimestamp,
  });

  // 4. last_inbound_at + last_reply_at — webhook-only writers (gate
  //    finding / spec 5 export contract). Same value, same event time:
  //    the raw message timestamp, never agent processing time.
  await touchContactInbound(clientId, contactId, waTimestamp);

  // 5. Opt-out short-circuit (compliance): mark and stop, no agent run.
  //    The write never depends on the persisted row id — if persisting
  //    failed, the contact must still be flagged opted-out; the row id
  //    is only the optional opt_out_message_id audit link.
  if (isOptOut(body)) {
    await markContactOptedOut(clientId, contactId, inboundMessageRowId);
    return;
  }

  // 6. Enqueue the agent task (non-blocking). inboundMessageRowId is
  //    carried through so an agent-classified unsubscribe can audit the
  //    same contacts.opt_out_message_id column this route writes on the
  //    keyword path above.
  await tasks
    .trigger('process-inbound-message', {
      clientId,
      contactId,
      inboundMessage: body,
      waMessageId: message.id,
      waTimestamp: waTimestamp.toISOString(),
      inboundMessageRowId,
    })
    .catch((error: unknown) => {
      console.error('[webhooks/whatsapp] failed to enqueue task:', error);
    });

  // Conversation liveness tracking for the inbox UI. Status vocabulary
  // is open | resolved | opted_out (spec 1) — never 'active'.
  await supabaseAdmin()
    .from('conversations')
    .update({
      last_message_at: waTimestamp.toISOString(),
      last_message_preview: body.slice(0, 200),
      status: 'open',
      updated_at: waTimestamp.toISOString(),
    })
    .eq('id', conversationId)
    .eq('client_id', clientId)
    .then(({ error }) => {
      if (error) {
        console.error('[webhooks/whatsapp] conversation update failed:', error);
      }
    });
}

async function findOrCreateContact(
  clientId: string,
  phoneE164: string
): Promise<string | null> {
  const { data: existing } = await supabaseAdmin()
    .from('contacts')
    .select('id')
    .eq('client_id', clientId)
    .eq('phone_e164', phoneE164)
    .maybeSingle();

  if (existing) return existing.id;

  const { data: created, error } = await supabaseAdmin()
    .from('contacts')
    .insert({
      client_id: clientId,
      phone_e164: phoneE164,
      status: 'clean',
      lead_score: 'cold',
      pipeline_stage: 'new_lead',
      email_type: null,
    })
    .select('id')
    .maybeSingle();

  if (created) return created.id;

  if (error) {
    console.error('[webhooks/whatsapp] contact insert failed:', error);
  }
  // Likely a race on (client_id, phone_e164) — re-select once.
  const { data: retry } = await supabaseAdmin()
    .from('contacts')
    .select('id')
    .eq('client_id', clientId)
    .eq('phone_e164', phoneE164)
    .maybeSingle();

  return retry?.id ?? null;
}

async function ensureConversation(
  clientId: string,
  contactId: string
): Promise<string | null> {
  const { data: existing } = await supabaseAdmin()
    .from('conversations')
    .select('id')
    .eq('client_id', clientId)
    .eq('contact_id', contactId)
    .maybeSingle();

  if (existing) return existing.id;

  const { data: created, error } = await supabaseAdmin()
    .from('conversations')
    .insert({
      client_id: clientId,
      contact_id: contactId,
      status: 'active',
      unread_count: 0,
    })
    .select('id')
    .maybeSingle();

  if (created) return created.id;

  if (error) {
    console.error('[webhooks/whatsapp] conversation insert failed:', error);
  }
  const { data: retry } = await supabaseAdmin()
    .from('conversations')
    .select('id')
    .eq('client_id', clientId)
    .eq('contact_id', contactId)
    .maybeSingle();

  return retry?.id ?? null;
}

async function persistInboundMessage(params: {
  clientId: string;
  contactId: string;
  conversationId: string;
  body: string;
  waMessageId: string;
  waTimestamp: Date;
}) {
  const { data, error } = await supabaseAdmin()
    .from('messages')
    .upsert(
      {
        client_id: params.clientId,
        contact_id: params.contactId,
        conversation_id: params.conversationId,
        direction: 'inbound',
        sender_type: 'contact',
        body: params.body,
        wa_message_id: params.waMessageId,
        wa_timestamp: params.waTimestamp.toISOString(),
        status: 'sent',
      },
      { onConflict: 'client_id,wa_message_id', ignoreDuplicates: true }
    )
    .select('id')
    .maybeSingle();

  if (error) {
    console.error('[webhooks/whatsapp] inbound insert failed:', error);
  }
  return data?.id ?? null;
}

async function touchContactInbound(
  clientId: string,
  contactId: string,
  at: Date
) {
  const { error } = await supabaseAdmin()
    .from('contacts')
    .update({
      last_inbound_at: at.toISOString(),
      last_reply_at: at.toISOString(),
      updated_at: at.toISOString(),
    })
    .eq('id', contactId)
    .eq('client_id', clientId);

  if (error) {
    console.error('[webhooks/whatsapp] last_inbound_at update failed:', error);
  }
}

async function markContactOptedOut(
  clientId: string,
  contactId: string,
  inboundMessageRowId: string | null
) {
  const optOut = {
    opted_out: true,
    opted_out_at: new Date().toISOString(),
    opted_out_source: 'contact_reply',
  };
  // Only link the audit column when the row id is known — never null
  // it out over an already-recorded value.
  const update = inboundMessageRowId
    ? { ...optOut, opt_out_message_id: inboundMessageRowId }
    : optOut;

  const { error } = await supabaseAdmin()
    .from('contacts')
    .update(update)
    .eq('id', contactId)
    .eq('client_id', clientId);

  if (error) {
    console.error('[webhooks/whatsapp] opt-out update failed:', error);
  }
}
