import { NextResponse } from 'next/server';
import { tasks } from '@trigger.dev/sdk';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import type { Database } from '@/types/supabase';

type CampaignUpdate = Database['public']['Tables']['campaigns']['Update'];

/**
 * POST /api/campaigns/[id]/retry
 *
 * Admin+ only (Spec 6 Layer B). Re-queues a campaign whose status is
 * 'failed' — the send-campaign task marks a campaign failed only before
 * any sends leave the building (template missing/not approved, or the
 * access token could not be decrypted), so every campaign_contacts row is
 * still 'pending'. Retry therefore resets the terminal status back to
 * 'scheduled' and re-triggers the task; the task's per-row idempotency
 * (wa_message_id) makes any already-sent row a no-op.
 *
 * The underlying cause is NOT fixed here — an operator must correct the
 * template/credentials first, else the task fails the campaign again.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  let ctx;
  try {
    ctx = await requireRole('admin');
  } catch (error) {
    return toErrorResponse(error);
  }
  const { id } = await context.params;
  const supabase = ctx.supabase;

  const { data: campaign } = await supabase
    .from('campaigns')
    .select('id, client_id, status')
    .eq('id', id)
    .maybeSingle();
  if (!campaign) {
    return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
  }
  if (campaign.status !== 'failed') {
    return NextResponse.json(
      { error: `Only a failed campaign can be retried (currently ${campaign.status})` },
      { status: 409 }
    );
  }

  const reset = {
    status: 'scheduled',
    sent_count: 0,
    failed_count: 0,
    updated_at: new Date().toISOString(),
  } as CampaignUpdate;
  const { error: resetError } = await supabase
    .from('campaigns')
    .update(reset)
    .eq('id', id);
  if (resetError) {
    return NextResponse.json({ error: resetError.message }, { status: 500 });
  }

  await tasks.trigger('send-campaign', {
    campaignId: campaign.id,
    clientId: campaign.client_id,
  });

  return NextResponse.json({ ok: true });
}
