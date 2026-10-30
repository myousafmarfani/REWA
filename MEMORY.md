# MEMORY.md — Architecture Decision Ledger
# Project: rewa

Append-only. Numbered. Each entry is a decision that already happened.
Do not contradict a numbered entry without adding a new superseding entry
that explicitly references the one it replaces.

---

1. Product identity: rewa is an AI-native WhatsApp outreach and CRM
   platform for real estate. It is NOT AI-assisted — the agent IS the
   product. Contacts never know they are talking to an AI. The agent has
   a humanised persona (named, consistent voice, context-aware) and
   replies exactly as a knowledgeable human sales agent would.

2. Product scope — two systems merged:
   (A) Upstream: contact cleaning + WhatsApp outbound (ported from the
       original dubai-re-outreach Python pipeline, rewritten in TS).
   (B) Downstream: shared inbox + sales pipeline (forked from wacrm) +
       autonomous AI agent that handles all inbound conversations.
   The AI agent layer is the differentiator — not the CRM UI, not the
   sender. Everything else is infrastructure that makes the agent work.

3. Two delivery models only:
   (A) Managed service — we host on shared infra (RLS-isolated per
       client). Client sends contact export, we run the pipeline, they
       get a dashboard login.
   (B) White-label self-hosted — client owns their own Supabase project,
       AWS account, and WhatsApp Business number. We implement + support
       on retainer. One deployment per client, single-tenant.
   Model C (public multi-tenant SaaS) is explicitly deferred and must
   not be built or scaffolded without a new explicit entry here.

4. Current build scope: WhatsApp only. Telegram and Email channels are
   long-term vision, not current scope. Do not implement, stub, or
   scaffold either one. Any schema design must not block on them, but
   must not actively provision for them either.

5. Tech stack (do not deviate without a new entry here):
   - Runtime: TypeScript monorepo, no Python.
   - App shell: Next.js (App Router) + Tailwind, forked from wacrm.
   - Database: Supabase — Postgres + Auth + RLS + pgvector. This is the
     single source of truth. No Excel or file-based handoffs between
     modules at any point.
   - Background jobs: Inngest or Trigger.dev for campaign sends,
     retries, and resumability.
   - WhatsApp: WhatsApp Business Cloud API (official Meta, TypeScript).
   - AI agent: OpenAI Agents SDK (TS) or Vercel AI SDK agent primitives.
   - Phone validation: libphonenumber-js (TS port of original Python
     libphonenumber logic — all edge cases preserved, see
     contact-cleaning-rules skill).
   - Auth + tenant isolation: Supabase Auth + Row Level Security.
   - Vector/RAG: pgvector inside Supabase — property context for
     grounded agent responses.

6. Tenant isolation rules:
   - Model A: every client-data table has a client_id column + RLS
     policy. This is mandatory, not optional.
   - Model B: single-tenant deployment — no cross-client isolation
     needed, no shared infra assumptions.

7. Contact cleaning — logic carries over exactly from the Python
   pipeline. Edge cases (Excel float numbers, spaces/dashes, near-dupes,
   too-short numbers, empty rows) are not to be reinvented — see the
   contact-cleaning-rules skill. Region-priority sort order is a
   per-client config value, NOT hardcoded (the old UAE→GCC→Western
   default was client-specific and is removed).

8. AI agent behaviour — non-negotiables:
   - The agent is AUTONOMOUS, not draft-and-approve. It reads the full
     conversation history, queries pgvector for property facts, and
     sends the reply directly. No human approval step in the normal flow.
   - The agent must pass a guardrails check before every response: scope,
     tone, safety, and factual grounding. This check runs as a separate
     step before the response is generated — not inside the prompt alone.
   - Every property fact in a response (price, floor, availability,
     payment plan) must be sourced from pgvector. The agent must not
     generate or infer property data from model memory.
   - The agent has a named humanised persona configured per client. The
     contact has no signal — linguistic or contextual — that they are
     speaking to an AI.

9. Lead scoring: every conversation carries a live score evaluated after
   each exchange.
   - cold: browsing, vague interest, no budget signal. Blue indicator.
   - warm: specific unit questions, payment plan / ROI queries, floor
     plan requests. Orange indicator.
   - hot: booking a site visit, asking final price, negotiating terms,
     asking for deal confirmation. Red indicator + star icon.
   Score is stored in Supabase and updated per message. The CSV/Excel
   export is updated continuously and reflects the current score and
   signals for each contact.

