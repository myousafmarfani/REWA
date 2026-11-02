/**
 * Shared harness for the rewa inbound smoke tests.
 *
 * Everything here is dev-only tooling: it talks to the same Supabase
 * project as the app via the service-role client, builds Meta-shaped
 * webhook payloads, signs them with the SAME per-client secret the
 * webhook route verifies with (client_config.wa_webhook_secret, NOT
 * META_APP_SECRET), and reads back the rows that prove each step.
 *
 * No app module is modified. The only lib functions reused are the
 * production ones (decrypt / supabaseAdmin) so the smoke test exercises
 * the real code paths.
 */

import './env';

import { createHmac, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { supabaseAdmin } from '@/lib/supabase/admin';
import { decrypt, encrypt } from '@/lib/whatsapp/encryption';
import { isProduction } from './env';

export { assertCoreEnv, isProduction } from './env';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const BASE_URL = (
  process.env.SMOKE_BASE_URL ?? 'http://localhost:3000'
).replace(/\/$/, '');

/** Default sender for `smoke-inbound.ts` (spec'd example number). */
export const DEFAULT_SENDER_PHONE = '+971501234567';

/**
 * Dedicated scenario number for `smoke-all.ts`. Deliberately NOT
 * +971501234567, so it can never collide with an imported CSV contact
 * or with a hand-run smoke-inbound message.
 */
export const SCENARIO_PHONE = process.env.SMOKE_PHONE ?? '+971509990001';

export const SAMPLE_PROPERTY_ID = 'rewa-sample-2br';

// Fake-but-realistic dev credentials. Sends to Meta WILL fail (401 /
// invalid token) — that is the point of the send-failure assertion.
export const DEV_FAKE_PHONE_NUMBER_ID = '900000000000001';
export const DEV_FAKE_WEBHOOK_SECRET = 'rewa-dev-smoke-webhook-secret';
export const DEV_FAKE_ACCESS_TOKEN = 'EAAG-rewa-dev-smoke-fake-token';

// ---------------------------------------------------------------------------
// Small utils
// ---------------------------------------------------------------------------

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function digitsOnly(phone: string): string {
  return phone.replace(/\D/g, '');
}

export function log(line = ''): void {
  console.log(line);
}

export function section(title: string): void {
  console.log('');
  console.log(`── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
}

export function assertRepoRoot(): void {
  if (!existsSync(path.join(process.cwd(), 'package.json'))) {
    throw new Error(
      `Run the smoke scripts from the repo root (cwd is ${process.cwd()}).`
    );
  }
}

/** Hard refusal for the destructive / fake-credential paths. */
export function assertNotProduction(what: string): void {
  if (isProduction()) {
    throw new Error(
      `Refusing to ${what} with NODE_ENV=production. These scripts are dev-only.`
    );
  }
}

// ---------------------------------------------------------------------------
// Dev client + client_config
// ---------------------------------------------------------------------------

export interface DevClientRow {
  id: string;
  name: string;
  slug: string;
}

/**
 * Resolve the dev client: slug 'dev' when present, else the single
 * client in the project. Refuses to guess between multiple clients.
 */
export async function resolveDevClient(): Promise<DevClientRow> {
  const sb = supabaseAdmin();

  const { data: bySlug, error: slugError } = await sb
    .from('clients')
    .select('id, name, slug')
    .eq('slug', 'dev')
    .maybeSingle();

  if (slugError) throw new Error(`clients lookup failed: ${slugError.message}`);
  if (bySlug) return bySlug;

  const { data: all, error } = await sb
    .from('clients')
    .select('id, name, slug');
  if (error) throw new Error(`clients lookup failed: ${error.message}`);

  if (!all?.length) {
    throw new Error(
      'No client rows found. Seed the dev client before running smoke tests.'
    );
  }
  if (all.length > 1) {
    throw new Error(
      `No client with slug 'dev' and ${all.length} clients exist — pass a ` +
        'target explicitly once multi-client support lands.'
    );
  }
  return all[0];
}

export interface ClientConfigRow {
  client_id: string;
  agent_persona_name: string;
  client_brand_name: string;
  wa_phone_number_id: string | null;
  wa_access_token: string | null;
  wa_webhook_secret: string | null;
}

export async function loadClientConfig(
  clientId: string
): Promise<ClientConfigRow> {
  const { data, error } = await supabaseAdmin()
    .from('client_config')
    .select(
      'client_id, agent_persona_name, client_brand_name, wa_phone_number_id, wa_access_token, wa_webhook_secret'
    )
    .eq('client_id', clientId)
    .maybeSingle();

  if (error) throw new Error(`client_config lookup failed: ${error.message}`);
  if (!data) {
    throw new Error(
      `No client_config row for client ${clientId}. The agent cannot run without one.`
    );
  }
  return data;
}

function tryDecrypt(ciphertext: string | null): string | null {
  if (!ciphertext) return null;
  try {
    return decrypt(ciphertext);
  } catch {
    return null;
  }
}

export interface WebhookConfig {
  phoneNumberId: string;
  /** Plaintext webhook secret — used to HMAC the smoke payload. */
  webhookSecret: string;
  /** Plaintext access token — only so the script can report what's set. */
  accessToken: string | null;
  seeded: string[];
}

/**
 * Ensure the dev client has the three WhatsApp values the inbound path
 * needs. Idempotent: only fields that are missing (or that cannot be
 * decrypted under the current ENCRYPTION_KEY) are written, and they are
 * written ONCE with fake dev values. Refuses to run in production.
 *
 * The webhook route reads the secret from client_config.wa_webhook_secret
 * (decrypted) — META_APP_SECRET is not consulted by the route at all, so
 * seeding this column is what makes signature verification testable.
 */
export async function ensureDevWebhookConfig(
  clientId: string
): Promise<WebhookConfig> {
  const config = await loadClientConfig(clientId);
  const seeded: string[] = [];

  const needsPhoneId = !config.wa_phone_number_id;
  const needsSecret = !tryDecrypt(config.wa_webhook_secret);
  const needsToken = !tryDecrypt(config.wa_access_token);

  if (needsPhoneId || needsSecret || needsToken) {
    assertNotProduction('seed fake WhatsApp credentials');

    const patch: {
      wa_phone_number_id?: string;
      wa_webhook_secret?: string;
      wa_access_token?: string;
      updated_at?: string;
    } = { updated_at: nowIso() };

    if (needsPhoneId) {
      patch.wa_phone_number_id = DEV_FAKE_PHONE_NUMBER_ID;
      seeded.push('wa_phone_number_id');
    }
    if (needsSecret) {
      patch.wa_webhook_secret = encrypt(DEV_FAKE_WEBHOOK_SECRET);
      seeded.push('wa_webhook_secret');
    }
    if (needsToken) {
      patch.wa_access_token = encrypt(DEV_FAKE_ACCESS_TOKEN);
      seeded.push('wa_access_token');
    }

    const { error } = await supabaseAdmin()
      .from('client_config')
      .update(patch)
      .eq('client_id', clientId);

    if (error) {
      throw new Error(`dev seed of client_config failed: ${error.message}`);
    }
  }

  const fresh = await loadClientConfig(clientId);
  const webhookSecret = tryDecrypt(fresh.wa_webhook_secret);
  if (!fresh.wa_phone_number_id || !webhookSecret) {
    throw new Error(
      'client_config still lacks a usable wa_phone_number_id / wa_webhook_secret'
    );
  }

  return {
    phoneNumberId: fresh.wa_phone_number_id,
    webhookSecret,
    accessToken: tryDecrypt(fresh.wa_access_token),
    seeded,
  };
}

// ---------------------------------------------------------------------------
// Meta webhook payload + HMAC
// ---------------------------------------------------------------------------

export interface InboundPayloadParams {
  phoneNumberId: string;
  fromPhone: string;
  body: string;
  waMessageId?: string;
  contactName?: string;
  timestampSeconds?: number;
}

export function newWaMessageId(): string {
  return `wamid.SMOKE${randomBytes(12).toString('hex').toUpperCase()}`;
}

/** Build a Meta WhatsApp Business Cloud webhook payload (text message). */
export function buildInboundPayload(params: InboundPayloadParams) {
  const from = digitsOnly(params.fromPhone);
  const waMessageId = params.waMessageId ?? newWaMessageId();
  const timestamp = String(
    params.timestampSeconds ?? Math.floor(Date.now() / 1000)
  );
  const contactName = params.contactName ?? 'Rewa Smoke Test';

  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'dev-waba-smoke',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '0000000000',
                phone_number_id: params.phoneNumberId,
              },
              contacts: [{ profile: { name: contactName }, wa_id: from }],
              messages: [
                {
                  from,
                  id: waMessageId,
                  timestamp,
                  type: 'text',
                  text: { body: params.body },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

/** Same HMAC shape the route verifies: sha256=<hex hmac of the RAW body>. */
export function signPayload(rawBody: string, secret: string): string {
  return (
    'sha256=' +
    createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
  );
}

export interface PostResult {
  status: number;
  bodyText: string;
}

export async function postRawInbound(
  rawBody: string,
  signature: string,
  baseUrl: string = BASE_URL
): Promise<PostResult> {
  const res = await fetch(`${baseUrl}/api/webhooks/whatsapp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hub-Signature-256': signature,
    },
    body: rawBody,
  });
  const bodyText = await res.text();
  return { status: res.status, bodyText };
}

