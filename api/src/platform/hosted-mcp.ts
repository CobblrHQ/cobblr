// Hosted MCP endpoint — the remote face for claude.ai and any HTTP MCP client.
//
// A small, self-contained MCP JSON-RPC handler mounted on the public webhook
// seam at **`POST /api/v1/hooks/mcp`**. Each tool proxies to this api's OWN
// REST surface with the caller's Bearer token, so all auth + permission
// enforcement is reused verbatim — this adds none of its own.
//
// WHY IT LIVES IN CORE (moved from the hosted overlay, 2026-08-15). Core
// already shipped every part of Ask-Cobb-over-a-bridge tool relay: the
// "How this AI runs tools" connection flag, the grant minting
// (`signMcpReadGrant`), the read-only clamp (`mcpReadPathAllowed`), the
// claude-code bridge itself — and pointed the bridge at
// `<origin>/api/v1/hooks/mcp`. That endpoint existed only in the proprietary
// overlay, so on a SELF-HOSTED instance the grant aimed at a 404 and the
// assistant silently had no tools. Core advertising a feature it cannot serve
// is the bug; the handler has no hosted-only logic (no billing, no
// entitlement, no multi-tenant specifics), so it belongs here.
//
// Auth: per-request `Authorization: Bearer <cbt_…>` (a Cobblr API token) or the
// short-lived read grant the bridge relay carries. The process holds no
// credentials and never elevates.

import { platform } from "@cobblr/platform-contract";
import { WORKSPACE_TOOLS, jsonSchemaOf, mcpToolName, toolFromMcpName, type WorkspaceApi } from "@cobblr/workspace-tools";

const SELF_BASE = `http://127.0.0.1:${process.env.API_PORT || "4000"}/api/v1`;
const SERVER_INFO = { name: "cobblr", version: "0.1.0" };

type Json = Record<string, unknown>;

// ── tool specs (MCP inputSchema = JSON Schema) ──────────────────────────────
const WORKSPACE_PROP = {
  workspace: { type: "string", description: "Workspace (org) slug. Optional if ?workspace= is set on the endpoint URL, or use cobblr_list_workspaces." },
};
/** The tool surface, GENERATED from the ONE registry the in-app chat and the
 *  stdio mcp-server also read (`@cobblr/workspace-tools`).
 *
 *  It used to be a hand-kept array of six. The registry grew to twenty-plus and
 *  this list did not, so everything added after it — the attention feed, the
 *  activity log, notifications, maintenance, the calendar, the scan inbox, the
 *  workspace-setup reader, the escort — was invisible to every hosted client
 *  AND to Ask Cobb over the bridge relay, which reads this endpoint. Nothing
 *  failed; the model simply had fewer tools than the product had, and said so
 *  in prose that read like a limitation (found 2026-08-15). A second copy of a
 *  registry is a second thing to forget, so there is no second copy now.
 *
 *  `cobblr_list_workspaces` stays hand-written: it is the ONLY tool that is not
 *  workspace-scoped (it answers "which workspaces?"), so it has no entry in a
 *  registry whose every tool takes a workspace. */
const LIST_WORKSPACES = {
  name: "cobblr_list_workspaces",
  description:
    "List the workspaces (orgs) this token can access, with slugs + your role. Call first if you don't know the slug.",
  inputSchema: { type: "object", properties: {} },
};

export const HOSTED_MCP_TOOLS = [
  LIST_WORKSPACES,
  ...WORKSPACE_TOOLS.map((t) => {
    const schema = jsonSchemaOf(t.params) as {
      type: string;
      properties?: Record<string, unknown>;
      required?: string[];
    };
    return {
      name: mcpToolName(t.name),
      description: t.description,
      inputSchema: {
        ...schema,
        // Every registry tool is workspace-scoped; the hosted endpoint takes
        // the slug per call (or from ?workspace=), unlike the stdio server.
        properties: { ...WORKSPACE_PROP, ...(schema.properties ?? {}) },
      },
    };
  }),
];

// ── REST proxy (caller's Bearer reused → all auth/permissions enforced) ──────
async function rest(token: string, method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${SELF_BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const err = (parsed as { error?: unknown })?.error ?? parsed ?? `HTTP ${res.status}`;
    throw new Error(typeof err === "string" ? err : JSON.stringify(err));
  }
  return parsed;
}

