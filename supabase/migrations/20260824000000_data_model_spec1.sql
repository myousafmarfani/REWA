-- Spec 1: Data Model — rewa (amended 2026-08-24)

create extension if not exists vector;

-- Tables

create table clients (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  slug            text not null unique,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table users (
  id          uuid primary key references auth.users(id) on delete cascade,
  client_id   uuid not null references clients(id) on delete cascade,
  full_name   text not null,
  email       text not null,
  role        text not null default 'agent',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table client_config (
  id                    uuid primary key default gen_random_uuid(),
  client_id             uuid not null references clients(id) on delete cascade,
  agent_persona_name    text not null default 'Sara',
  agent_tone            text not null default 'professional_warm',
  agent_language        text not null default 'en',
  agent_sign_off        text not null default 'Best,',
  client_brand_name     text not null,
  escalation_phrase     text not null default 'Let me connect you with our senior advisor.',
  wa_phone_number_id    text,
  wa_access_token       text,
  wa_webhook_secret     text,
  notification_email    text,
  region_priority       text[] not null default '{}'::text[],
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique(client_id)
);

create table message_templates (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid not null references clients(id) on delete cascade,
  name             text not null,
  meta_template_id text,
  language         text not null default 'en',
  category         text not null default 'marketing',
  status           text not null default 'pending',
  body_text        text not null,
  variable_count   integer not null default 0,
  rejected_reason  text,
  approved_at      timestamptz,
  last_verified_at timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique(client_id, name, language)
);

create table contacts (
  id                 uuid primary key default gen_random_uuid(),
  client_id          uuid not null references clients(id) on delete cascade,
  full_name          text,
  phone_e164         text not null,
  email              text,
  email_type         text,
  status             text not null default 'pending',
  invalid_reason     text,
  number_type        text,
  region             text,
  carrier            text,
  is_premium         boolean not null default false,
  priority_rank      integer,
  lead_score         text not null default 'cold',
  pipeline_stage     text not null default 'new_lead',
  requirements       jsonb,
  follow_up_at       timestamptz,
  lead_source        text,
  hot_flagged_at     timestamptz,
  opted_out          boolean not null default false,
  opted_out_at       timestamptz,
  opted_out_source   text check (opted_out_source in ('contact_reply','manual','import')),
  opt_out_message_id uuid,
  consent_source     text check (consent_source in ('imported_list','prior_whatsapp_chat','manual')),
  consent_at         timestamptz,
  human_controlled   boolean not null default false,
  assigned_to        uuid references users(id),
  last_contacted_at  timestamptz,
  last_inbound_at    timestamptz,
  raw_import         jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique(client_id, phone_e164)
);

create table campaigns (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references clients(id) on delete cascade,
  name            text not null,
  status          text not null default 'draft',
  template_id     uuid not null references message_templates(id),
  template_name   text,
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

create table campaign_contacts (
  id            uuid primary key default gen_random_uuid(),
  campaign_id   uuid not null references campaigns(id) on delete cascade,
  contact_id    uuid not null references contacts(id) on delete cascade,
  client_id     uuid not null references clients(id) on delete cascade,
  params        jsonb,
  status        text not null default 'pending',
  sent_at       timestamptz,
  failed_at     timestamptz,
  fail_reason   text,
  wa_message_id text,
  created_at    timestamptz not null default now(),
  unique(campaign_id, contact_id)
);

create table conversations (
  id                   uuid primary key default gen_random_uuid(),
  client_id            uuid not null references clients(id) on delete cascade,
  contact_id           uuid not null references contacts(id) on delete cascade,
  assigned_to          uuid references users(id),
  status               text not null default 'open',
  last_message_at      timestamptz,
  last_message_preview text,
  unread_count         integer not null default 0,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique(client_id, contact_id)
);

create table messages (
  id                     uuid primary key default gen_random_uuid(),
  client_id              uuid not null references clients(id) on delete cascade,
  conversation_id        uuid not null references conversations(id) on delete cascade,
  contact_id             uuid not null references contacts(id) on delete cascade,
  direction              text not null,
  sender_type            text not null,
  body                   text not null,
  wa_message_id          text,
  wa_timestamp           timestamptz,
  status                 text not null default 'sent',
  agent_lead_score       text,
  agent_intent_type      text,
  agent_signals          jsonb,
  agent_suggested_stage  text,
  agent_needs_follow_up  boolean default false,
  agent_follow_up_reason text,
  created_at             timestamptz not null default now()
);

create table lead_score_history (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null references clients(id) on delete cascade,
  contact_id     uuid not null references contacts(id) on delete cascade,
  previous_score text,
  new_score      text not null,
  reason         text,
  changed_at     timestamptz not null default now(),
  message_id     uuid references messages(id)
);

create table property_embeddings (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references clients(id) on delete cascade,
  property_id  text not null,
  chunk_type   text not null,
  availability text not null default 'unknown',
  content      text not null,
  embedding    vector(1536),
  metadata     jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table contact_imports (
  id                  uuid primary key default gen_random_uuid(),
  client_id           uuid not null references clients(id) on delete cascade,
  filename            text not null,
  row_count_raw       integer not null default 0,
  row_count_clean     integer not null default 0,
  row_count_invalid   integer not null default 0,
  row_count_review    integer not null default 0,
  row_count_duplicate integer not null default 0,
  status              text not null default 'processing',
  error_message       text,
  imported_by         uuid references users(id),
  created_at          timestamptz not null default now(),
  completed_at        timestamptz
);

alter table contacts
  add constraint contacts_opt_out_message_id_fkey
  foreign key (opt_out_message_id) references messages(id);

-- Indexes

create index on contacts (client_id, status);
create index on contacts (client_id, lead_score);
create index on contacts (client_id, pipeline_stage);
create index on contacts (client_id, phone_e164);
create index on contacts (client_id, human_controlled) where human_controlled = true;
create index on contacts (client_id, opted_out) where opted_out = true;
create index on contacts (client_id, follow_up_at) where follow_up_at is not null;
create index on messages (conversation_id, created_at desc);
create index on messages (client_id, contact_id, created_at desc);
create index on conversations (client_id, status, last_message_at desc);
create index on conversations (client_id, assigned_to);
create index on campaign_contacts (campaign_id, status) where status = 'pending';
create index on message_templates (client_id, status);
create index on property_embeddings (client_id, chunk_type);
create index on property_embeddings (client_id, availability);
create index on lead_score_history (client_id, contact_id, changed_at desc);
create index on property_embeddings using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- RLS

alter table clients enable row level security;
alter table client_config enable row level security;
alter table users enable row level security;
alter table contacts enable row level security;
alter table campaigns enable row level security;
alter table message_templates enable row level security;
alter table campaign_contacts enable row level security;
alter table conversations enable row level security;
alter table messages enable row level security;
alter table lead_score_history enable row level security;
alter table property_embeddings enable row level security;
alter table contact_imports enable row level security;

create or replace function current_client_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select client_id from users where id = auth.uid()
$$;

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

create policy "users can read own client data"
  on contacts for select
  using (client_id = current_client_id());
create policy "users can insert own client data"
  on contacts for insert
  with check (client_id = current_client_id());
create policy "users can update own client data"
  on contacts for update
  using (client_id = current_client_id());
create policy "admins can delete own client data"
  on contacts for delete
  using (
    client_id = current_client_id()
    and current_user_role() in ('owner', 'admin')
  );

create policy "users can read own client data"
  on campaigns for select
  using (client_id = current_client_id());
create policy "users can insert own client data"
  on campaigns for insert
  with check (client_id = current_client_id());
create policy "users can update own client data"
  on campaigns for update
  using (client_id = current_client_id());
create policy "admins can delete own client data"
  on campaigns for delete
  using (
    client_id = current_client_id()
    and current_user_role() in ('owner', 'admin')
  );

create policy "users can read own client data"
  on message_templates for select
  using (client_id = current_client_id());
create policy "users can insert own client data"
  on message_templates for insert
  with check (client_id = current_client_id());
create policy "users can update own client data"
  on message_templates for update
  using (client_id = current_client_id());
create policy "admins can delete own client data"
  on message_templates for delete
  using (
    client_id = current_client_id()
    and current_user_role() in ('owner', 'admin')
  );

create policy "users can read own client data"
  on campaign_contacts for select
  using (client_id = current_client_id());
create policy "users can insert own client data"
  on campaign_contacts for insert
  with check (client_id = current_client_id());
create policy "users can update own client data"
  on campaign_contacts for update
  using (client_id = current_client_id());
create policy "admins can delete own client data"
  on campaign_contacts for delete
  using (
    client_id = current_client_id()
    and current_user_role() in ('owner', 'admin')
  );

create policy "users can read own client data"
  on conversations for select
  using (client_id = current_client_id());
create policy "users can insert own client data"
  on conversations for insert
  with check (client_id = current_client_id());
create policy "users can update own client data"
  on conversations for update
  using (client_id = current_client_id());
create policy "admins can delete own client data"
  on conversations for delete
  using (
    client_id = current_client_id()
    and current_user_role() in ('owner', 'admin')
  );

create policy "users can read own client data"
  on messages for select
  using (client_id = current_client_id());
create policy "users can insert own client data"
  on messages for insert
  with check (client_id = current_client_id());
create policy "users can update own client data"
  on messages for update
  using (client_id = current_client_id());
create policy "admins can delete own client data"
  on messages for delete
  using (
    client_id = current_client_id()
    and current_user_role() in ('owner', 'admin')
  );

create policy "users can read own client data"
  on lead_score_history for select
  using (client_id = current_client_id());
create policy "users can insert own client data"
  on lead_score_history for insert
  with check (client_id = current_client_id());
create policy "users can update own client data"
  on lead_score_history for update
  using (client_id = current_client_id());
create policy "admins can delete own client data"
  on lead_score_history for delete
  using (
    client_id = current_client_id()
    and current_user_role() in ('owner', 'admin')
  );

create policy "users can read own client data"
  on property_embeddings for select
  using (client_id = current_client_id());
create policy "users can insert own client data"
  on property_embeddings for insert
  with check (client_id = current_client_id());
create policy "users can update own client data"
  on property_embeddings for update
  using (client_id = current_client_id());
create policy "admins can delete own client data"
  on property_embeddings for delete
  using (
    client_id = current_client_id()
    and current_user_role() in ('owner', 'admin')
  );

create policy "users can read own client data"
  on contact_imports for select
  using (client_id = current_client_id());
create policy "users can insert own client data"
  on contact_imports for insert
  with check (client_id = current_client_id());
create policy "users can update own client data"
  on contact_imports for update
  using (client_id = current_client_id());
create policy "admins can delete own client data"
  on contact_imports for delete
  using (
    client_id = current_client_id()
    and current_user_role() in ('owner', 'admin')
  );

create policy "users can read own client data"
  on users for select
  using (client_id = current_client_id());
create policy "users can insert own profile"
  on users for insert
  with check (id = auth.uid() and client_id = current_client_id());
create policy "users can update own client data"
  on users for update
  using (client_id = current_client_id());
create policy "admins can delete own client data"
  on users for delete
  using (
    client_id = current_client_id()
    and current_user_role() in ('owner', 'admin')
  );

create policy "owners admins read client config"
  on client_config for select
  using (client_id = current_client_id() and current_user_role() in ('owner','admin'));
create policy "owners admins insert client config"
  on client_config for insert
  with check (client_id = current_client_id() and current_user_role() in ('owner','admin'));
create policy "owners admins update client config"
  on client_config for update
  using (client_id = current_client_id() and current_user_role() in ('owner','admin'));
create policy "owners admins delete client config"
  on client_config for delete
  using (client_id = current_client_id() and current_user_role() in ('owner','admin'));

create policy "members read own client"
  on clients for select
  using (id = current_client_id());
create policy "owners admins manage own client"
  on clients for all
  using (id = current_client_id() and current_user_role() in ('owner','admin'))
  with check (id = current_client_id() and current_user_role() in ('owner','admin'));

-- Seed

insert into clients (id, name, slug)
values ('00000000-0000-0000-0000-000000000001', 'Rewa Dev Client', 'dev');

insert into client_config (client_id, client_brand_name, notification_email)
values (
  '00000000-0000-0000-0000-000000000001',
  'Rewa Properties',
  'dev@example.com'
);