export interface InboundSendResult extends PostResult {
  waMessageId: string;
  sentAt: string;
  payload: ReturnType<typeof buildInboundPayload>;
}

/**
 * Build → sign → POST one inbound text message. Returns the webhook
 * status plus the wa_message_id so callers can poll the messages table.
 */
export async function sendInboundMessage(params: {
  phoneNumberId: string;
  webhookSecret: string;
  fromPhone: string;
  body: string;
  waMessageId?: string;
  contactName?: string;
  baseUrl?: string;
}): Promise<InboundSendResult> {
  const waMessageId = params.waMessageId ?? newWaMessageId();
  const payload = buildInboundPayload({
    phoneNumberId: params.phoneNumberId,
    fromPhone: params.fromPhone,
    body: params.body,
    waMessageId,
    contactName: params.contactName,
  });
  const rawBody = JSON.stringify(payload);
  const signature = signPayload(rawBody, params.webhookSecret);
  const sentAt = nowIso();
  const res = await postRawInbound(rawBody, signature, params.baseUrl);
  return { ...res, waMessageId, sentAt, payload };
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

export async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  opts: { timeoutMs: number; intervalMs?: number; label: string }
): Promise<T | null> {
  const interval = opts.intervalMs ?? 1000;
  const deadline = Date.now() + opts.timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value as T;
    } catch (error) {
      lastError = error;
    }
    await sleep(interval);
  }

  if (lastError) {
    throw new Error(
      `timed out after ${opts.timeoutMs}ms waiting for ${opts.label} ` +
        `(last error: ${lastError instanceof Error ? lastError.message : String(lastError)})`
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// DB reads/writes used by the assertions
// ---------------------------------------------------------------------------

export interface ContactRow {
  id: string;
  phone_e164: string;
  lead_score: string;
  pipeline_stage: string;
  human_controlled: boolean;
  opted_out: boolean;
  opted_out_at: string | null;
  opted_out_source: string | null;
  hot_flagged_at: string | null;
  last_inbound_at: string | null;
  assigned_to: string | null;
}

const CONTACT_COLUMNS =
  'id, phone_e164, lead_score, pipeline_stage, human_controlled, opted_out, opted_out_at, opted_out_source, hot_flagged_at, last_inbound_at, assigned_to';

export async function getContactByPhone(
  clientId: string,
  phone: string
): Promise<ContactRow | null> {
  const { data, error } = await supabaseAdmin()
    .from('contacts')
    .select(CONTACT_COLUMNS)
    .eq('client_id', clientId)
    .eq('phone_e164', phone)
    .maybeSingle();

  if (error) throw new Error(`contact lookup failed: ${error.message}`);
  return data;
}

export async function getContactById(
  clientId: string,
  contactId: string
): Promise<ContactRow | null> {
  const { data, error } = await supabaseAdmin()
    .from('contacts')
    .select(CONTACT_COLUMNS)
    .eq('client_id', clientId)
    .eq('id', contactId)
    .maybeSingle();

  if (error) throw new Error(`contact lookup failed: ${error.message}`);
  return data;
}

export interface MessageRow {
  id: string;
  direction: string;
  sender_type: string;
  body: string;
  status: string;
  wa_message_id: string | null;
  created_at: string;
  agent_lead_score: string | null;
  agent_intent_type: string | null;
}

const MESSAGE_COLUMNS =
  'id, direction, sender_type, body, status, wa_message_id, created_at, agent_lead_score, agent_intent_type';

export async function listMessages(
  clientId: string,
  contactId: string
): Promise<MessageRow[]> {
  const { data, error } = await supabaseAdmin()
    .from('messages')
    .select(MESSAGE_COLUMNS)
    .eq('client_id', clientId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true });

  if (error) throw new Error(`messages lookup failed: ${error.message}`);
  return data ?? [];
}

export async function findMessageByWaId(
  clientId: string,
  waMessageId: string
): Promise<MessageRow | null> {
  const { data, error } = await supabaseAdmin()
    .from('messages')
    .select(MESSAGE_COLUMNS)
    .eq('client_id', clientId)
    .eq('wa_message_id', waMessageId)
    .maybeSingle();

  if (error) throw new Error(`messages lookup failed: ${error.message}`);
  return data;
}

/**
 * Newest agent-authored message created strictly after `sinceIso`.
 * This is the observation the "agent did / did not reply" assertions use.
 */
export async function findAgentMessageSince(
  clientId: string,
  contactId: string,
  sinceIso: string
): Promise<MessageRow | null> {
  const { data, error } = await supabaseAdmin()
    .from('messages')
    .select(MESSAGE_COLUMNS)
    .eq('client_id', clientId)
    .eq('contact_id', contactId)
    .eq('sender_type', 'agent')
    .gt('created_at', sinceIso)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`agent message lookup failed: ${error.message}`);
  return data;
}

