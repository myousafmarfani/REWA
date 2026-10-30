# rewa

**AI-native WhatsApp outreach and CRM for real estate.**

rewa is not a CRM with an AI assistant bolted on. The autonomous agent
is the product. It handles inbound WhatsApp conversations end to end:
reads the full history, retrieves property facts from pgvector, runs
guardrails, replies in a named human persona, scores the lead, and
escalates hot leads to a human — with no draft-and-approve step in the
normal flow.

> **Status: active development, pre-release.** WhatsApp only. The core
> specs (data model, contact cleaning, agent core, sending, scoring,
> and pipeline UI) are implemented in this tree, but rewa is not yet a
> production deployment. Treat this repository as a working system
> under active development, not a finished hosted product.

[![CI](https://github.com/myousafmarfani/REWA/actions/workflows/ci.yml/badge.svg)](https://github.com/myousafmarfani/REWA/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-violet.svg)](./LICENSE)
[![Next.js 16](https://img.shields.io/badge/Next.js-16-black?logo=nextdotjs)](https://nextjs.org)
[![Supabase](https://img.shields.io/badge/Supabase-Postgres%20%2B%20Auth-3ecf8e?logo=supabase)](https://supabase.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript)](https://www.typescriptlang.org)

---

## What rewa does

rewa joins two systems that usually live apart:

- **Upstream — list to conversation.** Contact cleaning and import
  (Excel/CSV), WhatsApp campaign sending, template management, and
  delivery tracking.
- **Downstream — conversation to close.** A shared inbox, Kanban
  pipeline, live lead scoring, hot-lead escalation, and the autonomous
  agent that owns inbound replies.

The agent works like a human sales agent. Contacts do not get an AI
disclosure, an AI label, or a different voice. The persona is named and
configured per client. Every property fact it states — price, floor,
availability, payment plan — must come from retrieved pgvector data. If
the answer is not in the vector store, it says it will check and follow
up; it never invents property data.

## How an inbound message is handled

1. **Hard gates.** `human_controlled`, then `opted_out`, then the
   24-hour service window are checked before any agent work. These are
   database gates, not prompt instructions.
2. **Deterministic opt-out.** Unsubscribe phrasing is matched before
   guardrails can fire, so a "stop" is honoured even when the message
   would otherwise be blocked as out of scope.
3. **History and retrieval.** The conversation is loaded and the
   relevant property chunks are retrieved from pgvector.
4. **Guardrails.** Scope, tone, safety, identity probes, and factual
   grounding are checked as a separate step before generation.
5. **Generation and send.** The agent writes the reply and sends it
   through the WhatsApp Cloud API.
6. **Scoring and escalation.** The lead score updates after the
   exchange. A hot lead is flagged in the UI, pushed to the assigned
   human, and emailed from the platform sender before the outbound
   reply is attempted.

## Current capabilities

- **Contact cleaning** — TypeScript port of the original pipeline:
  E.164 normalisation, exact and near-duplicate detection, region
  classification, priority sorting, and import to Supabase.
- **Autonomous agent** — persona configuration, pgvector retrieval,
  guardrails, structured output, deterministic opt-out, and hard
  `human_controlled` gates.
- **WhatsApp sending** — official Cloud API, campaign fan-out, template
  approval state, rate limiting, and 24-hour window enforcement.
- **Lead scoring** — cold/warm/hot scoring, score history, pipeline
  stage updates, CSV/Excel export, and hot-lead escalation by push and
  email.
- **Pipeline UI** — conversation inbox, Kanban pipeline, lead-score
  badges, hot-lead indicators, campaign management, and the chat-header
  agent toggle.
- **Property context** — pgvector ingestion and retrieval for grounded
  property answers.

### Deliberately out of scope

- **Telegram and Email.** rewa is WhatsApp-only. Do not add schema
  columns, stubs, or sending logic for either channel.
- **Public multi-tenant signup.** Model C is deferred. The supported
  delivery models are a managed, RLS-isolated service and white-label
  single-tenant self-hosting.

## Architecture

| Layer            | Choice                                                     |
| ---------------- | ---------------------------------------------------------- |
| App              | Next.js 16 (App Router), React 19, TypeScript, Tailwind v4 |
| Data             | Supabase — Postgres, Auth, RLS, Storage, pgvector          |
| Agent            | Vercel AI SDK, provider-agnostic model configuration       |
| Background jobs  | Trigger.dev                                                |
| WhatsApp         | Meta WhatsApp Business Cloud API                           |
| Phone validation | `libphonenumber-js`                                        |
| Email alerts     | Resend                                                     |
| Push alerts      | Web Push (VAPID)                                           |
| Tests            | Vitest                                                     |

The database is the single source of truth. There are no file-based
handoffs between modules. Contact imports, campaign sends, agent
replies, and exports all read and write Supabase.

### Repository layout

```text
src/
  app/                 Next.js routes and dashboard pages
  components/rewa/     rewa-specific UI (lead score, agent toggle)
  lib/agent/           gates, history, retrieval, guardrails, generation
  lib/cleaning/        contact cleaning and import
  lib/compliance/      opt-out fast path
  lib/scoring/         scoring, escalation, export
  lib/sending/         WhatsApp send core and rate limiting
  trigger/             Trigger.dev background tasks
specs/                 dependency-ordered build specs 1–6
supabase/migrations/   authoritative rewa migration chain
supabase/migrations/_wacrm_retired/   retired wacrm baseline (do not replay)
```

## Getting started

```bash
git clone https://github.com/myousafmarfani/REWA.git
cd REWA
npm install
cp .env.local.example .env.local
npm run dev
```

You also need a Supabase project, a Meta WhatsApp app, and a Trigger.dev
project. The full setup path is in **[docs/README.md](./docs/README.md)**.

Useful commands:

| Command             | What it does                    |
| ------------------- | ------------------------------- |
| `npm run dev`       | Development server on port 3000 |
| `npm run build`     | Production build                |
| `npm run lint`      | ESLint                          |
| `npm run typecheck` | `tsc --noEmit`                  |
| `npm run test`      | Vitest                          |
| `npm run format`    | Prettier                        |

### Migration warning

The inherited wacrm baseline (migrations `001`–`039`) is **retired** and
lives in `supabase/migrations/_wacrm_retired/`. It is not part of the
rewa chain. The authoritative migrations are:

```text
20260824000000_data_model_spec1.sql
20260824000001_agent_core_spec3.sql
20260824000002_auth_bridge.sql
20260920000000_sending_spec4.sql
20260922000000_scoring_spec5.sql
20260923000000_drop_auth_bridge_views.sql
20261016000000_touch_presence_stub.sql
```

Do **not** replay the retired wacrm baseline, and do not recreate its
tables (`whatsapp_config`, `accounts`, `broadcasts`, `flows`,
`automations`, `tags`, `contact_tags`, `custom_fields`, `api_keys`,
`webhook_endpoints`) on a rewa environment. The CI migration check
(`supabase/ci/verify-schema.sql`) asserts the rewa schema only. See
`MEMORY.md` entry 19 for the full background and remaining cleanup.

## Documentation

- [Setup and operations](./docs/README.md)
- [Docker](./docs/docker.md)
- [Public API (inherited, legacy)](./docs/public-api.md)
- [MCP server (inherited, legacy)](./docs/mcp.md)
- [Build specs](./specs)
- [Architecture decision ledger](./MEMORY.md)
- [Agent instructions](./AGENTS.md)

The public API and MCP server docs describe inherited wacrm surfaces.
They are retained for reference and are not part of the supported rewa
product surface yet. See the legacy notices in each document before
relying on them.

## Contributing

rewa is developed spec-first. Read `MEMORY.md`, `AGENTS.md`, and the
relevant spec before changing behaviour. See
[CONTRIBUTING.md](./CONTRIBUTING.md).

## License and lineage

rewa is MIT-licensed. The original MIT [`LICENSE`](./LICENSE) and its
copyright notice are preserved unchanged.

rewa builds on [wacrm](https://github.com/ArnasDon/wacrm), an
MIT-licensed CRM template for WhatsApp by Arnas Donauskas. The app shell
and parts of the shared inbox/pipeline were forked from that project;
the rewa branding, data model, cleaning pipeline, autonomous agent,
sending pipeline, scoring, and product direction are independent work.
The inherited upstream history is preserved in
[`CHANGELOG.md`](./CHANGELOG.md) and the retired migration baseline.