function slugOf(args: Json, defaultSlug: string | null): string {
  const s = (typeof args.workspace === "string" ? args.workspace.trim() : "") || defaultSlug || "";
  if (!s) throw new Error("No workspace. Pass `workspace` (the org slug), set ?workspace= on the endpoint, or call cobblr_list_workspaces.");
  return s;
}

/** The caller's Bearer, bound to one workspace — the seam every registry tool
 *  executes against. Auth and permissions stay entirely the api's: this proxies
 *  to its OWN REST surface with the user's token and adds nothing. */
function workspaceApiFor(token: string, slug: string): WorkspaceApi {
  return {
    async request(method, path, body) {
      const res = await fetch(`${SELF_BASE}/orgs/${slug}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let parsed: unknown = {};
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { raw: text };
        }
      }
      return { status: res.status, body: (parsed ?? {}) as Record<string, unknown> };
    },
  };
}

async function callTool(name: string, args: Json, token: string, defaultSlug: string | null): Promise<unknown> {
  // The one non-workspace tool.
  if (name === "cobblr_list_workspaces") return rest(token, "GET", "/orgs");

  const tool = toolFromMcpName(name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  const result = await tool.execute(workspaceApiFor(token, slugOf(args, defaultSlug)), args);
  // A tool that declines (a refusal with a reason, not a transport failure)
  // must reach the model as an error, or it reports success for something that
  // did not happen — the same mistake the in-app chat made until #1938.
  if (!result.ok) throw new Error(result.error ?? "the tool could not run");
  return result.data;
}

// ── minimal MCP JSON-RPC dispatch ───────────────────────────────────────────
function rpcResult(id: unknown, result: unknown): Json {
  return { jsonrpc: "2.0", id, result };
}
function rpcErr(id: unknown, code: number, message: string): Json {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function dispatch(msg: Json, token: string, defaultSlug: string | null): Promise<Json | null> {
  const { method, id, params } = msg as { method?: string; id?: unknown; params?: Json };
  // Notifications (no id) get no response body.
  if (id === undefined || id === null) {
    return null;
  }
  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: (params?.protocolVersion as string) || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: HOSTED_MCP_TOOLS });
    case "tools/call": {
      const name = params?.name as string;
      const args = (params?.arguments as Json) ?? {};
      try {
        const data = await callTool(name, args, token, defaultSlug);
        return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
      } catch (e) {
        return rpcResult(id, { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true });
      }
    }
    default:
      return rpcErr(id, -32601, `Method not found: ${method}`);
  }
}

function bearer(headers: Record<string, string | string[] | undefined>): string | null {
  const h = headers["authorization"] ?? headers["Authorization"];
  const v = Array.isArray(h) ? h[0] : h;
  if (typeof v === "string" && v.startsWith("Bearer ")) return v.slice(7).trim() || null;
  return null;
}

export function registerHostedMcp(): void {
  platform().http.registerWebhook({
    id: "mcp",
    handle: async (req) => {
      if (req.method !== "POST") {
        return { status: 405, body: { jsonrpc: "2.0", error: { code: -32000, message: "Use POST /api/v1/hooks/mcp." }, id: null } };
      }
      const token = bearer(req.headers);
      if (!token) {
        return {
          status: 401,
          headers: { "www-authenticate": "Bearer" },
          body: { jsonrpc: "2.0", error: { code: -32001, message: "Missing bearer token. Send Authorization: Bearer <cbt_…> (mint one in Cobblr → Configuration → API tokens)." }, id: null },
        };
      }
      const defaultSlug = typeof req.query.workspace === "string" ? req.query.workspace : null;
      const payload = req.body as Json | Json[];

      try {
        // Support a single message or a JSON-RPC batch.
        if (Array.isArray(payload)) {
          const out = (await Promise.all(payload.map((m) => dispatch(m, token, defaultSlug)))).filter((r): r is Json => r !== null);
          return { status: out.length ? 200 : 202, body: out.length ? out : undefined };
        }
        const res = await dispatch(payload ?? {}, token, defaultSlug);
        return res === null ? { status: 202 } : { status: 200, body: res };
      } catch (e) {
        return { status: 500, body: { jsonrpc: "2.0", error: { code: -32603, message: e instanceof Error ? e.message : String(e) }, id: null } };
      }
    },
  });
  console.log("[mcp] hosted MCP endpoint registered — POST /api/v1/hooks/mcp (Bearer-authed; tools generated from the shared registry).");
}
