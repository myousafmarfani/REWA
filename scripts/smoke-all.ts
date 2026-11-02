#!/usr/bin/env npx tsx
/**
 * Full inbound scenario smoke test — PASS/FAIL per step with evidence.
 *
 *   npx tsx scripts/smoke-all.ts
 *
 * Prerequisites (see scripts/README.md):
 *   terminal 1  npm run dev
 *   terminal 2  npx trigger.dev@latest dev
 *   terminal 3  npx tsx scripts/smoke-all.ts
 *
 * Steps
 *   a. BEFORE any property is ingested, "What's the price of the 2BR?"
 *      must NOT produce a price — the agent says it will confirm.
 *      (no-fabrication rule, MEMORY entry 8)
 *   b. Ingest the SAMPLE property (labelled fixtures).
 *   c. "What's the price and payment plan for the 2BR?" must quote the
 *      sample figures, lead_score cold or warm.
 *   d. "I'd like to visit this weekend" → hot, history row,
 *      hot_flagged_at set, escalation attempted and non-fatal.
 *   e. human_controlled = true → inbound persisted, NO agent reply.
 *   f. "don't contact me again" → opted_out, no reply.
 *   g. cleanup: delete the SAMPLE embeddings, reset the test contact.
 *
 * Uses a dedicated test number (default +971509990001) so it can never
 * collide with imported CSV contacts.
 */

import './lib/env';

import {
  SCENARIO_PHONE,
  SmokeRunner,
  assert,
  assertCoreEnv,
  assertNotProduction,
  assertRepoRoot,
  countAgentMessagesSince,
  deleteContactByPhone,
  ensureDevWebhookConfig,
  findAgentMessageSince,
  findMessageByWaId,
  findPriceFigures,
  getContactByPhone,
  hasDeferral,
  listMessages,
  listScoreHistory,
  nowIso,
  resolveDevClient,
  section,
  sendInboundMessage,
  setContactFlags,
  sleep,
  waitFor,
  waitForLatestAgentMessageReconciled,
  containsAnyFigure,
} from './lib/harness';
import {
  SAMPLE_CHUNKS,
  SAMPLE_PLAN_FIGURES,
  SAMPLE_PRICE_FIGURES,
  SAMPLE_PROPERTY_ID,
  countPropertyEmbeddings,
  deleteSampleProperty,
  ingestSampleProperty,
  listSamplePropertyChunks,
  probeRetrieval,
} from './lib/sample-property';
import { getSimilarityThreshold } from '@/lib/agent/retrieval';

const REPLY_TIMEOUT_MS = 60_000;
const NO_REPLY_WINDOW_MS = 30_000;

const PROMPT_A = "What's the price of the 2BR?";
const PROMPT_C = "What's the price and payment plan for the 2BR?";
const PROMPT_D = "I'd like to visit this weekend";
const PROMPT_E = 'Can you also send the brochure?';
const PROMPT_F = "don't contact me again";

function quote(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > 220 ? `${flat.slice(0, 220)}…` : flat;
}

/** Send one inbound message, persist-check it, and wait for the agent reply. */
async function exchange(params: {
  runner: SmokeRunner;
  clientId: string;
  webhook: { phoneNumberId: string; webhookSecret: string };
  prompt: string;
}): Promise<{
  sentAt: string;
  inboundRowId: string;
  reply: Awaited<ReturnType<typeof findAgentMessageSince>>;
}> {
  const { runner, clientId, webhook, prompt } = params;
  runner.evidenceLine(`contact → ${JSON.stringify(prompt)}`);

  const sent = await sendInboundMessage({
    phoneNumberId: webhook.phoneNumberId,
    webhookSecret: webhook.webhookSecret,
    fromPhone: SCENARIO_PHONE,
    body: prompt,
    contactName: 'Rewa Smoke Scenario',
  });
  runner.evidenceLine(
    `webhook POST → HTTP ${sent.status} ${sent.bodyText.trim()}`
  );
  assert(
    sent.status === 200,
    `webhook rejected the payload (HTTP ${sent.status})`
  );

  const inboundRow = await waitFor(
    () => findMessageByWaId(clientId, sent.waMessageId),
    { timeoutMs: 20_000, label: 'inbound message row' }
  );
  assert(inboundRow, 'inbound message was not persisted');

  const contact = await waitFor(
    () => getContactByPhone(clientId, SCENARIO_PHONE),
    { timeoutMs: 10_000, label: 'contact row' }
  );
  assert(contact, 'contact row was not created');

  const reply = await waitFor(
    () => findAgentMessageSince(clientId, contact.id, inboundRow.created_at),
    { timeoutMs: REPLY_TIMEOUT_MS, intervalMs: 1500, label: 'agent reply' }
  );

  if (reply) {
    runner.evidenceLine(
      `agent → [${reply.status}] ${JSON.stringify(quote(reply.body))}`
    );
  }

  return { sentAt: inboundRow.created_at, inboundRowId: inboundRow.id, reply };
}

