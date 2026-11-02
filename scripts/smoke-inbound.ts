#!/usr/bin/env npx tsx
/**
 * Signed end-to-end smoke test for the inbound WhatsApp path.
 *
 *   npx tsx scripts/smoke-inbound.ts "What's the price of the 2BR?"
 *
 * What it does
 *   1. loads .env.local (same loader Next uses)
 *   2. reads the dev client's client_config with the SERVICE-ROLE client
 *      to get wa_phone_number_id and the secret the webhook actually
 *      verifies with — client_config.wa_webhook_secret, decrypted with
 *      ENCRYPTION_KEY. (The route never consults META_APP_SECRET.)
 *   3. builds a real Meta-shaped payload (entry[].changes[].value with
 *      metadata.phone_number_id, contacts, messages) from the sender
 *      +971501234567 and the message body from argv
 *   4. HMAC-SHA256-signs the RAW body and sets X-Hub-Signature-256
 *   5. POSTs to http://localhost:3000/api/webhooks/whatsapp, prints the
 *      status, then polls up to 60s and prints:
 *        - new messages rows for that contact
 *        - contacts.lead_score / pipeline_stage / human_controlled
 *        - lead_score_history rows
 *
 * If the dev client's client_config is missing the WhatsApp values, the
 * script seeds FAKE dev credentials (idempotent, refuses to run with
 * NODE_ENV=production). Sends to Meta then fail by design — the script
 * verifies that failure is handled: the outbound row is marked 'failed'
 * while the inbound message, the agent message and the score update are
 * all still persisted.
 */

import './lib/env';

import {
  BASE_URL,
  DEFAULT_SENDER_PHONE,
  assertCoreEnv,
  assertRepoRoot,
  ensureDevWebhookConfig,
  findAgentMessageSince,
  findMessageByWaId,
  getContactByPhone,
  listMessages,
  listScoreHistory,
  resolveDevClient,
  section,
  sendInboundMessage,
  waitFor,
  waitForLatestAgentMessageReconciled,
} from './lib/harness';

const AGENT_REPLY_TIMEOUT_MS = 60_000;

function parseArgs(argv: string[]): { body: string; phone: string } {
  let phone = process.env.SMOKE_PHONE ?? DEFAULT_SENDER_PHONE;
  const words: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--phone') {
      phone = argv[++i] ?? phone;
      continue;
    }
    if (arg.startsWith('--phone=')) {
      phone = arg.slice('--phone='.length);
      continue;
    }
    words.push(arg);
  }

  const body = words.join(' ').trim();
  return {
    body: body || "What's the price of the 2BR?",
    phone,
  };
}

type MessageRows = Awaited<ReturnType<typeof listMessages>>;

function printMessages(rows: MessageRows): void {
  if (!rows.length) {
    console.log('  (none)');
    return;
  }
  const dateFmt = (iso: string) => new Date(iso).toISOString().slice(11, 19);
  for (const row of rows) {
    const who =
      row.direction === 'inbound' ? '← contact' : `→ ${row.sender_type}`;
    const meta = [
      row.agent_lead_score ? `score=${row.agent_lead_score}` : null,
      row.agent_intent_type ? `intent=${row.agent_intent_type}` : null,
    ]
      .filter(Boolean)
      .join(' ');
    console.log(
      `  ${dateFmt(row.created_at)}  ${who.padEnd(12)} [${row.status}]` +
        `${meta ? `  ${meta}` : ''}  ${JSON.stringify(row.body.slice(0, 90))}`
    );
  }
}

