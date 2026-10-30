import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import type { Database } from '@/types/supabase';

type CampaignUpdate = Database['public']['Tables']['campaigns']['Update'];

/**
 * POST /api/campaigns/[id]/pause
 *
 * Admin+ only (Spec 6 Layer B): an `agent` may read campaigns but never
 * pause/resume one. Manual pause from the dashboard. Recorded as
 * paused_reason='manual' so the quality monitor NEVER resumes a
 * manually-paused campaign and never overwrites its reason on a quality
 * pause. The running send-campaign task observes the state change at its
 * next batch boundary and stops within one batch.
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
    .select('id, status')
    .eq('id', id)
    .maybeSingle();
  if (!campaign) {
    return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
  }
  if (campaign.status !== 'running' && campaign.status !== 'scheduled') {
    return NextResponse.json(
      { error: `Cannot pause a campaign in state '${campaign.status}'` },
      { status: 409 }
    );
  }

  const pause = {
    status: 'paused',
    paused_reason: 'manual',
    updated_at: new Date().toISOString(),
  } as CampaignUpdate;
  const { error } = await supabase.from('campaigns').update(pause).eq('id', id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
