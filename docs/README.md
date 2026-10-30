# rewa setup and operations

This is the setup path for the current rewa tree. rewa is under active
development; verify each step against your own deployment before putting
real traffic through it.

## Prerequisites

- Node.js 20 or newer (CI uses Node 22).
- A Supabase project (Postgres, Auth, Storage, and pgvector).
- A Meta WhatsApp Business app and a test or production number.
- A Trigger.dev project for background agent and campaign tasks.
- Optional: Resend for escalation email, and a VAPID key pair for web
  push notifications.

## 1. Install

```bash
git clone https://github.com/myousafmarfani/REWA.git
cd REWA
npm install
cp .env.local.example .env.local
```

Fill in the required values in `.env.local`:

| Variable                                                | Purpose                                                  |
| ------------------------------------------------------- | -------------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`                              | Supabase project URL                                     |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY`                         | Supabase anon key                                        |
| `SUPABASE_SERVICE_ROLE_KEY`                             | Server-side key for webhooks and background work         |
| `ENCRYPTION_KEY`                                        | 64 hex characters, used for AES-256-GCM token encryption |
| `META_APP_SECRET`                                       | Meta app secret used to verify inbound webhook HMACs     |
| `AI_PROVIDER` / `AI_MODEL`                              | Agent model selection                                    |
| `GOOGLE_GENERATIVE_AI_API_KEY` (or provider equivalent) | Agent provider key                                       |
| `TRIGGER_SECRET_KEY`                                    | Trigger.dev server key                                   |
| `TRIGGER_PROJECT_ID`                                    | Trigger.dev project ref (used by `trigger.config.ts`)    |
| `RESEND_API_KEY` / `RESEND_FROM_EMAIL`                  | Optional hot-lead email alerts                           |
| `WEB_PUSH_*`                                            | Optional web push alerts                                 |

`ENCRYPTION_KEY` encrypts stored WhatsApp secrets. Rotating it makes
previously encrypted values unreadable; the affected client must re-save
their WhatsApp configuration.

## 2. Database

The rewa migration chain is authoritative. Apply the migrations in
`supabase/migrations/` with your normal Supabase workflow (CLI
`supabase db push`, or the equivalent for your environment).

**Do not apply the retired wacrm baseline.** Migrations `001`–`039` live
in `supabase/migrations/_wacrm_retired/` for historical reference only.
They target the old wacrm schema and are incompatible with the rewa
`client_id` model. Do not recreate retired wacrm tables (`whatsapp_config`,
`accounts`, `broadcasts`, `flows`, `automations`, `tags`, `contact_tags`,
`custom_fields`, `api_keys`, `webhook_endpoints`) on a rewa deployment.

For a local check, the CI path is:

```bash
supabase db reset --local --no-seed
supabase db query --local --file supabase/ci/verify-schema.sql
```

The second command matters. A migration can apply cleanly and still do
nothing because the DDL is idempotency-guarded; the schema assertion
catches that. See `MEMORY.md` entry 19 for the migration-consolidation
background.

## 3. WhatsApp

1. Create or select a Meta WhatsApp Business app.
2. Point the webhook at `https://<your-domain>/api/webhooks/whatsapp`.
3. Use the per-client webhook secret from `client_config` as the Meta
   verify token. Inbound POSTs are HMAC-verified with the same secret.
4. Subscribe to the message and status fields you need.
5. Store the WhatsApp access token and webhook secret through the app's
   client configuration flow so they are encrypted with
   `ENCRYPTION_KEY`.

Business-initiated template messages must be approved by Meta before a
campaign can send them. The 24-hour service window is derived from the
contact's last inbound message; do not add a cached window column.

## 4. Agent and jobs

Trigger.dev runs the inbound agent and campaign fan-out. Start the local
worker with the Trigger.dev CLI after the project is configured:

```bash
npx trigger.dev@latest dev
```

The agent task is `src/trigger/process-message.ts`. It is enqueued by the
WhatsApp webhook and follows the gate → history → retrieval → guardrails →
generate → score → send order.

## 5. Run

```bash
npm run dev
```

Open <http://localhost:3000>. You will be redirected to `/login`, or to
`/dashboard` if already signed in.

## Docker

See [docker.md](./docker.md). Supabase and Trigger.dev remain external
services; the container runs the Next.js app only.

## Checks

```bash
npm run typecheck
npm run lint
npm run test
npm run build
```

## Legacy material

The inherited MCP server, public API documentation, and old wacrm
migration baseline are retained for reference but are not part of the
supported rewa surface:

- [MCP server (legacy)](./mcp.md)
- [Public API (inherited, legacy)](./public-api.md)
- [`supabase/migrations/_wacrm_retired/`](../supabase/migrations/_wacrm_retired)
