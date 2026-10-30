# Spec 5: Lead Scoring, CSV Export, and Hot Lead Escalation
# Project: rewa
# depends_on: 1-data-model-spec (contacts, messages, lead_score_history),
#             3-agent-core-spec (AgentOutput.lead_score fed in here)
# subagents: @domain-strategist (review scoring logic) →
#            @backend-builder (implement) → @qa-reviewer (verify)
# mcps: supabase (read/write contacts, lead_score_history),
#       context7 (Resend or Nodemailer docs for email alerts)

---

## Purpose

Implement lead scoring updates, the continuous CSV/Excel export, and
the hot lead escalation system (push notification + automated email).
This spec consumes the AgentOutput from agent-core-spec and acts on
the lead_score field.

Read the real-estate-outreach-domain skill for the exact signal patterns
that define cold, warm, and hot before implementing the scoring logic.

---

## Constraints from MEMORY.md

- Entry 9: cold (blue) | warm (orange) | hot (red + star). Score stored
  per contact, updated after every exchange.
- Entry 10: hot lead triggers: (a) flag in UI with star, (b) push
  notification to assigned agent, (c) automated email from platform
  sender (not the agent's personal email).
- Entry 16: $0 build cost — use free email sending option for alerts.
- Entry 11: hot escalation is a platform action, not an AI action.

---

## Module location

```
src/
  lib/
    scoring/
      index.ts          -- updateLeadScore(), triggerEscalation()
      scorer.ts         -- score assignment logic from AgentOutput signals
      escalation.ts     -- hot lead alert: push notification + email
      export.ts         -- CSV/Excel export generation
      types.ts
  trigger/
    export-contacts.ts  -- Trigger.dev task for async export generation
```

---

## scorer.ts — score assignment from AgentOutput signals

```typescript
import type { AgentSignals, IntentType, LeadScore } from '../agent/types';

export function computeLeadScore(
  intentType: IntentType,
  signals: AgentSignals
): LeadScore {

  // HOT: any closing signal present
  if (
    signals.requested_visit ||
    signals.negotiating ||
    signals.asked_for_contract ||
    intentType === 'closing'
  ) {
    return 'hot';
  }

  // WARM: qualified interest signals
  if (
    signals.mentioned_budget ||
    signals.requested_pricing ||
    signals.mentioned_timeline ||
    intentType === 'interested' ||
    intentType === 'qualifying'
  ) {
    return 'warm';
  }

  // COLD: default
  return 'cold';
}

// Score can only be manually downgraded by a human agent.
// If the existing score is 'hot' and the new computed score is 'warm'
// or 'cold', do NOT automatically downgrade — keep 'hot'.
// Only a human can move a hot lead back to warm or cold.

export function resolveScoreUpdate(
  currentScore: LeadScore,
  newScore: LeadScore
): LeadScore {
  const order: Record<LeadScore, number> = { cold: 0, warm: 1, hot: 2 };
  // Score only moves up, never down automatically
  return order[newScore] > order[currentScore] ? newScore : currentScore;
}
```

---

## index.ts — update contact score after each agent exchange

```typescript
export async function updateLeadScore(params: {
  clientId: string;
  contactId: string;
  messageId: string;
  agentOutput: AgentOutput;
}): Promise<void> {

  // 1. Read current contact.lead_score and contact.pipeline_stage
  const contact = await supabase
    .from('contacts')
    .select('lead_score, pipeline_stage')
    .eq('id', params.contactId)
    .eq('client_id', params.clientId)
    .single();

  // 2. Compute new score from agent signals
  const computed = computeLeadScore(
    params.agentOutput.intent_type,
    params.agentOutput.signals
  );

  // 3. Resolve (score only moves up)
  const newScore = resolveScoreUpdate(contact.data.lead_score, computed);

  // 4. Determine pipeline stage (take higher of current vs suggested)
  const stageOrder = [
    'new_lead', 'contacted', 'qualified',
    'viewing_booked', 'offer_made', 'negotiation'
  ];
  const currentStageIdx = stageOrder.indexOf(contact.data.pipeline_stage);
  const suggestedStageIdx = stageOrder.indexOf(params.agentOutput.suggested_stage);
  const newStage = stageOrder[Math.max(currentStageIdx, suggestedStageIdx)];

  // 5. Update contact
  await supabase
    .from('contacts')
    .update({
      lead_score: newScore,
      pipeline_stage: newStage,
      hot_flagged_at: newScore === 'hot' && contact.data.lead_score !== 'hot'
        ? new Date().toISOString()
        : undefined,
      updated_at: new Date().toISOString(),
    })
    .eq('id', params.contactId)
    .eq('client_id', params.clientId);

  // 6. If score changed: insert into lead_score_history
  if (newScore !== contact.data.lead_score) {
    await supabase.from('lead_score_history').insert({
      client_id: params.clientId,
      contact_id: params.contactId,
      previous_score: contact.data.lead_score,
      new_score: newScore,
      reason: `agent: intent=${params.agentOutput.intent_type}`,
      message_id: params.messageId,
    });
  }

  // 7. If newly hot: trigger escalation
  if (newScore === 'hot' && contact.data.lead_score !== 'hot') {
    await triggerEscalation({
      clientId: params.clientId,
      contactId: params.contactId,
      lastMessage: params.agentOutput.message,
    });
  }
}
```

---

## escalation.ts — hot lead alert system

```typescript
export async function triggerEscalation(params: {
  clientId: string;
  contactId: string;
  lastMessage: string;
}): Promise<void> {

  // 1. Load contact: full_name, phone_e164, lead_score, pipeline_stage,
  //                  assigned_to, conversation_id
  // 2. Load client_config: notification_email, client_brand_name,
  //                        agent_persona_name
  // 3. Load assigned user (if any): full_name, email

  // 4. Send push notification (web push to browser/PWA)
  //    Use the Web Push API / Notification API
  //    Title: "🔴 Hot Lead: [contact full_name]"
  //    Body: last message preview (first 100 chars)
  //    URL: /dashboard/conversations/[conversation_id]
  //    Only send if assigned_to user has push subscription registered

  // 5. Send automated email alert
  sendEscalationEmail({
    to: config.notification_email,           // from client_config
    contactName: contact.full_name ?? contact.phone_e164,
    contactPhone: contact.phone_e164,
    leadScore: 'hot',
    pipelineStage: contact.pipeline_stage,
    lastMessage: params.lastMessage,
    conversationUrl: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/conversations/${conversationId}`,
    brandName: config.client_brand_name,
  });
}
```

### Email sending — use Resend (free tier: 3,000 emails/month)

```bash
npm install resend
```

```
RESEND_API_KEY=re_...         # from https://resend.com — free tier
RESEND_FROM_EMAIL=alerts@yourdomain.com   # verified sender domain
```

```typescript
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

