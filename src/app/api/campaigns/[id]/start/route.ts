import { NextResponse } from 'next/server';
import { tasks } from '@trigger.dev/sdk';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import type { Database } from '@/types/supabase';

type CampaignUpdate = Database['public']['Tables']['campaigns']['Update'];

/**
 * POST /api/campaigns/[id]/start
 *
 * Admin+ only (Spec 6 Layer B): an `agent` may read campaigns but never
 * start one. Validates ownership of the campaign (via RLS — the row only
 * resolves if it belongs to the caller's client) and triggers the
 * send-campaign task. The task owns the draft/scheduled → running
 * transition and finalizes to completed/failed; re-triggering while
 * running is safe because the task is idempotent on
 * campaign_contacts.wa_message_id.
 *
 * A campaign paused MANUALLY can be resumed here (goes back to
 * 'scheduled' with paused_reason cleared). A campaign paused for QUALITY
 * can NOT be resumed by the user — only the quality monitor's GREEN
 * rating may do that, keeping the manual/quality split intact.
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
    .select('id, client_id, status, paused_reason')
    .eq('id', id)
    .maybeSingle();
  if (!campaign) {
    return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
  }

  if (campaign.status === 'paused') {
    const reason = (campaign as { paused_reason?: string | null })
      .paused_reason;
    if (reason === 'quality') {
      return NextResponse.json(
        {
          error:
            'Campaign is paused for quality — it resumes automatically when the number rating recovers',
        },
        { status: 409 }
      );
    }
    // Manual pause → resume it.
    const resume = {
      status: 'scheduled',
      paused_reason: null,
      updated_at: new Date().toISOString(),
    } as CampaignUpdate;
    const { error: resumeError } = await supabase
      .from('campaigns')
      .update(resume)
      .eq('id', id);
    if (resumeError) {
      return NextResponse.json({ error: resumeError.message }, { status: 500 });
    }
  } else if (campaign.status === 'completed' || campaign.status === 'failed') {
    return NextResponse.json(
      { error: `Campaign is already ${campaign.status}` },
      { status: 409 }
    );
  }

  await tasks.trigger('send-campaign', {
    campaignId: campaign.id,
    clientId: campaign.client_id,
  });

  return NextResponse.json({ ok: true });
}
