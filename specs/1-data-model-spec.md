# Spec 1: Data Model
# Project: rewa
# depends_on: nothing (this is the root spec — all others depend on it)
# subagents: @domain-strategist (review) → @compliance-reviewer (review) → @backend-builder (implement)
# mcps: supabase (read schema), context7 (Supabase docs)

---

## Purpose

Define the complete Supabase Postgres schema for rewa. Every other spec
depends on this being correct and migrated first. Nothing gets built
until this spec is fully implemented and verified.

---

## Constraints from MEMORY.md

- Entry 5: Supabase is the single source of truth. No file handoffs.
- Entry 6: Every client-data table needs client_id + RLS (Model A).
- Entry 11: human_controlled is a boolean on the contact record, checked
  first on every inbound webhook before any agent processing.
- Entry 9: lead_score is cold | warm | hot, stored per contact, updated
  per message exchange.
- Entry 15: Trigger.dev for background jobs — schema must support
  idempotent job tracking (no duplicate sends).
- Entry 4: WhatsApp only. No Telegram or Email columns.

---

## Amendments (2026-08-24, post @domain-strategist + @compliance-reviewer)

Both review gates returned CHANGES REQUIRED; all findings were accepted.
This version incorporates:

A1. current_client_id() is SECURITY DEFINER with locked search_path
    (prevents infinite RLS recursion on users).
