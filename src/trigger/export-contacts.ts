import { schedules } from '@trigger.dev/sdk/v3';

import { supabaseAdmin } from '@/lib/supabase/admin';
import { escapeHtml, sendEmail } from '@/lib/email/resend';
import { generateContactsExport } from '@/lib/scoring/export';

const BUCKET = 'contacts-exports';
const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24; // 24h — spec 5

/**
 * export-contacts — the daily scheduled export (spec 5).
 *
 * 06:00 UTC, for every client with a configured notification_email:
 *   1. generate the current-state XLSX (same contract as
 *      GET /api/contacts/export),
 *   2. upload it to the private contacts-exports bucket at
 *      {client_id}/latest.xlsx (upsert — one rolling "latest" object,
 *      no unbounded object sprawl),
 *   3. mint a 24h signed URL (no public objects, ever),
 *   4. email that URL to client_config.notification_email.
 *
 * Per-client failures are logged and skipped — one broken client must
 * not starve the rest of the fleet's export.
 */
export const exportContactsTask = schedules.task({
  id: 'export-contacts-daily',
  cron: '0 6 * * *',
  maxDuration: 300,
  run: async () => {
    const db = supabaseAdmin();

    const { data: configs, error } = await db
      .from('client_config')
      .select('client_id, notification_email, client_brand_name');

    if (error) {
      console.error('[export-contacts] config load failed', {
        error: error.message,
      });
      return;
    }

    let exported = 0;
    for (const config of configs ?? []) {
      try {
        await exportForClient({
          clientId: config.client_id,
          notificationEmail: config.notification_email,
          brandName: config.client_brand_name,
        });
        exported += 1;
      } catch (error) {
        console.error('[export-contacts] client export failed', {
          clientId: config.client_id,
          error: error instanceof Error ? error.message : error,
        });
      }
    }

    console.log('[export-contacts] run complete', {
      clients: configs?.length ?? 0,
      exported,
    });
  },
});

async function exportForClient(params: {
  clientId: string;
  notificationEmail: string | null;
  brandName: string;
}): Promise<void> {
  const buffer = await generateContactsExport({
    clientId: params.clientId,
    format: 'xlsx',
  });

  const path = `${params.clientId}/latest.xlsx`;
  const db = supabaseAdmin();

  const { error: uploadError } = await db.storage
    .from(BUCKET)
    .upload(path, buffer, {
      contentType: XLSX_CONTENT_TYPE,
      upsert: true,
    });
  if (uploadError) {
    throw new Error(`export upload failed: ${uploadError.message}`);
  }

  const { data: signed, error: signError } = await db.storage
    .from(BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS, { download: true });
  if (signError || !signed?.signedUrl) {
    throw new Error(`signed URL failed: ${signError?.message ?? 'no url'}`);
  }

  if (!params.notificationEmail) {
    console.warn('[export-contacts] no notification_email — link not sent', {
      clientId: params.clientId,
      path,
    });
    return;
  }

  const safeBrand = escapeHtml(params.brandName);
  await sendEmail({
    to: params.notificationEmail,
    source: 'daily-contacts-export',
    subject: `${params.brandName} — daily contacts export`,
    html: `
      <h2>Your daily contacts export is ready</h2>
      <p><strong>${safeBrand}</strong> — the current export of all
      contacts, with live lead scores, pipeline stages, and consent
      flags.</p>
      <p>
        <a href="${escapeHtml(signed.signedUrl)}" style="
          background:#E24B4A;color:#fff;padding:12px 24px;
          border-radius:6px;text-decoration:none;display:inline-block
        ">Download XLSX &rarr;</a>
      </p>
      <p style="color:#888;font-size:12px">
        The link expires in 24 hours — a fresh one arrives with
        tomorrow's export. This is an automated message from your
        rewa platform.
      </p>
    `,
  });
}