async function sendEscalationEmail(params: {
  to: string;
  contactName: string;
  contactPhone: string;
  leadScore: string;
  pipelineStage: string;
  lastMessage: string;
  conversationUrl: string;
  brandName: string;
}): Promise<void> {

  await resend.emails.send({
    from: process.env.RESEND_FROM_EMAIL!,
    to: params.to,
    subject: `🔴 Hot Lead Alert — ${params.contactName} | ${params.brandName}`,
    html: `
      <h2>Hot Lead Alert</h2>
      <p><strong>${params.contactName}</strong> (${params.contactPhone})
      has been flagged as a hot lead.</p>

      <p><strong>Pipeline stage:</strong> ${params.pipelineStage}</p>

      <p><strong>Last message from contact:</strong></p>
      <blockquote>${params.lastMessage}</blockquote>

      <p>
        <a href="${params.conversationUrl}" style="
          background:#E24B4A;color:#fff;padding:12px 24px;
          border-radius:6px;text-decoration:none;display:inline-block
        ">
          Open Conversation →
        </a>
      </p>

      <p style="color:#888;font-size:12px">
        This is an automated alert from ${params.brandName}'s rewa platform.
        To stop receiving these alerts, update your notification settings
        in the dashboard.
      </p>
    `,
  });
}
```

---

## export.ts — continuous CSV/Excel export

The export reflects the current state of all contacts for a client —
score, stage, signals, and conversation status — updated as contacts
progress.

```typescript
import * as XLSX from 'xlsx';

export interface ContactExportRow {
  name: string;
  phone: string;
  email: string | null;
  lead_score: string;             // cold | warm | hot
  pipeline_stage: string;
  status: string;
  number_type: string;
  region: string | null;
  priority_rank: number | null;
  human_controlled: boolean;
  opted_out: boolean;
  last_contacted_at: string | null;
  last_reply_at: string | null;
  hot_flagged_at: string | null;
}

