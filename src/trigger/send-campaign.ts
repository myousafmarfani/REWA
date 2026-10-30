import { task } from '@trigger.dev/sdk/v3';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { decrypt } from '@/lib/whatsapp/encryption';
import { acquireSendSlot, sleep } from '@/lib/sending/rate-limiter';
import { sendTemplateMessage } from '@/lib/sending/client';
import { SendingNotConfiguredError, WaSendError } from '@/lib/sending/types';

/**
 * send-campaign — drives one campaign through its queue of contacts.
 *
 * Safety properties (compliance review + QA checklist):
 *  - Batches of 10; the campaign row is re-checked before EVERY batch and
 *    the run stops at the batch boundary the moment status becomes
 *    'paused' (manual or quality) — the "pause mid-run stops within one
 *    batch" guarantee.
 *  - Idempotent: only rows with status='pending' AND wa_message_id IS NULL
 *    are picked up, so a Trigger.dev retry or re-trigger skips everything
 *    already sent (wa_message_id is the dedup key).
 *  - Contacts that are opted_out, not clean, or not mobile are skipped
 *    permanently (status='skipped').
 *  - One in-loop retry after 5s for transient failures (HTTP 429/5xx and
 *    network); deterministic errors are failed immediately, never retried.
 *  - Blocked recipients are recorded as opted_out_source='blocked' (never
 *    'manual'); invalid numbers map to contacts.status='invalid'.
 *  - sent_count / failed_count are recomputed from campaign_contacts in a
 *    single pass per batch (no additive counters).
 *
 * The run is automatically idempotent across worker crashes: Trigger.dev
 * retries restart the run, which simply skips completed rows.
 */

const BATCH_SIZE = 10;
const RETRY_DELAY_MS = 5000;