export async function countAgentMessagesSince(
  clientId: string,
  contactId: string,
  sinceIso: string
): Promise<number> {
  const { count, error } = await supabaseAdmin()
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', clientId)
    .eq('contact_id', contactId)
    .eq('sender_type', 'agent')
    .gt('created_at', sinceIso);

  if (error) throw new Error(`agent message count failed: ${error.message}`);
  return count ?? 0;
}

/**
 * The newest agent row, once the sending layer has reconciled it out of
 * 'pending' (-> 'sent' or 'failed'). Sending talks to Meta over the
 * network, so the row stays 'pending' for a moment after the agent
 * completes. Returns null if it is still pending at timeout.
 */
export async function waitForLatestAgentMessageReconciled(
  clientId: string,
  contactId: string,
  timeoutMs = 30_000
): Promise<MessageRow | null> {
  return waitFor(
    async () => {
      const rows = await listMessages(clientId, contactId);
      const latest = rows.filter((row) => row.sender_type === 'agent').at(-1);
      return latest && latest.status !== 'pending' ? latest : null;
    },
    { timeoutMs, intervalMs: 1000, label: 'outbound row reconciliation' }
  );
}

export interface ScoreHistoryRow {
  id: string;
  previous_score: string | null;
  new_score: string;
  reason: string | null;
  changed_at: string;
  message_id: string | null;
}

