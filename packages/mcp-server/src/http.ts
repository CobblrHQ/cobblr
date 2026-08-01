#!/usr/bin/env node
// Cobblr MCP server — REMOTE entrypoint (Streamable HTTP transport).
//
// The stdio server (index.ts) is for a LOCAL Claude (Desktop / Code) that can
// spawn a process. claude.ai web/mobile can't — it reaches a workspace only
// through a hosted HTTP MCP endpoint. This is that endpoint.
//
// Design:
//   • One long-running process serves MANY users. The Cobblr API token is NOT
//     in this process's env — it arrives per-request as `Authorization: Bearer
//     <cbt_…>` and is bound to a fresh CobblrClient for that request only.
//   • STATELESS: every POST gets its own McpServer + transport, handled and torn
//     down. Our tools are all stateless REST calls, so no session store, no
//     cross-request state, no leak. (sessionIdGenerator: undefined.)
//   • Same tools as stdio — `registerTools()` — so author/operate/drive all work
//     remotely, unchanged.
//
// Auth boundary (business-models/docs/09): this only ever forwards the caller's
// own token to the REST API; it never holds credentials and never elevates.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadHttpConfig } from "./config.js";
import { CobblrClient } from "./client.js";
import { registerTools } from "./tools.js";

const JSON_HEADERS = { "content-type": "application/json" };

function cors(res: ServerResponse): void {
  // Bearer-authed endpoint (no ambient cookie), so a permissive origin is safe.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers["authorization"];
  if (typeof h === "string" && h.startsWith("Bearer ")) return h.slice(7).trim() || null;
  return null;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      if (!data) return resolve(undefined);
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

// JSON-RPC-shaped error so MCP clients surface it cleanly.
function rpcError(res: ServerResponse, status: number, code: number, message: string): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

async function main(): Promise<void> {
  const config = loadHttpConfig(process.env);

  const httpServer = createServer(async (req, res) => {
    cors(res);
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === "/healthz") {
      sendJson(res, 200, { ok: true, api: config.baseUrl });
      return;
    }

    if (url.pathname !== "/mcp") {
      rpcError(res, 404, -32601, "Not found. The MCP endpoint is POST /mcp.");
      return;
    }

    // Stateless mode: server-initiated streams (GET) and session teardown
    // (DELETE) aren't used — every POST is self-contained.
    if (req.method === "GET" || req.method === "DELETE") {
      rpcError(res, 405, -32000, "This server is stateless — use POST /mcp.");
      return;
    }
    if (req.method !== "POST") {
      rpcError(res, 405, -32000, "Method not allowed.");
      return;
    }

    const token = bearer(req);
    if (!token) {
      rpcError(
        res,
        401,
        -32001,
        "Missing bearer token. Send `Authorization: Bearer <cbt_…>` (mint one in Cobblr → Configuration → API tokens).",
      );
      return;
    }

    let body: unknown;
    try {
      body = await readBody(req);
    } catch {
      rpcError(res, 400, -32700, "Parse error: request body is not valid JSON.");
      return;
    }

    // Per-request: bind the caller's token to a fresh client + MCP server.
    // Optional ?workspace=<slug> sets the default so per-tool `workspace` args
    // become optional for this caller.
    const client = new CobblrClient({
      baseUrl: config.baseUrl,
      token,
      defaultOrgSlug: url.searchParams.get("workspace") || null,
    });
    const server = new McpServer({ name: "cobblr", version: "0.1.0" });
    registerTools(server, client);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true, // single JSON response per POST, not an SSE stream
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) {
        rpcError(res, 500, -32603, `Internal error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  });

  httpServer.listen(config.port, () => {
    process.stderr.write(
      `[cobblr-mcp-http] listening on :${config.port} · POST /mcp · api=${config.baseUrl}\n`,
    );
  });
}

main().catch((e) => {
  process.stderr.write(`[cobblr-mcp-http] fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
