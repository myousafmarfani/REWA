# Contributing to rewa

rewa is developed spec-first. It is not a public template and it is not
an open-ended feature playground. Changes should follow the approved
architecture and the relevant build spec.

## Before changing behaviour

1. Read [`MEMORY.md`](./MEMORY.md) — the numbered architecture decision
   ledger. It is authoritative over every other document.
2. Read [`AGENTS.md`](./AGENTS.md) — scope, stack, agent rules, and
   subagent review gates.
3. Read the relevant spec in [`specs/`](./specs). The build order is:
   data model → cleaning → agent core → sending → scoring → pipeline UI.
4. Load the matching skill in `.opencode/skills/` when the change touches
   cleaning rules, messaging compliance, real-estate domain behaviour, or
   the agent layer.

If a change conflicts with a numbered `MEMORY.md` entry, stop and raise
it. Do not silently resolve the conflict in code.

## Development setup

```bash
git clone https://github.com/myousafmarfani/REWA.git
cd REWA
npm install
cp .env.local.example .env.local
npm run dev
```

Setup details, including Supabase, WhatsApp, and Trigger.dev, are in
[`docs/README.md`](./docs/README.md).

## Checks before opening a pull request

Run all of these locally:

```bash
npm run typecheck
npm run lint
npm run test
npm run build
```

Database changes must also replay cleanly and pass the schema assertion.
The CI workflow does this automatically, but you can run the same checks
with the Supabase CLI:

```bash
supabase db reset --local --no-seed
supabase db query --local --file supabase/ci/verify-schema.sql
```

### Migration rules

- The rewa migration chain is authoritative. The inherited wacrm baseline
  in `supabase/migrations/_wacrm_retired/` is retired and must not be
  replayed.
- Do not recreate retired wacrm tables on a rewa environment. See
  `MEMORY.md` entry 19.
- New migrations must be idempotent and must be added to the CI schema
  assertion when they create a required object.

## Scope rules

- **WhatsApp only.** Do not add Telegram or Email sending logic, stubs,
  schema columns, or provider clients.
- **No public multi-tenant SaaS.** Model C is deferred. Do not add public
  signup, cross-tenant billing, or sharing assumptions beyond the
  supported managed/white-label models.
- **The agent is autonomous.** Do not add a draft-and-approve step to the
  normal inbound flow.
- **Every property fact is grounded.** Do not let the agent invent
  prices, availability, or payment plans.

## Pull requests

- Branch from the latest `main`; do not push to a merged branch.
- Keep one logical change per pull request.
- Explain the **why** in the commit body and the **what/how to verify**
  in the pull request.
- Include the migration impact and any behaviour change for existing
  deployments.
- Use the pull request template.

## Reporting bugs and security issues

- File non-security bugs with the
  [bug report](https://github.com/myousafmarfani/REWA/issues/new?template=bug_report.yml)
  template. Include the commit SHA, runtime, and relevant logs.
- **Do not file security issues publicly.** Follow the private flow in
  [`.github/SECURITY.md`](./.github/SECURITY.md).

## License and attribution

rewa is MIT-licensed. The original MIT [`LICENSE`](./LICENSE) and its
copyright notice are preserved unchanged.

rewa was forked from [wacrm](https://github.com/ArnasDon/wacrm), an
MIT-licensed CRM template by Arnas Donauskas. Contributions to rewa are
accepted under the repository's MIT license. Upstream attribution must
not be removed from the license or historical records.
