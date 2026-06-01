#!/usr/bin/env node
// Cobblr MCP server — entrypoint.
//
// Exposes a Cobblr install (cloud or self-hosted) to a local Claude Code /
// Claude Desktop / claude.ai connector over stdio. The model on the user's side
// drives the build; this process is a thin, authenticated face over the
// existing /api/v1 REST endpoints (see ../README.md and docs/09 in the
// business-models repo for the auth-boundary rationale).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { CobblrClient } from "./client.js";
import { registerTools } from "./tools.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const client = new CobblrClient(config);

  const server = new McpServer({
    name: "cobblr",
    version: "0.1.0",
  });

  registerTools(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stdout is the MCP channel — log only to stderr.
  process.stderr.write(
    `[cobblr-mcp] ready · api=${config.baseUrl}${config.defaultOrgSlug ? ` · workspace=${config.defaultOrgSlug}` : ""}\n`,
  );
}

main().catch((e) => {
  process.stderr.write(`[cobblr-mcp] fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