async function main(): Promise<void> {
  assertRepoRoot();
  assertCoreEnv();
  const { body, phone } = parseArgs(process.argv.slice(2));

  section('Target');
  console.log(`  webhook : ${BASE_URL}/api/webhooks/whatsapp`);
  console.log(`  sender  : ${phone}`);
  console.log(`  body    : ${JSON.stringify(body)}`);

  const client = await resolveDevClient();
  const waConfig = await ensureDevWebhookConfig(client.id);

  section('Client config');
  console.log(`  client            : ${client.name} (${client.id})`);
  console.log(`  wa_phone_number_id: ${waConfig.phoneNumberId}`);
  console.log(
    `  signature secret  : client_config.wa_webhook_secret (decrypted, ` +
      `${waConfig.webhookSecret.length} chars)`
  );
  console.log(
    `  wa_access_token   : ${waConfig.accessToken ? 'set (decrypted)' : 'missing'}`
  );
  if (waConfig.seeded.length) {
    console.log(
      `  ⚠ seeded FAKE dev values for: ${waConfig.seeded.join(', ')} ` +
        '(Meta sends will fail with these — expected)'
    );
  } else {
    console.log('  (no seeding needed — dev config already complete)');
  }

  section('POST');
  const sent = await sendInboundMessage({
    phoneNumberId: waConfig.phoneNumberId,
    webhookSecret: waConfig.webhookSecret,
    fromPhone: phone,
    body,
    contactName: 'Smoke Inbound',
  });
  console.log(`  status  : ${sent.status}`);
  console.log(`  response: ${sent.bodyText}`);
  console.log(`  wamid   : ${sent.waMessageId}`);

  if (sent.status !== 200) {
    console.error(
      '\n❌ The webhook did not accept the payload. 401 = HMAC mismatch, ' +
        '400 = bad payload shape. Nothing further to poll.'
    );
    process.exitCode = 1;
    return;
  }

  const inboundRow = await waitFor(
    () => findMessageByWaId(client.id, sent.waMessageId),
    { timeoutMs: 20_000, label: 'inbound message row' }
  );
  if (!inboundRow) {
    console.error(
      '\n❌ The webhook returned 200 but never persisted the inbound ' +
        'message. Check the dev server log for after() failures.'
    );
    process.exitCode = 1;
    return;
  }
  console.log(`  inbound row persisted: ${inboundRow.id}`);

  const contact = await waitFor(() => getContactByPhone(client.id, phone), {
    timeoutMs: 10_000,
    label: 'contact row',
  });
  if (!contact) {
    console.error('\n❌ No contact row was created for the sender.');
    process.exitCode = 1;
    return;
  }

  console.log('');
  console.log('  polling up to 60s for the agent reply…');
  const reply = await waitFor(
    () => findAgentMessageSince(client.id, contact.id, inboundRow.created_at),
    {
      timeoutMs: AGENT_REPLY_TIMEOUT_MS,
      intervalMs: 1500,
      label: 'agent reply',
    }
  );

  // Scoring runs AFTER the reply row is persisted; give it a moment.
  if (reply) {
    await waitFor(
      async () => (await listScoreHistory(client.id, contact.id)).length > 0,
      { timeoutMs: 15_000, intervalMs: 1000, label: 'lead_score_history row' }
    ).catch(() => null);

    // The send to Meta is a separate network step; wait for the row to
    // leave 'pending' so the status we print is the real outcome.
    await waitForLatestAgentMessageReconciled(
      client.id,
      contact.id,
      30_000
    ).catch(() => null);
  }

  const messages = await listMessages(client.id, contact.id);
  const finalContact = (await getContactByPhone(client.id, phone)) ?? contact;
  const history = await listScoreHistory(client.id, contact.id);

  section('messages rows for this contact');
  printMessages(messages);

  section('contacts');
  console.log(`  lead_score      : ${finalContact.lead_score}`);
  console.log(`  pipeline_stage  : ${finalContact.pipeline_stage}`);
  console.log(`  human_controlled: ${finalContact.human_controlled}`);
  console.log(`  opted_out       : ${finalContact.opted_out}`);
  console.log(`  last_inbound_at : ${finalContact.last_inbound_at ?? '—'}`);

  section('lead_score_history rows');
  if (!history.length) {
    console.log('  (none)');
  } else {
    for (const row of history) {
      console.log(
        `  ${row.changed_at}  ${row.previous_score ?? '∅'} → ${row.new_score}` +
          `  (${row.reason ?? 'no reason'})`
      );
    }
  }

  // ---------------------------------------------------------------------
  // Send-failure handling verdict (requirement 2).
  // With seeded/fake credentials Meta rejects the send; the pipeline must
  // still have persisted everything and marked the outbound row failed.
  // ---------------------------------------------------------------------
  section('send-failure handling');
  const agentRows = messages.filter((m) => m.sender_type === 'agent');
  const latestAgent = agentRows.at(-1);
  let failures = 0;

  const check = (ok: boolean, line: string) => {
    console.log(`  ${ok ? '✅' : '❌'} ${line}`);
    if (!ok) failures++;
  };

  check(Boolean(inboundRow), 'inbound message persisted');
  check(Boolean(reply), 'agent message persisted (agent did not crash)');

  if (latestAgent) {
    if (latestAgent.status === 'failed') {
      check(
        true,
        "outbound row marked 'failed' (Meta rejected the fake token — handled)"
      );
    } else if (latestAgent.status === 'sent') {
      check(
        true,
        "outbound row marked 'sent' (a real credential is configured)"
      );
    } else {
      check(
        false,
        `outbound row is still '${latestAgent.status}' — the sending layer ` +
          'never reconciled it (pending phantom)'
      );
    }
  } else {
    check(false, 'no agent message to inspect — the agent never replied');
  }

  check(history.length > 0, 'score update recorded in lead_score_history');
  check(
    ['cold', 'warm', 'hot'].includes(finalContact.lead_score),
    `contacts.lead_score is a known value (${finalContact.lead_score})`
  );

  if (!reply) {
    console.log('');
    console.log(
      '  The agent reply never appeared. Most likely causes:\n' +
        '    · `npx trigger.dev@latest dev` is not running (the webhook only\n' +
        '      enqueues; the task does the work)\n' +
        '    · the model in AI_MODEL is not available for the configured key\n' +
        '    · the Trigger.dev run failed — check its dashboard / terminal'
    );
  }

  console.log('');
  if (failures === 0) {
    console.log('✅ smoke-inbound PASS');
  } else {
    console.log(`❌ smoke-inbound FAIL (${failures} invariant(s) broken)`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('\n💥 smoke-inbound crashed:', error);
  process.exitCode = 1;
});
