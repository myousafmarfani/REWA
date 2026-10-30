# MCP server — inherited legacy

> **This is inherited wacrm material, not a supported rewa feature.**
>
> The server in [`mcp-server/`](../mcp-server) targets the wacrm-era
> public API and account model. rewa uses a `client_id`-scoped schema and
> has retired several of the tables the server assumes. It is retained
> for reference and possible future adaptation only. Do not deploy it
> against a current rewa deployment or treat its tools as part of rewa's
> supported surface.

The original upstream documentation described a
[Model Context Protocol](https://modelcontextprotocol.io) server that
let AI assistants drive the CRM's public API in natural language. That
server still exists in the tree, but its compatibility with rewa has not
been validated.

If the server is formally adapted to rewa, this document should be
replaced with current setup, tool, and safety documentation. Until then,
see the legacy notice and inherited reference material in
[`mcp-server/README.md`](../mcp-server/README.md).