A2. New table message_templates (#6). Meta-approved templates are rows
    with approval status/language/category; campaigns.template_id FK.
    Business-initiated sends must join status='approved'.
A3. campaigns.template_name replaced by template_id FK (+ denormalised
    template_name text kept for UI display only).
A4. campaign_contacts.params jsonb — per-contact rendered template
    variable snapshot, written at queue/send time.
A5. contacts.wa_window_open REMOVED. Persisted boolean drifts stale and
    enables free-form sends outside the 24-hour window (compliance
    blocker). Replaced by last_inbound_at timestamptz — inbound-only,
    single writer = inbound webhook handler. Window state is derived on
    read: last_inbound_at > now() - interval '24 hours'.
A6. contacts: added requirements jsonb (agent-populated qualification:
    budget_range, bedrooms, area, property_type, purpose),
    lead_source, follow_up_at.
A7. Opt-out evidence: contacts.opted_out_source, opt_out_message_id.
    Consent provenance: contacts.consent_source, consent_at.
    contacts.opted_out is the SOLE hard gate for sends;
    conversations.status='opted_out' is display-only.
A8. property_embeddings.availability column (available | sold |
    reserved | unknown) — queryable so retrieval filters sold units.
A9. client_config: SELECT/UPDATE/DELETE restricted to owner/admin roles.
    wa_access_token / wa_webhook_secret store CIPHERTEXT ONLY (app-layer
    AES-GCM or Supabase Vault). Never plaintext.
A10. region_priority defaults to empty array. rewa is a global product —
     NO country-first default (MEMORY.md entry 7: region priority is
     per-client config, set at onboarding).
A11. raw_import retention: purged (set null) once contact status is
     clean/invalid and 30 days have elapsed since import completion;
     purge job owned by cleaning-spec. Contact-level right-to-erasure =
     delete the contacts row (FK cascades cover messages, conversations,
     lead_score_history, campaign_contacts).
A12. RLS also enabled on clients itself (members read own client row;
     owner modifies). Helper current_user_role() added for role-restricted
     policies.

---

## Tables

### 1. clients
Represents a client organisation (one row per Model A client, or one
row for the single tenant in Model B).

```sql
create table clients (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  slug            text not null unique,         -- used in URLs
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
```

### 2. client_config
Per-client configuration. One row per client. Stores agent persona,
WhatsApp credentials, notification settings, region priority.

```sql
create table client_config (
  id                    uuid primary key default gen_random_uuid(),
  client_id             uuid not null references clients(id) on delete cascade,
  agent_persona_name    text not null default 'Sara',
  agent_tone            text not null default 'professional_warm',
                        -- values: professional_warm | conversational | formal
  agent_language        text not null default 'en',
  agent_sign_off        text not null default 'Best,',
  client_brand_name     text not null,
  escalation_phrase     text not null default 'Let me connect you with our senior advisor.',
  wa_phone_number_id    text,                   -- WhatsApp Business phone number ID
  wa_access_token       text,                   -- CIPHERTEXT ONLY (app AES-GCM or Vault)
  wa_webhook_secret     text,                   -- CIPHERTEXT ONLY; webhook verification
  notification_email    text,                   -- hot-lead alert destination (platform alerting
                                                -- only, MEMORY.md 10 — never a contact channel)
  region_priority       text[] not null default '{}'::text[],
                        -- per-client config, NO country-first default (A10);
                        -- e.g. a Dubai brokerage might set {UAE,GCC,SouthAsia,...}
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique(client_id)
);
```

### 3. users
Human agents/brokers who log into the rewa dashboard. Linked to
Supabase Auth via auth.users.

```sql
create table users (
  id          uuid primary key references auth.users(id) on delete cascade,
  client_id   uuid not null references clients(id) on delete cascade,
  full_name   text not null,
  email       text not null,
  role        text not null default 'agent',
              -- values: owner | admin | agent
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
```

### 4. contacts
The cleaned, validated contact list. One row per unique E.164 phone
number per client. This is the output of the cleaning pipeline and the
input to campaigns.

```sql
create table contacts (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid not null references clients(id) on delete cascade,

  -- Identity
  full_name         text,
  phone_e164        text not null,              -- normalised E.164, e.g. +971501234567
  email             text,
  email_type        text,                       -- personal | business | generic | invalid

  -- Cleaning output
  status            text not null default 'pending',
                    -- pending | clean | invalid | review | duplicate
                    -- NOTE: 'duplicate' rows never coexist with the unique constraint —
                    -- Spec 2 (cleaning-spec) resolves dupes pre-insert; the status value
                    -- is reserved for import-report bookkeeping only.
  invalid_reason    text,                       -- empty | too_short | parse_failed | invalid_region
  number_type       text,                       -- mobile | landline | voip | unknown
  region            text,                       -- derived from E.164 country code
  carrier           text,
  is_premium        boolean not null default false,
  priority_rank     integer,                    -- lower = higher priority = sent first

  -- Lead state
  lead_score        text not null default 'cold',
                    -- cold | warm | hot
  pipeline_stage    text not null default 'new_lead',
                    -- new_lead | contacted | qualified | viewing_booked |
                    -- offer_made | negotiation | closed_won | closed_lost
  requirements      jsonb,                      -- agent-populated qualification object:
                    -- {budget_range, bedrooms, area, property_type, purpose(investor|end_user)}
  follow_up_at      timestamptz,                -- timed callback intent set by agent/human
  lead_source       text,                       -- portal | referral | campaign:<id> | manual | ...
  hot_flagged_at    timestamptz,
  opted_out         boolean not null default false,
                    -- SOLE hard gate for any send (A7). Display copies elsewhere
                    -- (conversations.status) are never authoritative.
  opted_out_at      timestamptz,
  opted_out_source  text check (opted_out_source in ('contact_reply','manual','import')),
  opt_out_message_id uuid references messages(id),   -- added post-create, see below
  consent_source    text check (consent_source in ('imported_list','prior_whatsapp_chat','manual')),
  consent_at        timestamptz,

  -- Agent control
  human_controlled  boolean not null default false,
                    -- CHECKED FIRST on every inbound webhook
  assigned_to       uuid references users(id),

  -- Activity tracking
  last_contacted_at timestamptz,                -- last OUTBOUND send time (campaign or reply)
  last_inbound_at   timestamptz,                -- last INBOUND message time. Single writer:
                    -- inbound webhook handler ONLY. 24-hour window derives from this:
                    -- window open <=> last_inbound_at > now() - interval '24 hours'
  raw_import        jsonb,                      -- original row from import; purged per A11
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  unique(client_id, phone_e164)
);

-- Deferred FK (messages references contacts above): added after both exist
alter table contacts
  add constraint contacts_opt_out_message_id_fkey
  foreign key (opt_out_message_id) references messages(id);
```

### 5. campaigns
A batch outbound send. One campaign = one contact list + one Meta-
approved message template + one scheduled send time.

```sql
create table campaigns (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references clients(id) on delete cascade,
  name            text not null,
  status          text not null default 'draft',
                  -- draft | scheduled | running | paused | completed | failed
  template_id     uuid not null references message_templates(id),
                  -- send path must verify template status = 'approved' (A2)
  template_name   text,                        -- denormalised for UI display only
  scheduled_at    timestamptz,
  started_at      timestamptz,
  completed_at    timestamptz,
  total_contacts  integer not null default 0,
  sent_count      integer not null default 0,
  failed_count    integer not null default 0,
  created_by      uuid references users(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
```

### 6. message_templates
Meta-approved WhatsApp templates per client. Enforces at the DB layer
that business-initiated sends reference an approved template, with
Meta's per-language approval model and Jan-2026 per-message billing
categories (MEMORY.md 16).

```sql
create table message_templates (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid not null references clients(id) on delete cascade,
  name             text not null,              -- Meta template name
  meta_template_id text,                       -- Meta-side template ID once submitted
  language         text not null default 'en', -- Meta approves PER LANGUAGE
  category         text not null default 'marketing',
                   -- marketing | utility | authentication (drives cost)
  status           text not null default 'pending',
                   -- pending | approved | rejected | paused | disabled
  body_text        text not null,
  variable_count   integer not null default 0, -- {{1}},{{2}},... slot count
  rejected_reason  text,
  approved_at      timestamptz,
  last_verified_at timestamptz,                -- last sync with Meta template API
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique(client_id, name, language)
);
```

### 7. campaign_contacts
Join table: which contacts are in which campaign, and the send status
per contact.

```sql
create table campaign_contacts (
  id            uuid primary key default gen_random_uuid(),
  campaign_id   uuid not null references campaigns(id) on delete cascade,
  contact_id    uuid not null references contacts(id) on delete cascade,
  client_id     uuid not null references clients(id) on delete cascade,
  params        jsonb,                         -- per-contact rendered template variables,
                                                -- snapshotted at queue time (A4)
  status        text not null default 'pending',
                -- pending | queued | sent | failed | skipped
  sent_at       timestamptz,
  failed_at     timestamptz,
  fail_reason   text,                          -- also logs skip/blocked reasons
  wa_message_id text,                          -- returned by WhatsApp API on send
  created_at    timestamptz not null default now(),
  unique(campaign_id, contact_id)
);
```

### 8. conversations
One row per contact. Tracks the current state of the ongoing
conversation between a contact and the agent/human.

```sql
create table conversations (
  id                    uuid primary key default gen_random_uuid(),
  client_id             uuid not null references clients(id) on delete cascade,
  contact_id            uuid not null references contacts(id) on delete cascade,
  assigned_to           uuid references users(id),
                        -- display mirror; contacts.assigned_to is canonical
  status                text not null default 'open',
                        -- open | resolved | opted_out (display-only; the hard
                        -- gate is always contacts.opted_out — A7)
  last_message_at       timestamptz,
  last_message_preview  text,
  unread_count          integer not null default 0,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique(client_id, contact_id)
);
```

### 9. messages
Every individual message — inbound from contact, outbound from agent,
outbound from human. The full conversation history.

```sql
create table messages (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references clients(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  contact_id      uuid not null references contacts(id) on delete cascade,

  direction       text not null,               -- inbound | outbound
  sender_type     text not null,               -- contact | agent | human
  body            text not null,
  wa_message_id   text,                        -- WhatsApp message ID
  wa_timestamp    timestamptz,                 -- timestamp from WhatsApp
  status          text not null default 'sent',
                  -- sent | delivered | read | failed (outbound lifecycle;
                  -- inbound rows stay 'sent')

  -- Agent metadata (populated on agent-generated messages)
  agent_lead_score      text,                  -- score at time of this message
  agent_intent_type     text,                  -- browsing | qualifying | interested | closing
  agent_signals         jsonb,                 -- full signal object from structured output;
                                               -- guardrail verdicts (scope/tone/safety/
                                               -- grounding) are recorded here too
  agent_suggested_stage text,
  agent_needs_follow_up boolean default false,
  agent_follow_up_reason text,

  created_at      timestamptz not null default now()
);
```

### 10. lead_score_history
Append-only log of every lead score change. Used for analytics and
CSV export.

```sql
create table lead_score_history (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references clients(id) on delete cascade,
  contact_id    uuid not null references contacts(id) on delete cascade,
  previous_score text,
  new_score      text not null,                -- cold | warm | hot
  reason         text,
  changed_at     timestamptz not null default now(),
  message_id     uuid references messages(id)
);
```

### 11. property_embeddings
pgvector table for RAG. Stores chunked property listing data as
embeddings. Scoped per client.

```sql
create extension if not exists vector;

create table property_embeddings (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references clients(id) on delete cascade,
  property_id text not null,                   -- client's own property identifier
  chunk_type  text not null,
              -- pricing | floor_plan | amenities | location | payment_plan | overview
  availability text not null default 'unknown',
              -- available | sold | reserved | unknown — queryable so retrieval
              -- filters sold/reserved units instead of risking quoting them (A8)
  content     text not null,                   -- raw text of this chunk
  embedding   vector(1536),                    -- OpenAI text-embedding-3-small dimensions
              -- use vector(768) if using a different embedding model
  metadata    jsonb,                           -- property_name, unit, floor, etc.
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- HNSW index for fast similarity search
create index on property_embeddings
  using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);
```

### 12. contact_imports
Tracks each raw file import. Useful for debugging cleaning runs and
showing import history in the UI.

```sql
create table contact_imports (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references clients(id) on delete cascade,
  filename        text not null,
  row_count_raw   integer not null default 0,
  row_count_clean integer not null default 0,
  row_count_invalid integer not null default 0,
  row_count_review  integer not null default 0,
  row_count_duplicate integer not null default 0,
  status          text not null default 'processing',
                  -- processing | completed | failed
  error_message   text,
  imported_by     uuid references users(id),
  created_at      timestamptz not null default now(),
  completed_at    timestamptz
);
```

---

## Row Level Security (RLS) — Model A

Enable RLS on every client-data table INCLUDING clients itself.

Helper functions are SECURITY DEFINER with a locked search_path —
mandatory, otherwise policies on `users` recurse against `users`' own
RLS and every authed query fails (A1):

```sql
-- Enable RLS on ALL tables
alter table clients            enable row level security;
alter table client_config      enable row level security;
alter table users              enable row level security;
alter table contacts           enable row level security;
alter table campaigns          enable row level security;
alter table message_templates  enable row level security;
alter table campaign_contacts  enable row level security;
alter table conversations      enable row level security;
alter table messages           enable row level security;
alter table lead_score_history enable row level security;
alter table property_embeddings enable row level security;
alter table contact_imports    enable row level security;

-- Helper: current user's client_id (SECURITY DEFINER — A1)
create or replace function current_client_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select client_id from users where id = auth.uid()
$$;

-- Helper: current user's role (avoids recursive subqueries in policies)
create or replace function current_user_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from users where id = auth.uid()
$$;

grant execute on function current_client_id() to authenticated;
grant execute on function current_user_role() to authenticated;
```

### Standard policy pattern (contacts, campaigns, message_templates,
### campaign_contacts, conversations, messages, lead_score_history,
### property_embeddings, contact_imports, users)

Four policies each, substituting the table name:

```sql
-- SELECT
create policy "users can read own client data"
  on <table> for select
  using (client_id = current_client_id());

-- INSERT
create policy "users can insert own client data"
  on <table> for insert
  with check (client_id = current_client_id());

-- UPDATE
create policy "users can update own client data"
  on <table> for update
  using (client_id = current_client_id());

-- DELETE (restricted to admin/owner roles only)
create policy "admins can delete own client data"
  on <table> for delete
  using (
    client_id = current_client_id()
    and current_user_role() in ('owner', 'admin')
  );
```

users INSERT additionally requires self-matching id (a user can only
create their own profile row inside their own client; the FIRST user of
a client is provisioned server-side via service role during onboarding):

```sql
create policy "users can insert own profile"
  on users for insert
  with check (id = auth.uid() and client_id = current_client_id());
```

### Special cases (A9, A12)

```sql
-- client_config: ALL operations restricted to owner/admin of the client.
-- Keeps wa_access_token / wa_webhook_secret away from agent-role users.
create policy "owners admins read client config"
  on client_config for select
  using (client_id = current_client_id() and current_user_role() in ('owner','admin'));
-- (insert / update / delete follow the same owner/admin restriction)

-- clients: members read their own client row; owner/admin modify.
create policy "members read own client"
  on clients for select
  using (id = current_client_id());
create policy "owners admins manage own client"
  on clients for all
  using (id = current_client_id() and current_user_role() in ('owner','admin'))
  with check (id = current_client_id() and current_user_role() in ('owner','admin'));

-- property_embeddings: agent role cannot delete (covered by the standard
-- delete policy requiring owner/admin).
```

---

## Indexes (beyond the pgvector HNSW index above)

```sql
-- Contacts: frequent lookups
create index on contacts (client_id, status);
create index on contacts (client_id, lead_score);
create index on contacts (client_id, pipeline_stage);
create index on contacts (client_id, phone_e164);
create index on contacts (client_id, human_controlled)
  where human_controlled = true;
create index on contacts (client_id, opted_out)
  where opted_out = true;
create index on contacts (client_id, follow_up_at)
  where follow_up_at is not null;

-- Messages: conversation history load
create index on messages (conversation_id, created_at desc);
create index on messages (client_id, contact_id, created_at desc);

-- Conversations: inbox view
create index on conversations (client_id, status, last_message_at desc);
create index on conversations (client_id, assigned_to);

-- Campaign contacts: send queue
create index on campaign_contacts (campaign_id, status)
  where status = 'pending';

-- Message templates: send-path approval lookup
create index on message_templates (client_id, status);

-- Property embeddings: scoped similarity search
create index on property_embeddings (client_id, chunk_type);
create index on property_embeddings (client_id, availability);

-- Lead score history: analytics
create index on lead_score_history (client_id, contact_id, changed_at desc);
```

---

## Data retention (A11)

- `contacts.raw_import` holds raw spreadsheet PII. It is purged
  (`set null`) once the contact reaches a terminal cleaning state
  (`clean` or `invalid`) AND 30 days have passed since the owning
  import's completion. The purge job is defined in cleaning-spec
  (Spec 2); this schema only guarantees the nullable column.
- Right-to-erasure: deleting a `contacts` row cascades to messages,
  conversations, lead_score_history and campaign_contacts. That single
  delete is the documented erasure path.

---

## Seed data for development / Model B setup

```sql
-- Insert a default client
insert into clients (id, name, slug)
values ('00000000-0000-0000-0000-000000000001', 'Rewa Dev Client', 'dev');

-- Insert default client config (region_priority left EMPTY — set per
-- client at onboarding; no country-first default, A10)
insert into client_config (client_id, client_brand_name, notification_email)
values (
  '00000000-0000-0000-0000-000000000001',
  'Rewa Properties',
  'dev@example.com'
);
```

---

## Verification checklist

Before marking this spec complete:

- [ ] All 12 tables exist in Supabase dashboard
- [ ] pgvector extension enabled
- [ ] HNSW index created on property_embeddings
- [ ] RLS enabled on ALL client-data tables including clients
- [ ] current_client_id() and current_user_role() exist, both SECURITY DEFINER with search_path = public
- [ ] Standard four RLS policies on each of: contacts, campaigns, message_templates, campaign_contacts, conversations, messages, lead_score_history, property_embeddings, contact_imports, users
- [ ] client_config policies restrict ALL operations to owner/admin; clients has member-read + owner/admin-manage policies
- [ ] contacts.wa_window_open does NOT exist; contacts.last_inbound_at DOES exist
- [ ] campaigns.template_id FK to message_templates exists; campaign_contacts.params exists
- [ ] contacts carries requirements, lead_source, follow_up_at, opted_out_source, opt_out_message_id, consent_source, consent_at
- [ ] property_embeddings.availability exists
- [ ] All performance indexes created (incl. message_templates (client_id,status) and follow_up partial index)
- [ ] Seed data inserted and queryable
- [ ] TypeScript types generated:
      `npx supabase gen types typescript --project-id YOUR_REF > src/types/supabase.ts`
