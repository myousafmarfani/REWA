---
name: client-delivery-models
description: Defines the two supported delivery models (A: managed service, B: white-label self-hosted) and their different tenancy, infrastructure, and configuration assumptions. Load before any feature touching multi-client data isolation, deployment config, or client-facing settings.
---

# Client Delivery Models

## Model A — Managed service

### What it means
We host the entire platform on our own infrastructure. Multiple client
organisations share one Supabase project, one deployment, one domain.
Each client gets a login, a dashboard, and isolated data — but the
infrastructure itself is shared and managed by us.

### Tenancy requirements
Every table that contains client data MUST have:
- client_id UUID column (foreign key to a clients table)
- A Row Level Security policy that restricts reads and writes to rows
  matching the authenticated user's client_id

This is not optional and not a later concern. Build it from the first
migration. If a table is missing RLS, Model A is not safely operable.

### What the client provides
- Their raw contact export (Excel, CSV, CRM export)
- Their WhatsApp Business number and API credentials (or we manage this
  on their behalf)
- Account settings: agent persona name, tone config, region priority,
  notification email, property data for pgvector

### What we provide
- Hosted platform access (dashboard login)
- Campaign pipeline management
- Autonomous agent running on their contacts 24/7
- Hot lead alerts to their team via push + email
- Ongoing support and tuning

### Configuration model
Per-client configuration is stored in a client_config table in Supabase,
not in environment variables or config files. Examples:
- agent_persona_name: "Sara"
- region_priority: ["UAE", "GCC", "Western", "SouthAsia", "Other"]
- notification_email: ops@clientdomain.com
- wa_phone_number_id: from their WhatsApp Business setup
- wa_access_token: stored encrypted

### AI agent scaling role
The autonomous agent is what makes Model A viable at scale. Without it,
every client's inbound conversations require a human (us) to read and
respond. The agent handles all inbound conversations autonomously — we
only intervene at the hot lead escalation stage, and even that alert
goes to the client's own team, not to us.

---

## Model B — White-label self-hosted

### What it means
The client owns their own infrastructure. We deliver a configured,
running instance of rewa into their own environment:
- Their own Supabase project (their org, their billing)
- Their own AWS account (for future email — not current scope)
- Their own WhatsApp Business number, verified and connected
- Their own domain / branding

We do the implementation as a project engagement, then provide ongoing
support on a retainer.

### Tenancy requirements
Single-tenant per deployment. There is only one client in this
Supabase project. RLS is still implemented (good practice, defence in
depth) but the multi-client isolation concern does not apply here.

Do not add client_id to every table in a Model B deployment — or if you
do (for code reuse), ensure the RLS policies reflect that there is only
one client and do not add unnecessary join complexity.

### What the client owns
- Full infrastructure (Supabase project, domain, WA Business number)
- Their own data — nothing leaves their infra
- The codebase, deployed under their own hosting

### What we provide during implementation
- Full setup: Supabase schema, pgvector property data ingestion,
  WhatsApp Business API connection, agent persona configuration
- Agent persona tuning: name, tone, conversation style calibrated for
  their market and property type
- Campaign setup: first contact import cleaned and campaign created
- Team training: how to read lead scores, manage the toggle, handle
  hot lead alerts

### Configuration model
Configuration lives in environment variables and/or a seed data file
that runs once on deployment. No dynamic config UI required for a
single-client deployment — the agent persona and settings are set at
deployment time and changed via config update + redeploy.

### The retainer
Post-implementation support covers:
- Agent prompt and persona tuning as the client learns what works
- pgvector property data updates when new listings are added
- WhatsApp template submission and approval management
- Lead scoring threshold adjustments

---

## What NOT to build (Model C — explicitly deferred)

- Public self-serve signup flow
- Cross-tenant billing / subscription management
- Any UI for a client to create their own sub-clients
- Shared analytics across clients
- Public-facing landing page or marketing site

Do not build or scaffold any of the above. If a client asks for a
feature that implies Model C, flag it and raise it as a product decision
— do not implement it unilaterally.

---

## Decision guide for spec writers

When writing a spec, be explicit about which model(s) it applies to.
Use this as a quick reference:

| Concern                         | Model A           | Model B           |
|---------------------------------|-------------------|-------------------|
| client_id on tables             | Required          | Optional          |
| RLS policies                    | Required          | Best practice     |
| Config storage                  | client_config table | Env vars / seed |
| WhatsApp credentials            | Per-client in DB  | Single env var    |
| Agent persona                   | Per-client in DB  | Single config     |
| Number of tenants               | Many              | One               |
| Who manages infra               | Us                | Client            |
