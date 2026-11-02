# scripts — inbound smoke tests

Dev-only end-to-end checks for the rewa inbound WhatsApp path. They POST
a **genuinely signed** Meta webhook payload at the running dev server and
then read the resulting rows back out of Supabase with the service-role
client. Nothing in `src/` is stubbed, mocked or bypassed.

## Three terminals

| Terminal | Command                       | Why                                                                                                                                           |
| -------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1        | `npm run dev`                 | Next.js app on `http://localhost:3000` — receives the webhook, and its `after()` hook persists + enqueues.                                    |
| 2        | `npx trigger.dev@latest dev`  | Runs the `process-inbound-message` task (`src/trigger/process-message.ts`), which is what actually runs the agent. The webhook only enqueues. |
| 3        | `npx tsx scripts/<script>.ts` | The smoke scripts below.                                                                                                                      |

Without terminal 2 the webhook still returns 200 and the inbound message
is still persisted — but no agent reply, agent message row or score
update will ever appear. That is the single most common reason a smoke
run reports "no agent reply".

The scripts load `.env.local` with Next's own env loader, so run them
**from the repo root**.

## Scripts

### `smoke-inbound.ts` — one signed message, full trace

```bash
npx tsx scripts/smoke-inbound.ts "What's the price of the 2BR?"
npx tsx scripts/smoke-inbound.ts --phone +971501234567 "Are you a bot?"
```

What it does:

1. loads `.env.local`
2. reads the dev client (`clients.slug = 'dev'`) and its `client_config`
   with the service-role client, to get `wa_phone_number_id`
3. takes the signature secret from **`client_config.wa_webhook_secret`**
   (decrypted with `ENCRYPTION_KEY`) — this is what
   `src/app/api/webhooks/whatsapp/route.ts` verifies with.
   `META_APP_SECRET` is **not** used by the inbound route at all, so
   setting it does not make this test pass.
4. builds a real Meta payload (`entry[].changes[].value` with
   `metadata.phone_number_id`, `contacts`, `messages`) from the sender
   (`+971501234567` by default, `--phone` / `SMOKE_PHONE` to override)
5. HMAC-SHA256-signs the **raw** body and sends `X-Hub-Signature-256`
6. POSTs to `http://localhost:3000/api/webhooks/whatsapp` (`SMOKE_BASE_URL`
   overrides the origin) and prints the HTTP status
7. polls up to 60s and prints: every `messages` row for that contact,
   `contacts.lead_score` / `pipeline_stage` / `human_controlled`, and all
   `lead_score_history` rows
8. prints a **send-failure verdict**: with fake credentials Meta rejects
   the send, and the run must still show the inbound message, the agent
   message and the score update persisted, with the outbound row marked
   `failed`.

### `smoke-ingest-property.ts` — one SAMPLE property

```bash
npx tsx scripts/smoke-ingest-property.ts
npx tsx scripts/smoke-ingest-property.ts --clear
```

Embeds and upserts one clearly-labelled **SAMPLE** property
(`property_id = rewa-sample-2br`: overview, pricing, payment_plan,
amenities) for the dev client. It calls the same lib functions the
`/api/properties/ingest` route calls (`embedText` with
`RETRIEVAL_DOCUMENT` from `src/lib/agent/retrieval`, and the shared
`toVectorLiteral` pgvector helper from `src/lib/pgvector`) and writes
the same row shape with the same `onConflict` target — just using the
service-role client so no dashboard session is needed. `--clear`
deletes the fixture again.

It finishes with a **read-only retrieval probe**: it runs the production
`retrievePropertyContext` path for a pricing question and prints each
chunk's similarity. It also prints a full **query x chunk similarity
matrix** (9 on-topic questions plus 2 irrelevant ones) and checks the
configured threshold against it. The agent only sees chunks above
`RETRIEVAL_SIMILARITY_THRESHOLD` (default 0.58, calibrated from this
data — see MEMORY.md entry 21), so this tells you immediately whether
the fixture is reachable at all.

### `probe-similarity.ts` — calibrate the threshold without a database

```bash
npx tsx scripts/probe-similarity.ts
```

Embeds the 4 SAMPLE chunks with `RETRIEVAL_DOCUMENT` and 11 realistic
questions with `RETRIEVAL_QUERY` (price, payment plan, amenities,
location, viewing, "tell me about the 2BR", plus "what's the weather"
and "do you sell cars"). Prints the query x chunk cosine-similarity
table, the two population extremes, the midpoint, and a PASS/FAIL per
query for the configured threshold. Exits non-zero if no separating
threshold exists or the configured one leaks an off-topic query /
misses an on-topic one. No dev server or Supabase project needed.

Override the production threshold with `RETRIEVAL_SIMILARITY_THRESHOLD`
(an unset or non-numeric value falls back to 0.58).

### `smoke-all.ts` — the full scenario, PASS/FAIL per step

```bash
npx tsx scripts/smoke-all.ts
```

Runs the whole inbound story in order and prints `PASS` / `FAIL` per step
with the evidence (rows, scores, flags). It uses a dedicated test number —
`+971509990001` by default, `SMOKE_PHONE` to override — so it can never
collide with `+971501234567` or with an imported CSV contact.