10. Hot lead escalation: when a conversation is scored hot (closing
    signals detected), the platform:
    (a) flags the contact as hot with a star icon in the pipeline UI,
    (b) sends a push notification to the assigned human agent,
    (c) sends an automated email from the platform's configured sender
        (set in account settings, not the agent's personal email) to
        that human agent with the contact's name, score, and last
        message.
    This is a platform-level action, not an AI action.

11. Human takeover toggle: a toggle in the chat header (same position as
    the call button in WhatsApp Web) lets a human agent switch off the
    AI for a specific contact. This is stored as a human_controlled
    boolean on the contact/conversation record in Supabase. The agent
    checks this flag as the FIRST step on every inbound webhook — before
    reading history, before querying pgvector, before generating any
    response. It is a hard database gate, not a UI state.

12. Working project name: rewa (Real Estate WhatsApp). Internal and repo
    name only — not a finalised brand. Revisit branding after the first
    client engagement delivers revenue.

13. Development method: Spec-Driven Development using Spec Kit (specify
    CLI) with OpenCode as the executing agent. MEMORY.md and AGENTS.md
    are always read first. Skills in .opencode/skills/ give OpenCode
    industry and compliance depth. Subagents in opencode.json enforce
    review gates before build.

14. Spec build order (dependency-ordered, enforced by MEMORY.md since
    Spec Kit has no native dependency graph):
    1. data-model-spec      — Supabase schema, all tables, RLS, pgvector
    2. cleaning-spec        — contact cleaning TS port, all edge cases
    3. agent-core-spec      — autonomous agent, guardrails, pgvector RAG,
                              persona config, human_controlled gate
    4. sending-spec         — WhatsApp Cloud API, Inngest queue, rate
                              limits, 24-hour window compliance
    5. scoring-spec         — lead scorer, cold/warm/hot, CSV export,
                              hot lead escalation + alert system
    6. pipeline-ui-spec     — wacrm fork, Kanban, lead score indicators,
                              chat header toggle, campaign management
    Each spec goes through the full specify → plan → tasks → implement
    loop and must be approved before the next spec begins.

15. Tech stack decisions locked (supersedes entry 5 where "or" options
    existed — all ambiguity resolved):
    - Background jobs: Trigger.dev (not Inngest). Chosen because it is
      Apache 2.0 open source, fully self-hostable, and job payloads
      never leave the client's own infrastructure — required for Model B
      data ownership compliance. Cloud free tier: 20 concurrent runs,
      unlimited tasks, $0.
    - AI agent SDK: Vercel AI SDK (not OpenAI Agents SDK). Chosen
      because it is a free open-source library, provider-agnostic
      (switch models with one line), built for Next.js, and does not
      require routing through any paid gateway. The SDK itself costs $0.
    - AI model for development/testing: Google Gemini Flash (free tier,
      1,500 req/day) or Groq (free, rate-limited). Switch to Claude
      Sonnet or GPT-4o for production client-facing agent — cost is
      per-token, passed through to client or absorbed in Model A fee.
    - Database: Supabase confirmed (not Neon). Supabase provides Auth +
      RLS + pgvector + Realtime in one platform — switching to Neon
      would require wiring in Clerk, realtime, and RLS separately.
      pgvector is included free on all Supabase plans including free
      tier. Free tier: 500MB storage, 50K MAUs, 2M Realtime messages.
    - App hosting: Vercel free tier (Hobby) for development. For Model B
      production: self-hosted on client's own VPS (Hetzner ~$4.50/month
      or equivalent). For Model A production: Vercel Pro ($20/month) or
      self-hosted.

16. WhatsApp Business API pricing model (January 2026 change — affects
    product economics):
    - Billing is now per-message (not per-conversation) for
      business-initiated template messages.
    - Outbound marketing messages (first-touch campaign): ~$0.01–$0.14
      per message depending on recipient country. This is a client cost,
      passed through in pricing.
    - Inbound replies and all agent responses within the 24-hour service
      window: FREE. The autonomous agent's entire inbound conversation
      handling has zero WhatsApp API cost.
    - Meta policy (effective January 15, 2026): general-purpose AI
      chatbots are prohibited on WhatsApp. Only task-specific agents
      with a defined purpose are allowed. rewa qualifies — it is a
      real estate property consultation agent with a defined scope.
      This must be reflected in every WhatsApp message template
      submission and in the agent's guardrails (scope enforcement).

17. Build cost: $0 to develop. All tools (OpenCode, Next.js, Tailwind,
    Vercel AI SDK, Trigger.dev, libphonenumber-js, Supabase free tier,
    wacrm fork) are free and open source. The only cost incurred during
    build is AI model API calls for testing the agent — use Gemini Flash
    free tier during development to keep this at $0.

