import { NextResponse } from 'next/server';
import { tasks } from '@trigger.dev/sdk';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { ensureConversation, persistHumanResponse } from '@/lib/agent/persist';

/**
 * POST /api/messages/send
 *
 * Human-led outbound send on a contact's conversation (e.g. the "you
 * take over" badge). Minimum role 'agent' (Spec 6 Layer B: agents may
 * read/write conversations and messages). Only allowed when
 * contacts.human_controlled is true — that flag is the hard database gate
 * (MEMORY read-first rule / agent-core-spec). While it is set the agent
 * does not respond, so this route is the ONLY way a human reply gets sent.
 *
 * Body: { contact_id, message }
 *
 * Ownership is enforced by RLS; the task enforces the 24-hour window and
 * the opted-out gate before any bytes reach Meta.
 */
export async function POST(request: Request) {
  let ctx;
  try {
    ctx = await requireRole('agent');
  } catch (error) {
    return toErrorResponse(error);
  }
  const supabase = ctx.supabase;

  const body = (await request.json().catch(() => null)) as {
    contact_id?: string;
    message?: string;
  } | null;
  const contactId = body?.contact_id;
  const message = body?.message?.trim();
  if (!contactId || !message) {
    return NextResponse.json(
      { error: 'contact_id and message are required' },
      { status: 400 }
    );
  }

  const { data: contact } = await supabase
    .from('contacts')
    .select('id, client_id, human_controlled')
    .eq('id', contactId)
    .maybeSingle();
  if (!contact) {
    return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
  }
  if (!contact.human_controlled) {
    return NextResponse.json(
      { error: 'Human control is not enabled for this contact' },
      { status: 403 }
    );
  }

  // Persist the outbound row BEFORE sending (status 'pending') so the
  // dashboard thread renders the reply via Realtime and the send layer
  // has an id to flip to 'sent'/'failed' — same contract the agent path
  // uses (persistAgentResponse → sendWhatsAppMessage(messageId)).
  let conversationId: string | null = null;
  let messageId: string | null = null;
  try {
    conversationId = await ensureConversation(contact.client_id, contact.id);
    if (!conversationId) {
      return NextResponse.json(
        { error: 'Could not resolve conversation' },
        { status: 500 }
      );
    }
    messageId = await persistHumanResponse({
      clientId: contact.client_id,
      contactId: contact.id,
      conversationId,
      body: message,
    });
  } catch (error) {
    console.error('[POST /api/messages/send] persist failed:', error);
    return NextResponse.json({ error: 'Could not record message' }, { status: 500 });
  }

  await tasks.trigger('send-single-message', {
    clientId: contact.client_id,
    contactId: contact.id,
    message,
    messageType: 'human_reply',
    messageId: messageId ?? undefined,
  });

  return NextResponse.json({ ok: true });
}