| Step | What is asserted                                                                                                                                                                                                                          |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a    | **Before anything is ingested**, `"What's the price of the 2BR?"` must not produce a price figure, and the reply must defer ("I'll confirm / check / follow up"). This is the no-fabrication rule.                                        |
| b    | The SAMPLE property ingests cleanly (all chunks embedded + stored).                                                                                                                                                                       |
| c    | `"What's the price and payment plan for the 2BR?"` quotes the sample figures (AED 1,850,000 and the 20%/60% plan) and `lead_score` is `cold` or `warm`.                                                                                   |
| d    | `"I'd like to visit this weekend"` → `lead_score=hot`, `lead_score_history` row, `hot_flagged_at` set, escalation ran before the send and the exchange completed (email may be skipped without `RESEND_API_KEY` — that is not a failure). |
| e    | With `contacts.human_controlled = true`, `"Can you also send the brochure?"` is persisted as inbound but **no agent message** appears within 30s.                                                                                         |
| f    | After resetting `human_controlled`, `"don't contact me again"` sets `opted_out = true` and produces no reply.                                                                                                                             |
| g    | Cleanup: the SAMPLE embeddings are deleted and the test contact (with its messages/conversations/history, via cascade) is removed.                                                                                                        |

Exit code 0 = every step passed. Steps are independent assertions; a
failed step does not stop the later ones from running, so one run shows
you the whole picture.

## Dev-only credential seed

The dev client's `client_config` only needs `wa_phone_number_id`,
`wa_webhook_secret` and `wa_access_token` for the inbound path to work.
If any are missing (or cannot be decrypted under the current
`ENCRYPTION_KEY`), all three scripts call `ensureDevWebhookConfig()`,
which:

- writes **fake** values once, idempotently — only the missing fields
- encrypts the secret and token with `ENCRYPTION_KEY` (the route decrypts
  `wa_webhook_secret` before verifying the HMAC, so it must be stored
  encrypted)
- **refuses to run when `NODE_ENV=production`**

Fake `wa_access_token` ⇒ every outbound send fails at Meta with an auth
error. That is deliberate and is exactly what requirement "confirm the
failure is handled" checks: `sendWhatsAppMessage` marks the persisted
outbound row `failed`, logs the error, and the agent pipeline carries on
— inbound message, agent message and score update are all still written.
`smoke-inbound.ts` prints that verdict explicitly.

## Requirements

- Node 20+ and `npx tsx` (fetched on demand).
- `.env.local` with `NEXT_PUBLIC_SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`, `ENCRYPTION_KEY` — plus a working AI
  provider key (`GOOGLE_GENERATIVE_AI_API_KEY` for `AI_PROVIDER=google`)
  and `AI_MODEL` set to a model that still exists on that provider.
- `TRIGGER_SECRET_KEY` + `TRIGGER_PROJECT_ID` for the webhook to enqueue.

## Common failure modes

| Symptom                                                | Cause                                                                                                                                                                                                                                                           |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| webhook returns `401`                                  | secret mismatch — the row holds a secret encrypted under a different `ENCRYPTION_KEY`, or a real Meta secret you overwrote. Delete `client_config.wa_webhook_secret` to let the dev seed replace it.                                                            |
| webhook returns `200`, no inbound row                  | look at terminal 1 — the `after()` persistence threw (usually a DB/schema problem).                                                                                                                                                                             |
| inbound row, no agent reply                            | terminal 2 not running, `AI_MODEL` retired (`models/… is not found`), or the Trigger.dev run failed.                                                                                                                                                            |
| agent replies but must confirm even though data exists | retrieval returned nothing — run `npx tsx scripts/probe-similarity.ts` and compare against `RETRIEVAL_SIMILARITY_THRESHOLD` (default 0.58). If real chunks never clear it, that is a code finding to report, **not** a smoke-script bug. |
| outbound row stuck `pending`                           | sending never reconciled it — a real finding.                                                                                                                                                                                                                   |

## Resolved findings (smoke run, 2026-10-31)

Both defects below were fixed on 2026-10-31; see MEMORY.md entry 21.

### 1. Retrieval could never clear its own threshold (blocked grounded answers) — fixed

`src/lib/agent/retrieval.ts` used `DEFAULT_SIMILARITY_THRESHOLD = 0.75`
(as specified) and embedded both the document and the query with
`gemini-embedding-001` **without a `taskType`**. With the default task
type, real property chunks plateaued well below 0.75:

| chunk_type   | similarity to `"What's the price and payment plan for the 2BR?"` |
| ------------ | ---------------------------------------------------------------- |
| payment_plan | 0.7010                                                           |
| pricing      | 0.6091                                                           |
| overview     | 0.5898                                                           |
| amenities    | 0.5894                                                           |

`match_property_embeddings` returned 0 rows, the agent got an empty
context block, and it answered "I'm checking and will confirm shortly"
even though the data was in `property_embeddings`.

Fix: documents are now embedded with `RETRIEVAL_DOCUMENT` and queries
with `RETRIEVAL_QUERY` (Google `providerOptions`, 1536 dims), and the
threshold is calibrated from the measured matrix instead of the spec:
0.58 (lowest on-topic expected score 0.6065, highest off-topic best
0.5582). `RETRIEVAL_SIMILARITY_THRESHOLD` overrides it.

### 2. `/api/properties/ingest` could not write a vector — fixed

The route formatted the embedding as `"0.003,-0.006,…"` — pgvector
requires `[0.003,-0.006,…]`. Postgres rejected the write:

```
invalid input syntax for type vector: "0.003363,-0.00689,…"
```

Fix: the route and `retrieval.ts` now both serialise through
`toVectorLiteral` in `src/lib/pgvector.ts`. A route regression test
asserts the bracketed literal, and the smoke fixture calls the same
path instead of its own workaround.

## Rules

These scripts are diagnostic. They must not be used to paper over a
defect: if a smoke run exposes a bug in a spec-complete module, report it
with the evidence instead of changing that module to make the run green.
