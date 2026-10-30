import webpush from 'web-push';

import { supabaseAdmin } from '@/lib/supabase/admin';
import { escapeHtml, sendEmail } from '@/lib/email/resend';
import type { EscalationParams } from './types';

/**
 * Hot lead escalation (spec 5, MEMORY entry 10). Platform-level action,
 * fired when a conversation first scores hot:
 *
 *   (a) star flag  → written by updateLeadScore() (contacts.hot_flagged_at)
 *   (b) push notification → Web Push to the ASSIGNED agent, only when
 *       they have a registered push_subscriptions row
 *   (c) email → Resend, from the platform sender (RESEND_FROM_EMAIL) to
 *       client_config.notification_email
 *
 * NEVER throws: escalation is a side quest of the agent pipeline — an
 * alert failure must not fail the exchange that triggered it.
 */

export async function triggerEscalation(
  params: EscalationParams
): Promise<void> {
  try {
    const contact = await loadContact(params.clientId, params.contactId);
    if (!contact) {
      console.error('[escalation] contact not found', {
        clientId: params.clientId,
        contactId: params.contactId,
      });
      return;
    }

    const config = await loadClientConfig(params.clientId);
    if (!config) {
      console.error('[escalation] client config not found', {
        clientId: params.clientId,
      });
      return;
    }

    const conversationId = await loadConversationId(
      params.clientId,
      params.contactId
    );

    const contactName = contact.full_name ?? contact.phone_e164;
    const conversationUrl = conversationId
      ? conversationUrlFor(conversationId)
      : null;

    await Promise.all([
      notifyAssignedAgent({
        clientId: params.clientId,
        assignedTo: contact.assigned_to,
        contactName,
        lastMessage: params.lastMessage,
        conversationUrl,
      }),
      sendEscalationEmail({
        to: config.notification_email,
        brandName: config.client_brand_name,
        contactName,
        contactPhone: contact.phone_e164,
        pipelineStage: contact.pipeline_stage,
        lastMessage: params.lastMessage,
        conversationUrl,
      }),
    ]);
  } catch (error) {
    console.error('[escalation] escalation failed', {
      clientId: params.clientId,
      contactId: params.contactId,
      error: error instanceof Error ? error.message : error,
    });
  }
}

// ---------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------

async function loadContact(clientId: string, contactId: string) {
  const { data } = await supabaseAdmin()
    .from('contacts')
    .select('full_name, phone_e164, pipeline_stage, assigned_to')
    .eq('client_id', clientId)
    .eq('id', contactId)
    .maybeSingle();
  return data;
}

async function loadClientConfig(clientId: string) {
  const { data } = await supabaseAdmin()
    .from('client_config')
    .select('notification_email, client_brand_name')
    .eq('client_id', clientId)
    .maybeSingle();
  return data;
}

async function loadConversationId(
  clientId: string,
  contactId: string
): Promise<string | null> {
  const { data } = await supabaseAdmin()
    .from('conversations')
    .select('id')
    .eq('client_id', clientId)
    .eq('contact_id', contactId)
    .maybeSingle();
  return data?.id ?? null;
}

function conversationUrlFor(conversationId: string): string {
  const base =
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.NEXT_PUBLIC_SITE_URL ??
    'http://localhost:3000';
  return `${base.replace(/\/$/, '')}/dashboard/conversations/${conversationId}`;
}

// ---------------------------------------------------------------
// (b) Web Push to the assigned agent
// ---------------------------------------------------------------

interface PushParams {
  clientId: string;
  assignedTo: string | null;
  contactName: string;
  lastMessage: string;
  conversationUrl: string | null;
}