---

18. Lead scoring refinements (refines entry 9; scoring-spec 5
    amendments, 2026-09-29):
    - Score ownership: contacts.lead_score / pipeline_stage,
      lead_score_history, and hot-lead escalation are written by
      exactly one module — src/lib/scoring (updateLeadScore). The
      agent persist layer never touches the contacts row.
    - The score is monotonic (auto-up only; human downgrade only via
      POST /api/contacts/[id]/score, reason='manual') with ONE
      automatic exception: the terminal-intent carve-out. The model
      classifies disengaged contacts as intent 'lost' or
      'unsubscribed'; those compute cold, apply lower-only (may drop
      warm/hot → cold), freeze pipeline_stage, and never escalate —
      a dead lead must not carry a star into the daily export.
    - An agent-classified 'unsubscribed' is a full opt-out, not just a
      score event: it sets contacts.opted_out (source
      'contact_reply'), the reply is persisted as failed and NEVER
      sent (compliance skill: stop responding immediately, no
      confirmation), and gates.ts blocks every later exchange. The
      webhook keyword regex stays the fast path; the model covers
      equivalent phrasings it misses.
    - hot_flagged_at is current-state: set on entering hot, cleared on
      any downgrade (agent or manual) so the export star column is
      never stale; transitions live in lead_score_history.
    - Hot escalation fires inside updateLeadScore, i.e. BEFORE the
    agent's outbound WhatsApp send, so a send failure (window
    closed, rate limit) never hides a hot lead from the assigned
    human.

---

19. Known pre-existing inconsistency — the wacrm baseline migration
    chain (001–039) cannot replay against the rewa data model. The
    remote project (nwlprcswsgobtdjttssu) is deliberately rewa-schema-
    only, and the fork's wacrm tables are absent. Recorded here as a
    deferred cleanup, not resolved now:
    - 001 creates contacts(user_id) / conversations / messages /
      profiles; the rewa data-model migration (spec 1) creates the same
      tables unconditionally under a client_id model, so a cold replay
      in filename order fails at the first collision. supabase/ci/
      verify-schema.sql still asserts wacrm objects (whatsapp_config,
      accounts, the chat-media/flow-media buckets), so that CI job does
      not reflect the intended schema either.
    - The remote has exactly the five rewa migrations applied and their
      history recorded (20260824000000, 20260824000001, 20260824000002,
      20260920000000, 20260922000000). The wacrm tables the app code
      still queries (whatsapp_config, broadcasts, flows, automations,
      tags, contact_tags, custom_fields, api_keys, webhook_endpoints)
      do not exist there and belong to superseded fork code — rewa uses
      client_config (sending spec 4), campaigns, and the autonomous
      agent instead.
    - Deferred to spec 6 (pipeline-ui-spec / migration consolidation):
      retire 001–039 from supabase/migrations/, rewrite
      verify-schema.sql to assert the rewa schema, and delete the wacrm
      dead code. Until then, do NOT replay the wacrm baseline or
      fabricate its tables on any environment.

20. Opt-out fast-path hardening (compliance; refines entry 18). The
    webhook opt-out check now lives in src/lib/compliance/opt-out.ts
    (isOptOut) and is unit-tested. It matches unsubscribe-equivalent
    phrasings beyond the bare keywords — "don't / do not / never
    contact|message|text|call|reach|bother|send|write [to] me",
    "remove/delete me | my number", "take me off", "no more messages",
    "stop sending …", "leave me alone", "unsub(s)" and "opt-out"
    (space- or hyphen-joined), "unsubscribe|opt me out" — so an opt-out
    is honoured at the fast path even when the guardrail would otherwise
    block the message before intent classification runs. "block" is
    matched only as "block me | my number" (the bare word hit ordinary
    "which block is the unit in?" enquiries). Two bugs fixed
    in the same change: (a) the Arabic patterns were wrapped in \b,
    which never matches around Arabic (non-word) letters, so they had
    never fired — they now match without boundaries, but each Arabic
    term is kept in opt-out context to avoid tripping on ordinary
    sentences; (b) the opt-out write in the webhook no longer depends on
    the persisted message-row id — if persisting failed the contact is
    still flagged opted_out, and opt_out_message_id is only linked when
    the id is known. Not yet closed: a message the regex misses that the
    guardrail blocks never reaches intent classification, so it is
    answered with a fallback reply instead of opting out — tracked as
    residual; it is not fixable by widening the keyword list alone.
---
