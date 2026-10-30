#!/usr/bin/env node
// ============================================================
// Legacy wacrm MCP server — entry point (inherited by rewa).
//
// A stdio Model Context Protocol server that exposes the inherited
// wacrm public API (`/api/v1`) as MCP tools. Retained for reference;
// it is not aligned with the current rewa schema.
//
// Transport is stdio: logs MUST go to stderr, never stdout (stdout
// is the protocol channel). Configuration comes from the environment
// — see .env.example / README.md.
// ============================================================

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { WacrmClient } from './client.js';
import { registerTools } from './tools/index.js';

// package.json version, kept in sync manually with the manifest.
const VERSION = '0.1.1';

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new WacrmClient(config);

  const server = new McpServer({ name: 'rewa-mcp-legacy', version: VERSION });
  const groups = registerTools(server, client, config);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Stderr only — stdout is reserved for the MCP protocol.
  console.error(
    `legacy wacrm MCP server v${VERSION} ready — instance ${config.baseUrl}, ` +
      `tool groups: ${groups.join(', ')}` +
      (config.enableWrites ? '' : ' (read-only; set WACRM_ENABLE_WRITES to allow changes)'),
  );
}

main().catch((err) => {
  console.error(`Failed to start legacy wacrm MCP server: ${(err as Error).message}`);
  process.exit(1);
});