export const sendCampaignTask = task({
  id: 'send-campaign',
  maxDuration: 3600,
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 10000,
    factor: 2,
  },
  run: async (payload: { campaignId: string; clientId: string }) => {
    const { campaignId, clientId } = payload;
    const db = supabaseAdmin();

    // 1. Load campaign.
    const { data: campaign, error: campaignError } = await db
      .from('campaigns')
      .select('id, status, template_id, name, template_name, started_at')
      .eq('id', campaignId)
      .eq('client_id', clientId)
      .maybeSingle();

    if (campaignError || !campaign) {
      console.error('[send-campaign] campaign not found', {
        campaignId,
        clientId,
      });
      return;
    }
    if (
      campaign.status === 'paused' ||
      campaign.status === 'completed' ||
      campaign.status === 'failed'
    ) {
      return;
    }

    // 2. Template must exist and be Meta-approved.
    const { data: template, error: templateError } = await db
      .from('message_templates')
      .select('id, name, language, status')
      .eq('id', campaign.template_id)
      .eq('client_id', clientId)
      .maybeSingle();

    if (templateError || !template) {
      console.error('[send-campaign] template not found', {
        campaignId,
        templateId: campaign.template_id,
      });
      await failCampaign(campaignId, clientId, 'Template not found');
      return;
    }
    if (template.status !== 'approved') {
      console.error('[send-campaign] template not approved', {
        campaignId,
        template: template.name,
        status: template.status,
      });
      await failCampaign(
        campaignId,
        clientId,
        `Template '${template.name}' is not approved`
      );
      return;
    }

    // 3. Per-client credentials.
    const { data: config, error: configError } = await db
      .from('client_config')
      .select('wa_phone_number_id, wa_access_token')
      .eq('client_id', clientId)
      .maybeSingle();

    if (configError || !config?.wa_phone_number_id || !config.wa_access_token) {
      throw new SendingNotConfiguredError(
        `Client ${clientId} has no WhatsApp credentials`
      );
    }
    let accessToken: string;
    try {
      accessToken = decrypt(config.wa_access_token);
    } catch {
      await failCampaign(
        campaignId,
        clientId,
        'Access token could not be decrypted'
      );
      return;
    }

    // 4. Mark running (started_at is set only once).
    const startedAt = campaign.started_at ?? new Date().toISOString();
    const { error: runningError } = await db
      .from('campaigns')
      .update({
        status: 'running',
        started_at: startedAt,
        template_name: template.name,
        updated_at: new Date().toISOString(),
      })
      .eq('id', campaignId)
      .eq('client_id', clientId);
    if (runningError) {
      console.error('[send-campaign] could not mark campaign running', {
        campaignId,
        error: runningError.message,
      });
      return;
    }

    // 5. Main batch loop.
    while (true) {
      // Pause check — once per batch (manual or quality pause stops here).
      const { data: current } = await db
        .from('campaigns')
        .select('status')
        .eq('id', campaignId)
        .eq('client_id', clientId)
        .maybeSingle();
      if (!current || current.status === 'paused') {
        console.log(
          '[send-campaign] campaign paused — stopping at batch boundary',
          {
            campaignId,
          }
        );
        break;
      }

      const { data: batch, error: batchError } = await db
        .from('campaign_contacts')
        .select('id, contact_id, params, status, wa_message_id')
        .eq('campaign_id', campaignId)
        .eq('client_id', clientId)
        .eq('status', 'pending')
        .is('wa_message_id', null)
        .order('created_at', { ascending: true })
        .limit(BATCH_SIZE);

      if (batchError) {
        console.error('[send-campaign] batch fetch failed', {
          campaignId,
          error: batchError.message,
        });
        throw batchError;
      }
      if (!batch || batch.length === 0) break;

      const contacts = await loadContacts(clientId, batch);

      for (const cc of batch) {
        const contact = contacts.get(cc.contact_id);
        if (!contact) {
          await markSkipped(campaignId, clientId, cc.id, 'contact missing');
          continue;
        }
        if (contact.opted_out) {
          await markSkipped(campaignId, clientId, cc.id, 'opted_out');
          continue;
        }
        if (contact.status !== 'clean') {
          await markSkipped(
            campaignId,
            clientId,
            cc.id,
            `status=${contact.status}`
          );
          continue;
        }
        if (contact.number_type !== 'mobile') {
          await markSkipped(
            campaignId,
            clientId,
            cc.id,
            `number_type=${contact.number_type}`
          );
          continue;
        }

        // Idempotency re-check immediately before the send.
        const { data: recheck } = await db
          .from('campaign_contacts')
          .select('status, wa_message_id')
          .eq('id', cc.id)
          .eq('client_id', clientId)
          .maybeSingle();
        if (recheck?.wa_message_id || recheck?.status !== 'pending') continue;

        await acquireSendSlot(config.wa_phone_number_id);

        try {
          const result = await sendWithRetryOnce({
            ccId: cc.id,
            clientId,
            campaignId,
            phoneNumberId: config.wa_phone_number_id,
            accessToken,
            to: contact.phone_e164,
            templateName: template.name,
            languageCode: template.language,
            components: buildBodyComponents(cc.params),
          });
          const sentAt = new Date().toISOString();
          await db
            .from('campaign_contacts')
            .update({
              status: 'sent',
              sent_at: sentAt,
              wa_message_id: result.waMessageId,
            })
            .eq('id', cc.id)
            .eq('client_id', clientId);
          await touchContactAfterSend(clientId, contact.id);
        } catch (error) {
          if (error instanceof WaSendError) {
            await handleWaError(campaignId, clientId, cc.id, contact, error);
          } else {
            await markFailed(
              campaignId,
              clientId,
              cc.id,
              error instanceof Error ? error.message : String(error)
            );
          }
        }
      }

      await refreshCounts(campaignId, clientId);
    }

    // 6. Finalize — only if not paused (paused runs exit without claiming
    //    completion; the monitor/dashboard decides the next status).
    const { data: final } = await db
      .from('campaigns')
      .select('status')
      .eq('id', campaignId)
      .eq('client_id', clientId)
      .maybeSingle();
    if (final && final.status !== 'paused') {
      await db
        .from('campaigns')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', campaignId)
        .eq('client_id', clientId);
    }
    await refreshCounts(campaignId, clientId);
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadContacts(
  clientId: string,
  batch: Array<{ contact_id: string }>
): Promise<
  Map<
    string,
    {
      id: string;
      phone_e164: string;
      opted_out: boolean;
      status: string;
      number_type: string | null;
    }
  >
> {
  const ids = batch.map((cc) => cc.contact_id);
  const { data, error } = await supabaseAdmin()
    .from('contacts')
    .select('id, phone_e164, opted_out, status, number_type')
    .in('id', ids)
    .eq('client_id', clientId);
  if (error) {
    console.error('[send-campaign] contact load failed', {
      error: error.message,
    });
    return new Map();
  }
  const map = new Map<
    string,
    {
      id: string;
      phone_e164: string;
      opted_out: boolean;
      status: string;
      number_type: string | null;
    }
  >();
  for (const row of data ?? []) map.set(row.id, row);
  return map;
}

/**
 * One in-loop retry at 5s for transient failures, then fail.
 *
 * Before the retry the campaign_contacts row is re-checked (carry-forward
 * #2): if a concurrent run already claimed the send (wa_message_id now
 * populated, or the row left 'pending'), we adopt that outcome instead of
 * firing a duplicate message.
 */
async function sendWithRetryOnce(params: {
  ccId: string;
  clientId: string;
  campaignId: string;
  phoneNumberId: string;
  accessToken: string;
  to: string;
  templateName: string;
  languageCode: string;
  components?: unknown[];
}): Promise<ReturnType<typeof sendTemplateMessage>> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await sendTemplateMessage({
        phoneNumberId: params.phoneNumberId,
        accessToken: params.accessToken,
        to: params.to,
        templateName: params.templateName,
        languageCode: params.languageCode,
        components: params.components,
      });
    } catch (error) {
      if (error instanceof WaSendError && error.retryable && attempt === 1) {
        const { data: claim } = await supabaseAdmin()
          .from('campaign_contacts')
          .select('status, wa_message_id')
          .eq('id', params.ccId)
          .eq('campaign_id', params.campaignId)
          .eq('client_id', params.clientId)
          .maybeSingle();
        if (claim?.wa_message_id) {
          // A concurrent run already sent this contact — adopt it.
          return { waMessageId: claim.wa_message_id };
        }
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      throw error;
    }
  }
  throw new Error('unreachable: sendWithRetryOnce');
}

