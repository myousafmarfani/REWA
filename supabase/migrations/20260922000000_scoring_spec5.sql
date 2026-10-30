-- ============================================================
-- Spec 5: Lead Scoring, CSV Export, and Hot Lead Escalation
--
-- 1. contacts.last_reply_at — the export contract (spec 5 export.ts)
--    requires a last-reply timestamp. It tracks the contact's most
--    recent inbound (reply) message and is maintained by the webhook —
--    the same writer as last_inbound_at — so it is always the raw
--    event time, never agent processing time.
--
-- 2. push_subscriptions — holdings for browser/PWA Web Push
--    subscriptions so hot-lead escalation can send a notification to
--    the assigned human agent ONLY when they have an active
--    subscription. The subscription UI is pipeline-ui-spec territory
--    (spec 6); this table + the guarded sender in escalation.ts make
--    the backend ready now.
--
-- 3. contacts-exports storage bucket — private bucket for the daily
--    scheduled export (spec 5 trigger/export-contacts.ts). Access is
--    via 24h signed URLs (emailed to the client); no public rows.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- 1. contacts.last_reply_at
-- ============================================================
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_reply_at timestamptz;

-- Backfill from last_inbound_at: prior to this column a contact's most
-- recent reply was recorded there; copying it keeps the export correct
-- for contacts that already have conversation history.
UPDATE contacts
SET last_reply_at = last_inbound_at
WHERE last_inbound_at IS NOT NULL;

-- ============================================================
-- 2. push_subscriptions
-- ============================================================
create table if not exists push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references clients(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  endpoint   text not null,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now(),
  unique (user_id, endpoint)
);

alter table push_subscriptions enable row level security;

create index if not exists push_subscriptions_user_id_idx
  on push_subscriptions (user_id);

drop policy if exists "users can read own client data" on push_subscriptions;
create policy "users can read own client data"
  on push_subscriptions for select
  -- Own subscriptions only: an endpoint + key pair is a capability to
  -- push to that user's device, so a teammate has no business reading
  -- it. Escalation.ts sends via the service role and is unaffected.
  using (client_id = current_client_id() and user_id = auth.uid());

drop policy if exists "users can insert own client data" on push_subscriptions;
create policy "users can insert own client data"
  on push_subscriptions for insert
  with check (
    client_id = current_client_id()
    and user_id = auth.uid()
  );

drop policy if exists "users can update own client data" on push_subscriptions;
create policy "users can update own client data"
  on push_subscriptions for update
  using (client_id = current_client_id() and user_id = auth.uid());

-- Row owners may remove their OWN subscription (the spec 6
-- notification UI needs this); admins retain client-wide management.
drop policy if exists "admins can delete own client data" on push_subscriptions;
drop policy if exists "users can delete own client data" on push_subscriptions;
create policy "users can delete own client data"
  on push_subscriptions for delete
  using (
    client_id = current_client_id()
    and (
      user_id = auth.uid()
      or current_user_role() in ('owner', 'admin')
    )
  );

-- ============================================================
-- 3. contacts-exports storage bucket (private; signed-URL access)
-- ============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'contacts-exports',
  'contacts-exports',
  FALSE,
  52428800, -- 50 MB — a 500K-row export is far under this; headroom only
  ARRAY[
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv'
  ]
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;