async function main(): Promise<void> {
  assertRepoRoot();
  assertCoreEnv();
  assertNotProduction('run the full inbound smoke scenario');

  const runner = new SmokeRunner();
  const client = await resolveDevClient();
  const webhook = await ensureDevWebhookConfig(client.id);

  section('Setup');
  console.log(`  client        : ${client.name} (${client.id})`);
  console.log(`  test phone    : ${SCENARIO_PHONE}`);
  console.log(`  phone_number_id: ${webhook.phoneNumberId}`);
  console.log(`  secret source : client_config.wa_webhook_secret (decrypted)`);
  if (webhook.seeded.length) {
    console.log(
      `  ⚠ seeded FAKE dev values for: ${webhook.seeded.join(', ')} — ` +
        'Meta sends will fail by design (expected; the assertions account for it)'
    );
  }
  console.log(
    `  AI model      : ${process.env.AI_PROVIDER ?? 'google'}/${process.env.AI_MODEL ?? '(default)'}`
  );
  console.log(
    `  RESEND_API_KEY: ${process.env.RESEND_API_KEY?.trim() ? 'set' : 'not set — escalation email will be skipped (not fatal)'}`
  );

  // Clean slate: no SAMPLE embeddings (step (a) must run before ingest),
  // no leftover test contact from a previous run.
  const leftoverChunks = await listSamplePropertyChunks(client.id);
  if (leftoverChunks.length) {
    const removed = await deleteSampleProperty(client.id);
    console.log(`  🧹 removed ${removed} leftover SAMPLE property chunk(s)`);
  } else {
    console.log(
      '  property_embeddings: no SAMPLE chunks present (good — step a needs none)'
    );
  }
  const previousContact = await deleteContactByPhone(client.id, SCENARIO_PHONE);
  if (previousContact.existed) {
    console.log(
      `  🧹 reset previous test contact (${previousContact.messages} messages, ` +
        `${previousContact.history} score history rows)`
    );
  }

  // -------------------------------------------------------------------
  // (a) no-fabrication before ingest
  // -------------------------------------------------------------------
  await runner.step(
    'a. no-fabrication: no price without pgvector data',
    async () => {
      const storedBefore = await countPropertyEmbeddings(client.id);
      runner.evidenceLine(
        `property_embeddings for this client: ${storedBefore}`
      );
      assert(
        storedBefore === 0,
        `the vector store already holds ${storedBefore} chunk(s) — step (a) ` +
          'can only prove no-fabrication against an empty store. Clear it first.'
      );

      const { reply } = await exchange({
        runner,
        clientId: client.id,
        webhook,
        prompt: PROMPT_A,
      });
      assert(
        reply,
        'no agent reply within 60s — check trigger.dev dev + AI_MODEL'
      );

      const figures = findPriceFigures(reply.body);
      runner.evidenceLine(
        `price-like figures in reply: ${figures.length ? figures.join(', ') : 'none'}`
      );
      assert(
        figures.length === 0,
        `agent stated a price with no retrieved data: ${figures.join(', ')}`
      );

      const deferred = hasDeferral(reply.body);
      runner.evidenceLine(`deferral phrasing present: ${deferred}`);
      assert(
        deferred,
        'agent did not say it would confirm/check/follow up — expected a deferral'
      );
    }
  );

  // -------------------------------------------------------------------
  // (b) ingest the SAMPLE property
  // -------------------------------------------------------------------
  await runner.step(
    'b. ingest SAMPLE property (labelled fixture)',
    async () => {
      const outcomes = await ingestSampleProperty(client.id);
      for (const outcome of outcomes) {
        runner.evidenceLine(
          `${outcome.chunk_type}: ${outcome.status}` +
            (outcome.error ? ` — ${outcome.error}` : '')
        );
      }
      assert(
        outcomes.every((o) => o.status === 'ok'),
        'one or more SAMPLE chunks failed to embed/upsert'
      );

      const stored = await listSamplePropertyChunks(client.id);
      runner.evidenceLine(
        `stored chunks for ${SAMPLE_PROPERTY_ID}: ` +
          `${stored.map((s) => s.chunk_type).join(', ')}`
      );
      runner.evidenceLine(
        'NOTE: fixtures are written through the same shared ingest path as ' +
          '/api/properties/ingest (RETRIEVAL_DOCUMENT embeddings + shared ' +
          'pgvector literal helper).'
      );
      assert(
        stored.length === SAMPLE_CHUNKS.length,
        `expected ${SAMPLE_CHUNKS.length} stored chunks, found ${stored.length}`
      );
    }
  );

  // -------------------------------------------------------------------
  // (c) grounded answer
  // -------------------------------------------------------------------
  await runner.step(
    'c. grounded answer: sample price + payment plan',
    async () => {
      const probe = await probeRetrieval(client.id, PROMPT_C);
      runner.evidenceLine(`retrieval hits after ingest: ${probe.length}`);
      if (probe.length) {
        for (const hit of probe) {
          runner.evidenceLine(
            `  ${hit.similarity.toFixed(4)} ${hit.chunkType} ${quote(hit.content)}`
          );
        }
      } else {
        const raw = await probeRetrieval(client.id, PROMPT_C, 0);
        for (const hit of raw) {
          runner.evidenceLine(
            `  below threshold: ${hit.similarity.toFixed(4)} ${hit.chunkType}`
          );
        }
        runner.evidenceLine(
          `⚠ 0 chunks cleared the ${getSimilarityThreshold().toFixed(2)} similarity threshold — the agent has ` +
            'no grounded context to answer from' +
            (raw.length ? ` (best ${raw[0].similarity.toFixed(4)})` : '')
        );
      }

      const { reply } = await exchange({
        runner,
        clientId: client.id,
        webhook,
        prompt: PROMPT_C,
      });
      assert(reply, 'no agent reply within 60s');

      const price = containsAnyFigure(reply.body, SAMPLE_PRICE_FIGURES);
      runner.evidenceLine(`sample price figure in reply: ${price ?? 'NONE'}`);
      assert(
        price,
        `reply does not contain the sample price (AED 1,850,000): ${quote(reply.body)}`
      );

      const plan = containsAnyFigure(reply.body, SAMPLE_PLAN_FIGURES);
      runner.evidenceLine(
        `sample payment-plan figure in reply: ${plan ?? 'NONE'}`
      );
      assert(
        plan,
        `reply does not contain the sample payment plan (20% / 60%): ${quote(reply.body)}`
      );

      const contact = await getContactByPhone(client.id, SCENARIO_PHONE);
      assert(contact, 'contact row disappeared');
      runner.evidenceLine(
        `contact: lead_score=${contact.lead_score} pipeline_stage=${contact.pipeline_stage}`
      );
      assert(
        contact.lead_score === 'cold' || contact.lead_score === 'warm',
        `expected cold or warm after a pricing question, got '${contact.lead_score}'`
      );
    }
  );

  // -------------------------------------------------------------------
  // (d) hot lead + escalation
  // -------------------------------------------------------------------
  await runner.step(
    'd. hot lead: visit request scores hot + escalates',
    async () => {
      const { reply } = await exchange({
        runner,
        clientId: client.id,
        webhook,
        prompt: PROMPT_D,
      });
      assert(reply, 'no agent reply within 60s');

      const contact = await waitFor(
        async () => {
          const row = await getContactByPhone(client.id, SCENARIO_PHONE);
          return row && row.lead_score === 'hot' ? row : null;
        },
        { timeoutMs: 15_000, intervalMs: 1000, label: 'contact to score hot' }
      );
      assert(contact, 'contact did not reach lead_score=hot');
      runner.evidenceLine(
        `contact: lead_score=${contact.lead_score} pipeline_stage=${contact.pipeline_stage} ` +
          `hot_flagged_at=${contact.hot_flagged_at ?? 'NULL'}`
      );
      assert(
        contact.hot_flagged_at,
        'hot_flagged_at was not set on entering hot'
      );

      const history = await listScoreHistory(client.id, contact.id);
      const hotRow = history.find((row) => row.new_score === 'hot');
      runner.evidenceLine(
        `lead_score_history: ${history
          .map((row) => `${row.previous_score ?? '∅'}→${row.new_score}`)
          .join(', ')}`
      );
      assert(hotRow, 'lead_score_history has no hot transition row');
      runner.evidenceLine(
        `history row: ${hotRow.previous_score ?? '∅'} → ${hotRow.new_score} (${hotRow.reason ?? 'no reason'})`
      );

      // Escalation fires inside updateLeadScore BEFORE the outbound send,
      // so a reconciled outbound row proves the exchange got past it
      // without crashing. The email itself may be skipped (no RESEND key)
      // or fail — escalation.ts never throws, by design.
      const reconciled = await waitForLatestAgentMessageReconciled(
        client.id,
        contact.id,
        30_000
      );
      assert(
        reconciled,
        'outbound row stayed pending — the exchange never reached the send step'
      );
      runner.evidenceLine(
        `escalation attempted: hot flag + history written before send; ` +
          `exchange completed (outbound status=${reconciled.status}). ` +
          `email=${process.env.RESEND_API_KEY?.trim() ? 'attempted' : 'skipped (no RESEND_API_KEY)'} — no crash.`
      );
    }
  );

  // -------------------------------------------------------------------
  // (e) human_controlled hard gate
  // -------------------------------------------------------------------
  await runner.step(
    'e. human_controlled gate: inbound persisted, no reply',
    async () => {
      const contact = await getContactByPhone(client.id, SCENARIO_PHONE);
      assert(contact, 'contact row missing');
      await setContactFlags(client.id, contact.id, { human_controlled: true });
      runner.evidenceLine('set contacts.human_controlled = true');

      const since = nowIso();
      const sent = await sendInboundMessage({
        phoneNumberId: webhook.phoneNumberId,
        webhookSecret: webhook.webhookSecret,
        fromPhone: SCENARIO_PHONE,
        body: PROMPT_E,
        contactName: 'Rewa Smoke Scenario',
      });
      runner.evidenceLine(
        `contact → ${JSON.stringify(PROMPT_E)} (webhook HTTP ${sent.status})`
      );
      assert(
        sent.status === 200,
        `webhook rejected the payload (HTTP ${sent.status})`
      );

      const inboundRow = await waitFor(
        () => findMessageByWaId(client.id, sent.waMessageId),
        { timeoutMs: 20_000, label: 'inbound message row' }
      );
      assert(
        inboundRow,
        'inbound message was not persisted while human_controlled'
      );

      // Wait the full 30s observation window, then confirm no agent row.
      const deadline = Date.now() + NO_REPLY_WINDOW_MS;
      let agentCount = 0;
      while (Date.now() < deadline) {
        agentCount = await countAgentMessagesSince(
          client.id,
          contact.id,
          since
        );
        if (agentCount > 0) break;
        await sleep(2000);
      }
      runner.evidenceLine(
        `inbound persisted: ${inboundRow.id} (status=${inboundRow.status})`
      );
      runner.evidenceLine(
        `agent messages created in the 30s window: ${agentCount} (expected 0)`
      );
      assert(
        agentCount === 0,
        `agent replied ${agentCount} time(s) while human_controlled=true`
      );
    }
  );

  // -------------------------------------------------------------------
  // (f) opt-out
  // -------------------------------------------------------------------
  await runner.step('f. opt-out: opted_out set, no reply sent', async () => {
    const contact = await getContactByPhone(client.id, SCENARIO_PHONE);
    assert(contact, 'contact row missing');
    await setContactFlags(client.id, contact.id, { human_controlled: false });
    runner.evidenceLine('reset contacts.human_controlled = false');

    const since = nowIso();
    const sent = await sendInboundMessage({
      phoneNumberId: webhook.phoneNumberId,
      webhookSecret: webhook.webhookSecret,
      fromPhone: SCENARIO_PHONE,
      body: PROMPT_F,
      contactName: 'Rewa Smoke Scenario',
    });
    runner.evidenceLine(
      `contact → ${JSON.stringify(PROMPT_F)} (webhook HTTP ${sent.status})`
    );
    assert(
      sent.status === 200,
      `webhook rejected the payload (HTTP ${sent.status})`
    );

    await waitFor(() => findMessageByWaId(client.id, sent.waMessageId), {
      timeoutMs: 20_000,
      label: 'inbound opt-out message row',
    });

    const optedOut = await waitFor(
      async () => {
        const row = await getContactByPhone(client.id, SCENARIO_PHONE);
        return row?.opted_out ? row : null;
      },
      { timeoutMs: 20_000, intervalMs: 1000, label: 'contacts.opted_out=true' }
    );
    assert(
      optedOut,
      'contacts.opted_out was not set after an explicit opt-out'
    );
    runner.evidenceLine(
      `contact: opted_out=${optedOut.opted_out} opted_out_at=${optedOut.opted_out_at ?? 'NULL'} ` +
        `source=${optedOut.opted_out_source ?? 'NULL'}`
    );

    const deadline = Date.now() + 10_000;
    let agentCount = 0;
    while (Date.now() < deadline) {
      agentCount = await countAgentMessagesSince(client.id, optedOut.id, since);
      if (agentCount > 0) break;
      await sleep(2000);
    }
    runner.evidenceLine(
      `agent messages after opt-out: ${agentCount} (expected 0)`
    );
    assert(
      agentCount === 0,
      `agent replied after the contact opted out (${agentCount} row(s))`
    );
  });

  // -------------------------------------------------------------------
  // (g) cleanup
  // -------------------------------------------------------------------
  await runner.step(
    'g. cleanup: remove SAMPLE embeddings, reset test contact',
    async () => {
      const contact = await getContactByPhone(client.id, SCENARIO_PHONE);
      const messages = contact ? await listMessages(client.id, contact.id) : [];
      const history = contact
        ? await listScoreHistory(client.id, contact.id)
        : [];
      runner.evidenceLine(
        `evidence snapshot before cleanup: ${messages.length} messages, ` +
          `${history.length} score history rows, ` +
          `lead_score=${contact?.lead_score ?? '—'}, opted_out=${contact?.opted_out ?? '—'}`
      );

      const removedChunks = await deleteSampleProperty(client.id);
      runner.evidenceLine(`deleted ${removedChunks} SAMPLE property chunk(s)`);

      const removedContact = await deleteContactByPhone(
        client.id,
        SCENARIO_PHONE
      );
      runner.evidenceLine(
        `deleted test contact: ${removedContact.existed ? 'yes' : 'no (already gone)'} ` +
          `(${removedContact.messages} messages, ${removedContact.history} history rows)`
      );

      const [chunksAfter, contactAfter] = await Promise.all([
        listSamplePropertyChunks(client.id),
        getContactByPhone(client.id, SCENARIO_PHONE),
      ]);
      runner.evidenceLine(
        `post-cleanup: SAMPLE chunks=${chunksAfter.length}, test contact=${contactAfter ? 'still present' : 'gone'}`
      );
      assert(
        chunksAfter.length === 0,
        'SAMPLE property embeddings still present after cleanup'
      );
      assert(!contactAfter, 'test contact still present after cleanup');
    }
  );

  const exitCode = runner.summary();
  if (exitCode !== 0) {
    console.log('');
    console.log(
      'Tip: a failing step means a real path is broken — do not patch a ' +
        'spec-complete module to make the smoke test green. Report the ' +
        'finding with the evidence above.'
    );
  }
  process.exitCode = exitCode;
}

main().catch((error) => {
  console.error('\n💥 smoke-all crashed:', error);
  process.exitCode = 1;
});