/** Body components from the per-contact rendered template params. */
function buildBodyComponents(
  params: unknown
):
  | Array<{ type: string; parameters: Array<{ type: string; text: string }> }>
  | undefined {
  const values = Array.isArray(params)
    ? params
    : (params as Record<string, unknown> | null)?.values;
  if (!Array.isArray(values) || values.length === 0) return undefined;
  return [
    {
      type: 'body',
      parameters: values.map((v) => ({ type: 'text', text: String(v) })),
    },
  ];
}

async function markSkipped(
  campaignId: string,
  clientId: string,
  ccId: string,
  reason: string
): Promise<void> {
  const { error } = await supabaseAdmin()
    .from('campaign_contacts')
    .update({ status: 'skipped', fail_reason: reason })
    .eq('id', ccId)
    .eq('campaign_id', campaignId)
    .eq('client_id', clientId);
  if (error) {
    console.error('[send-campaign] skip marking failed', {
      ccId,
      error: error.message,
    });
  }
}

async function markFailed(
  campaignId: string,
  clientId: string,
  ccId: string,
  reason: string
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabaseAdmin()
    .from('campaign_contacts')
    .update({ status: 'failed', failed_at: now, fail_reason: reason })
    .eq('id', ccId)
    .eq('campaign_id', campaignId)
    .eq('client_id', clientId);
  if (error) {
    console.error('[send-campaign] fail marking failed', {
      ccId,
      error: error.message,
    });
  }
}

async function handleWaError(
  campaignId: string,
  clientId: string,
  ccId: string,
  contact: { id: string; phone_e164: string },
  error: WaSendError
): Promise<void> {
  if (error.isBlockedContact) {
    const now = new Date().toISOString();
    await supabaseAdmin()
      .from('contacts')
      .update({
        opted_out: true,
        opted_out_at: now,
        opted_out_source: 'blocked',
        updated_at: now,
      })
      .eq('id', contact.id)
      .eq('client_id', clientId);
    await markFailed(
      campaignId,
      clientId,
      ccId,
      `blocked recipient: ${error.message}`
    );
    return;
  }
  if (error.isInvalidNumber) {
    const now = new Date().toISOString();
    await supabaseAdmin()
      .from('contacts')
      .update({
        status: 'invalid',
        invalid_reason: 'parse_failed',
        updated_at: now,
      })
      .eq('id', contact.id)
      .eq('client_id', clientId);
    await markFailed(
      campaignId,
      clientId,
      ccId,
      `invalid number: ${error.message}`
    );
    return;
  }
  await markFailed(campaignId, clientId, ccId, error.message);
}

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
    console.error('[send-campaign] last_contacted_at update failed', {
      contactId,
      error: error.message,
    });
  }
}

/** Recomputed from campaign_contacts in one pass — no additive counters. */
async function refreshCounts(
  campaignId: string,
  clientId: string
): Promise<void> {
  const db = supabaseAdmin();
  const counts = await Promise.all([
    db
      .from('campaign_contacts')
      .select('*', { count: 'exact', head: true })
      .eq('campaign_id', campaignId)
      .eq('client_id', clientId)
      .eq('status', 'sent'),
    db
      .from('campaign_contacts')
      .select('*', { count: 'exact', head: true })
      .eq('campaign_id', campaignId)
      .eq('client_id', clientId)
      .eq('status', 'failed'),
  ]);
  const { error } = await db
    .from('campaigns')
    .update({
      sent_count: counts[0].count ?? 0,
      failed_count: counts[1].count ?? 0,
      updated_at: new Date().toISOString(),
    })
    .eq('id', campaignId)
    .eq('client_id', clientId);
  if (error) {
    console.error('[send-campaign] count refresh failed', {
      campaignId,
      error: error.message,
    });
  }
}

async function failCampaign(
  campaignId: string,
  clientId: string,
  reason: string
): Promise<void> {
  console.error('[send-campaign] failing campaign', { campaignId, reason });
  const { error } = await supabaseAdmin()
    .from('campaigns')
    .update({
      status: 'failed',
      failed_count: 0,
      sent_count: 0,
      updated_at: new Date().toISOString(),
    })
    .eq('id', campaignId)
    .eq('client_id', clientId);
  if (error) {
    console.error('[send-campaign] campaign fail marking failed', {
      error: error.message,
    });
  }
}