export async function listScoreHistory(
  clientId: string,
  contactId: string
): Promise<ScoreHistoryRow[]> {
  const { data, error } = await supabaseAdmin()
    .from('lead_score_history')
    .select('id, previous_score, new_score, reason, changed_at, message_id')
    .eq('client_id', clientId)
    .eq('contact_id', contactId)
    .order('changed_at', { ascending: true });

  if (error)
    throw new Error(`lead_score_history lookup failed: ${error.message}`);
  return data ?? [];
}

export async function setContactFlags(
  clientId: string,
  contactId: string,
  patch: {
    human_controlled?: boolean;
    opted_out?: boolean;
    opted_out_at?: string | null;
    opted_out_source?: 'contact_reply' | 'manual' | 'import' | null;
    hot_flagged_at?: string | null;
    lead_score?: string;
    pipeline_stage?: string;
    last_inbound_at?: string | null;
  }
): Promise<void> {
  const { error } = await supabaseAdmin()
    .from('contacts')
    .update({ ...patch, updated_at: nowIso() })
    .eq('client_id', clientId)
    .eq('id', contactId);

  if (error) throw new Error(`contact update failed: ${error.message}`);
}

/**
 * Delete the contact and everything hanging off it (messages,
 * conversations and lead_score_history all cascade from contacts).
 * Used to make the scenario re-runnable from a clean state.
 *
 * Returns what was removed, for evidence.
 */
