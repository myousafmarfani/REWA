# rewa — OpenCode Agent Instructions

## Read MEMORY.md first, every session
MEMORY.md is the numbered, append-only architecture decision ledger. It
is authoritative over everything in this file. If anything here appears
to contradict a MEMORY.md entry, MEMORY.md wins — flag the conflict,
do not silently resolve it. New architecture decisions go into MEMORY.md
as new numbered entries, never into this file.

---

## What rewa is

rewa is an AI-native WhatsApp outreach and CRM platform for real estate.
It is NOT AI-assisted. The autonomous agent is the product — not a
feature on top of a CRM. Contacts never know they are talking to an AI.
The agent has a humanised persona (named, consistent voice, full
conversation context) and responds exactly as a knowledgeable human
sales agent would. Every property fact it states is grounded in pgvector
data — never generated from model memory.

Two systems merged into one:
- Upstream: contact cleaning + WhatsApp outbound (ported from the
  original dubai-re-outreach Python pipeline, fully rewritten in TS).
- Downstream: shared inbox + sales pipeline (forked from wacrm) + the
  autonomous agent that handles all inbound conversations end-to-end.

---

## Current build scope — enforce this strictly

WhatsApp only. Telegram and Email are deferred. Do not implement, stub,
scaffold, or add schema columns for either one. If a task would touch
Telegram or Email sending logic, stop and flag it.

Model C (public multi-tenant SaaS) is deferred. Do not add public
signup flows, cross-tenant billing, or anything beyond what Model A's
RLS isolation requires.

---

## Who uses it

- Solo agent / broker → Model A (managed service, we host)
- Boutique agency (5–30 agents) → Model A or B
- Brokerage / developer (enterprise) → Model B (white-label self-hosted)

---

## Tech stack — do not deviate

- TypeScript monorepo. No Python anywhere.
- Next.js (App Router) + Tailwind — app shell, forked from wacrm.
- Supabase (Postgres + Auth + RLS + pgvector) — single source of truth.
  No Excel or file-based handoffs between modules at any point.
- Background jobs: Inngest or Trigger.dev.
- WhatsApp: Business Cloud API (official Meta, TypeScript).
- AI agent: OpenAI Agents SDK (TS) or Vercel AI SDK agent primitives.
- Phone validation: libphonenumber-js.
- Auth + isolation: Supabase Auth + Row Level Security.
- RAG: pgvector inside Supabase.

---

## AI agent behaviour — always enforce these

1. The agent is autonomous. It reads history, queries pgvector, and sends
   the reply. No draft-and-approve in the normal inbound flow.

2. Guardrails run as a separate step before every response — not inside
   the prompt. Check: scope, tone, safety, factual grounding.

3. The human_controlled flag is checked FIRST on every inbound webhook.
   It is a hard database gate. If true, the agent does not respond.

4. Every property fact must come from pgvector retrieval. If the data
   is not in the vector store, the agent says it will check and follow
   up — it never fabricates prices, availability, or payment plans.

5. The agent persona is named and configured per client. Its language,
   tone, and sign-off must be indistinguishable from a human agent.

---

## Subagent rules

Use the correct subagent for each task type:

- @domain-strategist — review specs and features for market/customer fit
  before implementation. Read-only. No code output.
- @compliance-reviewer — review anything touching message sending,
  templates, opt-out, or rate-limiting. Read-only. Must run before any
  sending-spec work begins.
- @spec-writer — draft and refine spec files in /specs. Plan mode only.
  No implementation.
- @backend-builder — implement schema, cleaning logic, sending, jobs,
  and agent tool code against an approved spec only.
- @agent-architect — design and implement the AI agent layer: Agents SDK
  tool definitions, pgvector retrieval, guardrails, persona config,
  structured output schemas.
- @qa-reviewer — review implemented code against its originating spec.
  Read-only. Flags gaps, does not fix them.

---

## Spec build order (MEMORY.md entry 14)

1. data-model-spec
2. cleaning-spec
3. agent-core-spec
4. sending-spec
5. scoring-spec
6. pipeline-ui-spec

Nothing gets implemented without an approved spec. Use plan mode for
all spec drafting. Switch to build mode only after explicit approval.

---

## Skills — load before relevant tasks

- real-estate-outreach-domain — before any feature touching lead
  qualification, pipeline stages, messaging tone, or customer personas.
- outreach-compliance — before any sending, template, opt-out, or
  rate-limiting work. Mandatory before sending-spec.
- contact-cleaning-rules — before any cleaning logic. All edge cases
  from the Python pipeline must be preserved exactly.
- client-delivery-models — before any feature that touches multi-client
  data isolation, deployment config, or client-facing settings.
- ai-agent-design-patterns — before any agent tool definition, RAG
  retrieval, guardrails logic, or persona configuration.