export async function generateContactsExport(params: {
  clientId: string;
  format: 'csv' | 'xlsx';
}): Promise<Buffer> {

  // 1. Query all contacts for this client
  const { data: contacts } = await supabase
    .from('contacts')
    .select(`
      full_name, phone_e164, email, lead_score, pipeline_stage,
      status, number_type, region, priority_rank, human_controlled,
      opted_out, last_contacted_at, last_reply_at, hot_flagged_at
    `)
    .eq('client_id', params.clientId)
    .order('priority_rank', { ascending: true, nullsLast: true });

  // 2. Map to export rows
  const rows: ContactExportRow[] = contacts.map(c => ({
    name: c.full_name ?? '',
    phone: c.phone_e164,
    email: c.email,
    lead_score: c.lead_score,
    pipeline_stage: c.pipeline_stage,
    status: c.status,
    number_type: c.number_type ?? '',
    region: c.region,
    priority_rank: c.priority_rank,
    human_controlled: c.human_controlled,
    opted_out: c.opted_out,
    last_contacted_at: c.last_contacted_at,
    last_reply_at: c.last_reply_at,
    hot_flagged_at: c.hot_flagged_at,
  }));

  // 3. Generate file using SheetJS
  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Contacts');

  if (params.format === 'xlsx') {
    return Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
  } else {
    return Buffer.from(XLSX.utils.sheet_to_csv(worksheet));
  }
}
```

---

## API routes

```
GET /api/contacts/export?format=xlsx
```
Returns the export file as a download. Protected by Supabase Auth.
Triggers generateContactsExport() and streams the result.

```
POST /api/contacts/:id/score
```
Body: `{ lead_score: 'cold' | 'warm' | 'hot' }`.
Allows a human agent to manually override the lead score.
Inserts a lead_score_history row with reason = 'manual'.
A hot → warm/cold downgrade is only allowed from this route (human).

---

## Trigger.dev scheduled export task

```typescript
// src/trigger/export-contacts.ts
import { schedules } from '@trigger.dev/sdk/v3';