async function notifyAssignedAgent(params: PushParams): Promise<void> {
  // Unassigned hot lead → no push target. The email alert still fires.
  if (!params.assignedTo) return;

  const { publicKey, privateKey, subject } = vapidConfig();
  if (!publicKey || !privateKey) {
    console.warn('[escalation] WEB_PUSH keys not configured — skipping push', {
      clientId: params.clientId,
    });
    return;
  }

  const { data: subscriptions } = await supabaseAdmin()
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .eq('client_id', params.clientId)
    .eq('user_id', params.assignedTo);

  if (!subscriptions?.length) return;

  const payload = JSON.stringify({
    title: `🔴 Hot Lead: ${params.contactName}`,
    body: params.lastMessage.slice(0, 100),
    url: params.conversationUrl,
  });

  for (const row of subscriptions) {
    try {
      await webpush.sendNotification(
        {
          endpoint: row.endpoint,
          keys: { p256dh: row.p256dh, auth: row.auth },
        },
        payload,
        {
          TTL: 60 * 60 * 24, // stale hot leads are useless after a day
          vapidDetails: { subject, publicKey, privateKey },
        }
      );
    } catch (error) {
      await reconcileDeadSubscription(row, error);
    }
  }
}

function vapidConfig(): {
  publicKey: string | undefined;
  privateKey: string | undefined;
  subject: string;
} {
  return {
    publicKey: process.env.WEB_PUSH_PUBLIC_KEY,
    privateKey: process.env.WEB_PUSH_PRIVATE_KEY,
    subject: process.env.WEB_PUSH_SUBJECT ?? 'mailto:alerts@rewa.local',
  };
}

/**
 * A subscription the push service rejects as gone (404/410) is dead —
 * drop the row so we stop knocking on it every escalation. Any other
 * failure is transient (network, 5xx) and the row is kept.
 */
async function reconcileDeadSubscription(
  row: { id: string },
  error: unknown
): Promise<void> {
  const statusCode = (error as { statusCode?: number })?.statusCode;
  if (statusCode === 404 || statusCode === 410) {
    const { error: deleteError } = await supabaseAdmin()
      .from('push_subscriptions')
      .delete()
      .eq('id', row.id);
    if (deleteError) {
      console.error('[escalation] stale push subscription cleanup failed', {
        subscriptionId: row.id,
        error: deleteError.message,
      });
    }
    return;
  }
  console.error('[escalation] push notification failed', {
    subscriptionId: row.id,
    statusCode,
    error: error instanceof Error ? error.message : error,
  });
}

// ---------------------------------------------------------------
// (c) Email alert via the platform sender
// ---------------------------------------------------------------

interface EscalationEmailParams {
  to: string | null;
  brandName: string;
  contactName: string;
  contactPhone: string;
  pipelineStage: string;
  lastMessage: string;
  conversationUrl: string | null;
}

export async function sendEscalationEmail(
  params: EscalationEmailParams
): Promise<boolean> {
  if (!params.to) {
    console.warn(
      '[escalation] notification_email not configured — skipping email'
    );
    return false;
  }

  // Everything below is contact-controlled → escaped before interpolation.
  const safeName = escapeHtml(params.contactName);
  const safePhone = escapeHtml(params.contactPhone);
  const safeStage = escapeHtml(params.pipelineStage);
  const safeMessage = escapeHtml(params.lastMessage);
  const safeBrand = escapeHtml(params.brandName);

  const cta = params.conversationUrl
    ? `<p><a href="${escapeHtml(params.conversationUrl)}" style="
         background:#E24B4A;color:#fff;padding:12px 24px;
         border-radius:6px;text-decoration:none;display:inline-block
       ">Open Conversation &rarr;</a></p>`
    : '';

  return sendEmail({
    to: params.to,
    source: 'hot-lead-escalation',
    subject: `🔴 Hot Lead Alert — ${params.contactName} | ${params.brandName}`,
    html: `
      <h2>Hot Lead Alert</h2>
      <p><strong>${safeName}</strong> (${safePhone}) has been flagged as a hot lead.</p>
      <p><strong>Pipeline stage:</strong> ${safeStage}</p>
      <p><strong>Last message from contact:</strong></p>
      <blockquote>${safeMessage}</blockquote>
      ${cta}
      <p style="color:#888;font-size:12px">
        This is an automated alert from ${safeBrand}'s rewa platform.
        To stop receiving these alerts, update your notification settings
        in the dashboard.
      </p>
    `,
  });
}
