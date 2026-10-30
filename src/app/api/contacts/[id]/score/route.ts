import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { recordScoreChange } from '@/lib/scoring';
import type { LeadScore } from '@/lib/agent/types';
import type { Database } from '@/types/supabase';

const SCORES: readonly string[] = ['cold', 'warm', 'hot'];

/**
 * POST /api/contacts/[id]/score — manual lead-score override (spec 5).
 *
 * This is the ONLY path allowed to move a score DOWN, including
 * hot → warm/cold: the automatic rule in scorer.ts is monotonic, so
 * every downgrade here is a human decision and lands in
 * lead_score_history with reason='manual'.
 *
 * Scope: the caller's own client (RLS via ctx.supabase), minimum role
 * 'admin' (Spec 6 Layer B: an `agent` may read contacts but not write
 * them). No escalation fires — a human setting hot already knows.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('admin');
    const { id: contactId } = await params;

    const body = (await request.json().catch(() => null)) as {
      lead_score?: unknown;
    } | null;
    const score = typeof body?.lead_score === 'string' ? body.lead_score : '';
    if (!SCORES.includes(score)) {
      return NextResponse.json(
        { error: `lead_score must be one of: ${SCORES.join(', ')}` },
        { status: 400 }
      );
    }
    const newScore = score as LeadScore;

    const { data: contact, error: readError } = await ctx.supabase
      .from('contacts')
      .select('lead_score')
      .eq('id', contactId)
      .maybeSingle();

    if (readError) {
      console.error('[contacts/score] contact read failed', {
        contactId,
        error: readError.message,
      });
      throw readError;
    }
    if (!contact) {
      // RLS hides other clients' rows — 404 either way, no tenant leak.
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
    }

    const previousScore = contact.lead_score as LeadScore;
    if (previousScore === newScore) {
      return NextResponse.json({
        ok: true,
        lead_score: newScore,
        changed: false,
      });
    }

    const update: Database['public']['Tables']['contacts']['Update'] = {
      lead_score: newScore,
      updated_at: new Date().toISOString(),
    };
    // hot_flagged_at tracks CURRENT hot state (symmetric with the agent
    // path in scoring/index.ts): set on the way in, cleared on the way
    // out so the export column never advertises a stale star. The
    // transition itself is recorded in lead_score_history below.
    if (newScore === 'hot' && previousScore !== 'hot') {
      update.hot_flagged_at = new Date().toISOString();
    } else if (newScore !== 'hot' && previousScore === 'hot') {
      update.hot_flagged_at = null;
    }

    const { error: updateError } = await ctx.supabase
      .from('contacts')
      .update(update)
      .eq('id', contactId);

    if (updateError) {
      console.error('[contacts/score] contact update failed', {
        contactId,
        error: updateError.message,
      });
      throw updateError;
    }

    await recordScoreChange({
      clientId: ctx.accountId,
      contactId,
      previousScore,
      newScore,
      reason: 'manual',
    });

    return NextResponse.json({ ok: true, lead_score: newScore, changed: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