export const exportContactsTask = schedules.task({
  id: 'export-contacts-daily',
  cron: '0 6 * * *',             // 6 AM daily
  run: async (payload) => {
    // For each client:
    //   1. Generate XLSX export
    //   2. Upload to Supabase Storage (contacts-exports/{client_id}/latest.xlsx)
    //   3. Generate a signed URL valid for 24 hours
    //   4. Email the signed URL to client_config.notification_email
  },
});
```

---

## Verification checklist

- [ ] Send a test message with closing signals (requested_visit = true)
      → contact.lead_score updates to 'hot'
- [ ] Score only moves up: warm → cold attempt → stays warm
- [ ] Hot lead triggers escalation email to notification_email
- [ ] Escalation email contains correct contact name, last message, link
- [ ] lead_score_history has correct previous_score and new_score
- [ ] Manual score override via API: hot → warm → inserts history row
- [ ] Export API returns downloadable xlsx with all contacts
- [ ] Export includes hot_flagged_at column correctly populated
- [ ] Resend email delivered (check Resend dashboard logs)
- [ ] Scheduled export task runs and uploads to Supabase Storage

---

## Amendments (approved 2026-09-29 — implementation)

Deviations from the body above, made during implementation. Where this
section and the body disagree, THIS section wins.

1. **Terminal intents (lost / unsubscribed).** `IntentType` in
   `src/lib/agent/types.ts` and `AgentOutputSchema.intent_type` in
   `generate.ts` are extended with `lost` and `unsubscribed`
   (disengagement classification, prompt-documented). They are the
   carve-out to the monotonic rule:
   - `computeLeadScore()` returns `'cold'` for them *before* evaluating
     any signal (a hot-signal sentence inside a bowed-out reply must not
     keep escalation warm for a dead lead).
   - `resolveScoreUpdate(current, new, intentType?)` gained an optional
     third argument. For terminal intents it applies the computed score
     **lower-only** — the one automatic downgrade path, so a disengaged
     contact loses its star instead of sitting hot forever. Two-argument
     calls keep the exact monotonic behaviour from the body above.
   - Terminal intents **freeze** `pipeline_stage` (no forward motion for
     a lost contact) and can never trigger escalation.

2. **Score ownership moved out of persist.ts.** `persist.ts` no longer
   writes `contacts` at all (no `lead_score`, no `pipeline_stage`, and
   the `skipContactUpdate` option is gone). Agent STEP 8 calls
   `updateLeadScore()`, which owns: read → compute → resolve →
   forward-only stage → contact write → `lead_score_history` →
   escalation. `recordLeadScoreChange` was renamed `recordScoreChange`
   and lives in `src/lib/scoring/index.ts`, shared with the manual
   override route (`reason='manual'`).
   Consequently escalation fires at STEP 8, **before** the STEP 9
   WhatsApp send — the assigned human hears about the hot lead even if
   the send then fails or the 24-hour window is closed.

3. **Guardrail fallbacks never reach scoring.** A blocked exchange
   persists the fallback reply only; no score/stage/history write.

4. **Escalation hardening.** All contact-controlled strings
   (name, phone, message body, conversation URL) are HTML-escaped
   before interpolation into the alert email — the sample in the body
   above interpolated raw values. Push goes only to the assigned
   agent's `push_subscriptions` rows (no assignee → push skipped,
   email still fires); subscriptions the push service rejects with
   404/410 are deleted. Escalation never throws.

5. **Manual override route.** `POST /api/contacts/[id]/score` also sets
   `hot_flagged_at` when moving *to* hot — and clears it when moving
   *away* from hot (see 10) — so the star and the export column stay
   consistent, but never fires escalation — the human
   already knows. Same-value submissions return `changed:false` with
   no history row.

6. **Export details.** `GET /api/contacts/export` accepts
   `?format=xlsx|csv` (default xlsx), 400s on anything else, and scopes
   to the caller's client via `requireRole('agent')`. The scheduled
   task upserts one rolling object per client at
   `contacts-exports/{client_id}/latest.xlsx`, signs it with
   `download: true` for 24h, and logs (not fails) clients without a
   `notification_email`.

7. **Env contract.** `RESEND_API_KEY` / `RESEND_FROM_EMAIL` (email
   sending — missing key ⇒ logged no-op) and `WEB_PUSH_PUBLIC_KEY` /
   `WEB_PUSH_PRIVATE_KEY` / `WEB_PUSH_SUBJECT` (VAPID pair from
   `npx web-push generate-vapid-keys`), documented in
   `.env.local.example`.

8. **Unit tests added** (the body's checklist is runtime verification
   against a live project): `scorer.test.ts` (compute + resolve,
   monotonic and carve-out paths), `stage.test.ts` (forward-only stage
   progression + terminal freeze), `export.test.ts` (column
   contract, including `last_reply_at`), and `index.test.ts`
   (updateLeadScore orchestration with a mocked Supabase: unsubscribe
   ⇒ opted_out + no history, lost ⇒ hot→cold + star cleared + raw
   history + no escalation, unchanged ⇒ zero writes, cold→hot ⇒ flag +
   history + escalation, no re-flag when already opted out).

9. **Agent-classified unsubscribe flags `opted_out` (compliance —
   outreach-compliance skill: "stop", "unsubscribe", *or equivalent*).
   The webhook regex only catches keyword phrasings; "remove me from
   your list" reaches the model instead. When `intent_type ===
   'unsubscribed'`, `updateLeadScore()` sets
   `opted_out = true / opted_out_source = 'contact_reply'` in the same
   contact write, returns `optedOut: true`, and the agent then SKIPS
   STEP 9 entirely — the reply row is persisted with status `'failed'`
   up front (never enters the send queue), because compliance requires
   stopping responses immediately, no confirmation message included.
   Two audit details: `contacts.opt_out_message_id` is set to the
   inbound message row (carried in the task payload from the webhook —
   the same column the webhook keyword path writes), and the
   conversation preview/status is NOT advanced by the suppressed reply
   — the webhook's inbound liveness update stays the latest state.
   Every later exchange is blocked by the `opted_out` gate in
   `gates.ts`.

10. **`hot_flagged_at` is a CURRENT-state column.** The body only ever
    set it; the implementation also CLEARS it (→ null) on any
    hot → warm/cold transition, agent path and manual route alike, so
    the export's star column never advertises a lead that is no longer
    hot. `lead_score_history` keeps the transition audit trail.

11. **`push_subscriptions` RLS tightened vs the original draft.**
    SELECT is own-rows-only (`user_id = auth.uid()`), not client-wide —
    an endpoint + key pair is a capability to push to that user's
    device. DELETE allows the row owner (the spec 6 notification UI
    must let an agent remove their own subscription) or an admin.
    Escalation sends via the service role and is unaffected.