export async function deleteContactByPhone(
  clientId: string,
  phone: string
): Promise<{ existed: boolean; messages: number; history: number }> {
  const contact = await getContactByPhone(clientId, phone);
  if (!contact) return { existed: false, messages: 0, history: 0 };

  const [messages, history] = await Promise.all([
    listMessages(clientId, contact.id),
    listScoreHistory(clientId, contact.id),
  ]);

  const { error } = await supabaseAdmin()
    .from('contacts')
    .delete()
    .eq('client_id', clientId)
    .eq('id', contact.id);

  if (error) throw new Error(`contact delete failed: ${error.message}`);

  return {
    existed: true,
    messages: messages.length,
    history: history.length,
  };
}

// ---------------------------------------------------------------------------
// Text heuristics (no-fabrication assertions)
// ---------------------------------------------------------------------------

/**
 * Find anything that reads like a money figure. Deliberately biased
 * toward over-reporting: in the no-fabrication test a false positive is
 * a reported finding, never a silent pass.
 */
export function findPriceFigures(text: string): string[] {
  const matches = new Set<string>();

  const patterns: RegExp[] = [
    /\b(?:AED|USD|EUR|GBP|SAR|QAR|د\.إ)\s*[\d][\d,.]*/gi,
    /[$€£]\s*\d[\d,.]*/g,
    /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/g,
    /\b\d+(?:\.\d+)?\s?(?:k|m|million|thousand)\b/gi,
  ];

  for (const re of patterns) {
    for (const match of text.matchAll(re)) {
      const raw = match[0];
      const start = match.index ?? 0;
      const tail = text.slice(start + raw.length, start + raw.length + 12);
      // Square footage / unit sizes are not prices.
      if (
        /^\s*(sq\.?\s?ft|sqft|sqm|sq\.?\s?m|square|br|bed|bath)/i.test(tail)
      ) {
        continue;
      }
      matches.add(raw.trim());
    }
  }

  return [...matches];
}

/** True when the reply defers (will confirm / check / follow up). */
export function hasDeferral(text: string): boolean {
  return /(confirm|check|verify|follow up|follow-up|get back|let me find out|i'll find out)/i.test(
    text
  );
}

/** Strip thousands separators so "1,850,000" and "1850000" compare equal. */
export function normalizeFigures(text: string): string {
  return text.replace(/(\d),(?=\d)/g, '').toLowerCase();
}

export function containsAnyFigure(
  text: string,
  candidates: string[]
): string | null {
  const normalized = normalizeFigures(text);
  for (const candidate of candidates) {
    if (normalized.includes(normalizeFigures(candidate))) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Step runner (PASS/FAIL per step, evidence printed either way)
// ---------------------------------------------------------------------------

export interface StepOutcome {
  name: string;
  ok: boolean;
  evidence: string[];
  error: string | null;
}

export class AssertionError extends Error {}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AssertionError(message);
}

export class SmokeRunner {
  private outcomes: StepOutcome[] = [];
  private evidence: string[] = [];

  private push(line: string): void {
    this.evidence.push(line);
    console.log(`   · ${line}`);
  }

  evidenceLine(line: string): void {
    this.push(line);
  }

  /**
   * Run one scenario step. `fn` records evidence via `evidenceLine()`
   * and throws (usually via `assert`) to fail the step.
   */
  async step(name: string, fn: () => Promise<void>): Promise<StepOutcome> {
    this.evidence = [];
    section(name);
    let error: string | null = null;
    try {
      await fn();
      console.log(`   ✅ PASS — ${name}`);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      console.log(`   ❌ FAIL — ${name}`);
      console.log(`     reason: ${error}`);
    }
    const outcome: StepOutcome = {
      name,
      ok: error === null,
      evidence: [...this.evidence],
      error,
    };
    this.outcomes.push(outcome);
    return outcome;
  }

  summary(): number {
    section('Summary');
    for (const outcome of this.outcomes) {
      console.log(`${outcome.ok ? 'PASS' : 'FAIL'}  ${outcome.name}`);
      if (!outcome.ok && outcome.error) console.log(`      ↳ ${outcome.error}`);
    }
    const failed = this.outcomes.filter((o) => !o.ok);
    console.log('');
    console.log(
      `${this.outcomes.length - failed.length}/${this.outcomes.length} steps passed` +
        (failed.length ? ` — ${failed.length} FAILED` : '')
    );
    return failed.length === 0 ? 0 : 1;
  }
}
