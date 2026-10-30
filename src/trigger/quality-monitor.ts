import { schedules } from '@trigger.dev/sdk/v3';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { decrypt } from '@/lib/whatsapp/encryption';
import { fetchQualityRating } from '@/lib/sending/client';
import { escapeHtml, sendEmail } from '@/lib/email/resend';
import type { Database } from '@/types/supabase';

type CampaignUpdate = Database['public']['Tables']['campaigns']['Update'];

/**
 * quality-monitor — poll's each client's Meta quality rating every 6
 * hours and drives the quality-pause / resume flow.
 *
 *  - RED   → pause every running/scheduled campaign of the client with
 *            paused_reason='quality', then email the alert to
 *            client_config.notification_email via the shared Resend
 *            client (spec 5 — the client must fix messaging before
 *            re-sending; outreach-compliance skill).
 *  - GREEN → resume ONLY campaigns paused with paused_reason='quality'
 *            (never campaigns paused manually by the dashboard). They go
 *            back to 'scheduled' so the owner re-starts the send.
 *  - YELLOW→ log only.
 *
 * paused_reason cleanly separates the two pause classes so a manual pause
 * is never overwritten by the monitor and a quality pause is never
 * resumed by accident (compliance finding).
 */
export const qualityMonitorTask = schedules.task({
  id: 'quality-monitor',
  cron: '0 */6 * * *',
  maxDuration: 300,
  run: async () => {
    const db = supabaseAdmin();

    const { data: configs, error } = await db
      .from('client_config')
      .select(
        'client_id, wa_phone_number_id, wa_access_token, notification_email, client_brand_name'
      );

    if (error) {
      console.error('[quality-monitor] config load failed', {
        error: error.message,
      });
      return;
    }

    for (const config of configs ?? []) {
      if (!config.wa_phone_number_id || !config.wa_access_token) continue;

      let accessToken: string;
      try {
        accessToken = decrypt(config.wa_access_token);
      } catch {
        console.error('[quality-monitor] token decrypt failed', {
          clientId: config.client_id,
        });
        continue;
      }

      let rating: string;
      try {
        rating = await fetchQualityRating({
          phoneNumberId: config.wa_phone_number_id,
          accessToken,
        });
      } catch (fetchError) {
        console.error('[quality-monitor] rating fetch failed', {
          clientId: config.client_id,
          error: fetchError instanceof Error ? fetchError.message : fetchError,
        });
        continue;
      }

      switch (rating) {
        case 'RED':
          await handleRed({
            client_id: config.client_id,
            wa_phone_number_id: config.wa_phone_number_id,
            notification_email: config.notification_email,
            client_brand_name: config.client_brand_name,
          });
          break;
        case 'GREEN':
          await handleGreen(config.client_id);
          break;
        case 'YELLOW':
          console.warn('[quality-monitor] YELLOW quality rating', {
            clientId: config.client_id,
          });
          break;
        default:
          console.warn('[quality-monitor] unknown quality rating', {
            clientId: config.client_id,
            rating,
          });
      }
    }
  },
});

async function handleRed(config: {
  client_id: string;
  wa_phone_number_id: string;
  notification_email: string | null;
  client_brand_name: string;
}): Promise<void> {
  const pause = {
    status: 'paused',
    paused_reason: 'quality',
    updated_at: new Date().toISOString(),
  } as CampaignUpdate;
  const { data: paused, error } = await supabaseAdmin()
    .from('campaigns')
    .update(pause)
    .eq('client_id', config.client_id)
    .in('status', ['running', 'scheduled'])
    .select('id');
  if (error) {
    console.error('[quality-monitor] quality pause failed', {
      clientId: config.client_id,
      error: error.message,
    });
    return;
  }

  console.error(
    '[quality-monitor] RED quality rating — paused active campaigns',
    {
      clientId: config.client_id,
      pausedCampaigns: paused?.length ?? 0,
    }
  );

  await sendRedAlert(config, paused?.length ?? 0);
}

/**
 * RED is a send-stopping event — the client needs to know now, not on
 * next dashboard login. Best-effort: sendEmail swallows its own failures
 * so a Resend outage cannot break the pause flow.
 */
async function sendRedAlert(
  config: {
    client_id: string;
    wa_phone_number_id: string;
    notification_email: string | null;
    client_brand_name: string;
  },
  pausedCount: number
): Promise<void> {
  if (!config.notification_email) {
    console.warn(
      '[quality-monitor] RED alert not sent — no notification_email',
      { clientId: config.client_id }
    );
    return;
  }

  const safeBrand = escapeHtml(config.client_brand_name);
  const safePhoneId = escapeHtml(config.wa_phone_number_id);

  await sendEmail({
    to: config.notification_email,
    source: 'quality-monitor-red',
    subject: `🔴 WhatsApp quality rating is RED — ${config.client_brand_name}`,
    html: `
      <h2>WhatsApp quality rating: RED</h2>
      <p><strong>${safeBrand}</strong> — Meta has downgraded your
      WhatsApp number's quality rating to <strong>RED</strong>.</p>
      <p><strong>${pausedCount}</strong> active campaign(s) were paused
      automatically and will not send until the rating recovers.</p>
      <p><strong>Phone number ID:</strong> ${safePhoneId}</p>
      <p style="color:#888;font-size:12px">
        Fix messaging quality first (relevance, opt-outs, volume) before
        resuming any campaign. Paused campaigns resume automatically once
        Meta reports GREEN. This is an automated alert from your rewa
        platform.
      </p>
    `,
  });
}

async function handleGreen(clientId: string): Promise<void> {
  const resume = {
    status: 'scheduled',
    paused_reason: null,
    updated_at: new Date().toISOString(),
  } as CampaignUpdate;
  const { data, error } = await supabaseAdmin()
    .from('campaigns')
    .update(resume)
    .eq('client_id', clientId)
    .eq('status', 'paused')
    .eq('paused_reason' as never, 'quality')
    .select('id');
  if (error) {
    console.error('[quality-monitor] quality resume failed', {
      clientId,
      error: error.message,
    });
    return;
  }
  if (data && data.length > 0) {
    console.log('[quality-monitor] resumed quality-paused campaigns', {
      clientId,
      campaigns: data.map((c) => c.id),
    });
  }
}
