# rewa MCP server — inherited legacy

> **Legacy code, not part of rewa's supported product surface.**
>
> This MCP server was inherited with the wacrm fork. It targets the
> wacrm-era public API and account model, while rewa uses a
> `client_id`-scoped schema and has retired several of the tables this
> server assumes (`api_keys`, `whatsapp_config`, `accounts`,
> `webhook_endpoints`). It is retained for reference and possible future
> adaptation. Do not deploy it as part of a rewa installation or treat
> its tool list as current rewa behaviour.
>
> The package is marked private and must not be published under the
> original `wacrm-mcp` identity. Environment variable names remain
> `WACRM_*` because they are read by the inherited code; they will be
> renamed only if the server is formally adapted to rewa.

The original upstream description follows for context.

---

A [Model Context Protocol](https://modelcontextprotocol.io) server for
[wacrm](https://github.com/ArnasDon/wacrm) — the self-hostable WhatsApp
CRM this repository was forked from. It lets MCP clients (Claude
Desktop, Claude Code, Cursor, and others) drive the inherited CRM
surface in natural language:

> "How many conversations are still open?"
> "Find the contact for +1 415 555 0123 and show the last few messages."
> "Draft and send an order-update template to Jane."

It is a thin wrapper over the inherited `/api/v1` REST endpoints. All
auth, scoping, and rate limiting are enforced by the instance — this
server just exposes the API as MCP tools.

## Prerequisites (inherited)

1. A running instance with the inherited wacrm API surface.
2. An API key from the dashboard: **Settings → API keys → New API key**,
   granted only the scopes needed. The key is shown once.

These prerequisites no longer match the rewa data model out of the box.
Adaptation work is required before this server can be used against a
current rewa deployment.

## Install and configure

The server reads two required environment variables and two optional
write guards:

| Variable                  | Required | Purpose                                                        |
| ------------------------- | -------- | -------------------------------------------------------------- |
| `WACRM_BASE_URL`          | yes      | Instance URL, e.g. `https://crm.example.com`                   |
| `WACRM_API_KEY`           | yes      | An API key from the dashboard                                  |
| `WACRM_ENABLE_WRITES`     | no       | `true` to expose contact writes and message sending            |
| `WACRM_ENABLE_BROADCASTS` | no       | `true` to expose mass broadcasts (needs `WACRM_ENABLE_WRITES`) |

### Claude Desktop / Claude Code / Cursor

Add to your MCP client config (e.g. `claude_desktop_config.json`, or
`.mcp.json` for Claude Code). The legacy package name is used here only
for local reference builds:

```jsonc
{
  "mcpServers": {
    "rewa-mcp-legacy": {
      "command": "npx",
      "args": ["-y", "rewa-mcp-legacy"],
      "env": {
        "WACRM_BASE_URL": "https://crm.example.com",
        "WACRM_API_KEY": "wacrm_live_xxxxxxxxxxxxxxxxxxxxxxxx",
      },
    },
  },
}
```

That configuration is read-only — the safe default. To let the assistant
change data or send messages, add the write guards:

```jsonc
"env": {
  "WACRM_BASE_URL": "https://crm.example.com",
  "WACRM_API_KEY": "wacrm_live_xxxxxxxxxxxxxxxxxxxxxxxx",
  "WACRM_ENABLE_WRITES": "true",
  "WACRM_ENABLE_BROADCASTS": "true"
}
```

## Tools (inherited)

Read tools are always available. Write and broadcast tools appear only
when their guard is set.

| Tool                 | Group     | Scope needed         | What it does                                     |
| -------------------- | --------- | -------------------- | ------------------------------------------------ |
| `whoami`             | read      | _(any valid key)_    | Show the account and scopes the key carries      |
| `list_contacts`      | read      | `contacts:read`      | List/search contacts (paginated)                 |
| `get_contact`        | read      | `contacts:read`      | Read one contact                                 |
| `list_conversations` | read      | `conversations:read` | List conversations, filter by status/contact     |
| `get_conversation`   | read      | `conversations:read` | Read one conversation                            |
| `list_messages`      | read      | `messages:read`      | List a conversation's messages                   |
| `get_broadcast`      | read      | `broadcasts:send`    | Poll a broadcast's delivery status               |
| `send_message`       | write     | `messages:send`      | Send a WhatsApp message (text/template/media)    |
| `create_contact`     | write     | `contacts:write`     | Create (find-or-create) a contact                |
| `update_contact`     | write     | `contacts:write`     | Update a contact / replace its tags              |
| `send_broadcast`     | broadcast | `broadcasts:send`    | Launch a template broadcast (requires `confirm`) |

## Safety model (inherited)

Sending WhatsApp messages through an LLM is a real-world side effect, so
the original server layered three guards:

1. **Read-only by default.** Write and broadcast tools are not even
   registered unless you opt in via `WACRM_ENABLE_WRITES` /
   `WACRM_ENABLE_BROADCASTS`.
2. **API-key scopes.** The instance still enforces the key's scopes.
3. **Explicit broadcast confirmation.** `send_broadcast` refuses to run
   unless called with `confirm: true`, and is marked `destructive` so
   compliant clients prompt the user first.

Do not treat this inherited safety model as a substitute for reviewing
the server against rewa's current compliance and RLS rules.

## Development

```bash
npm install
npm run build      # compile to dist/
npm run typecheck
npm start          # run the compiled server (needs the env vars)
```

Logs go to **stderr** — stdout is reserved for the MCP protocol.

## License

MIT — same as the upstream wacrm project. Original copyright and
attribution are preserved in the repository root [`LICENSE`](../LICENSE).
