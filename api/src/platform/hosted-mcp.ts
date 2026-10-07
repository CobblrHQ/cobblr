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
import { READ_TOOLS_THAT_POST, WORKSPACE_TOOLS, jsonSchemaOf, mcpToolName, toolFromMcpName, workspaceLinks, type WorkspaceApi } from "@cobblr/workspace-tools";
import { publicBaseUrl } from "@cobblr/platform-contract/public-url";
import { instanceOfGrants, signMcpWriteGrant, verifySession } from "../auth/jwt.js";
import { resolveApiToken } from "../auth/api-tokens.js";
import { MCP_PATH, originOf, protectedResourceMetadataUrl } from "../auth/oauth.js";
import { mcpProxyHeaders } from "../auth/mcp-proxy.js";
import { actionRefusal } from "./ai-action-door.js";

// loopback-ok: #5153 moves this onto selfFetch
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
    headers: { authorization: `Bearer ${token}`, ...mcpProxyHeaders(), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
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

/** A held token names its workspace; a call aimed at another is refused in
 *  words the model can repeat, rather than a bare 403 from the route. */
function heldSlug(slug: string, args: Json): string {
  const asked = typeof args.workspace === "string" ? args.workspace.trim() : "";
  if (asked && asked !== slug) throw new Error(`This connection is for the ${slug} workspace only.`);
  return slug;
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
  // The caller is outside this box, so only the public address is a link it
  // can open; with none configured, tools say "file ids only".
  const origin = publicBaseUrl();
  return {
    link: workspaceLinks({ apiBase: origin ? `${origin}/api/v1` : null, appOrigin: origin || null }, slug),
    async request(method, path, body) {
      const res = await fetch(`${SELF_BASE}/orgs/${slug}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...mcpProxyHeaders(),
          // Says an MCP client is calling, so an API-token call is stamped as
          // the MCP door (a service job then follows MCP's consent), the way
          // the stdio server already says it. A relay grant is the assistant
          // whatever this says.
          "x-cobblr-client": "mcp",
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

// ── what the CALLER can actually do ─────────────────────────────────────────
// A surface must never advertise a capability its caller cannot use. The relay
// hands `claude -p` a READ grant, but this endpoint used to list all twenty-two
// tools to everyone — so Cobb reached for create_record, hit the read clamp's
// 403, and told the user to "reconnect the connector with write access", a
// setting that does not exist. The user had already said yes (chat consent
// "Changes: auto"); the answer read like a permissions problem of theirs
// (2026-08-17, prod).
//
// So: a full API token (or a plain session) can do everything its bearer can.
// A relay grant can read, and can additionally create/update/delete records
// exactly when the user's OWN chat consent says writes apply automatically —
// the same `write_mode` the in-app chat honours, read from the same endpoint.
// Actions stay out: the consent model has them always confirm, and a relayed
// chat has nowhere to ask.
type Caller =
  | { kind: "full" }
  | { kind: "grant"; slug: string; userId: string }
  /** A personal token held to a workspace and/or an access level. REST
   *  enforces both (token-access.ts); this side pins the workspace and lists
   *  only the tools the access level can run, so the model is never offered a
   *  write it will be refused. */
  | { kind: "held"; slug: string | null; lookOnly: boolean };

/** A relay grant another instance minted. Not caught with the other verify
 *  failures: it is the configuration fault to name, not a token to let the
 *  api reject later in words about permissions. */
export class GrantFromElsewhere extends Error {
  constructor(minted: string, here: string) {
    super(
      `This chat was started on the ${minted || "unnamed"} instance, but its assistant reached the ${here || "unnamed"} one. ` +
        `Nothing was read or changed. The ${minted || "starting"} instance must hand its bridge its own address (COBBLR_MCP_RELAY_URL).`,
    );
    this.name = "GrantFromElsewhere";
  }
}

async function callerOf(token: string): Promise<Caller> {
  if (token.startsWith("cbt_")) {
    const t = await resolveApiToken(token).catch(() => null);
    if (t && (t.access || t.orgId)) return { kind: "held", slug: t.orgSlug, lookOnly: t.access === "look" };
    return { kind: "full" };
  }
  try {
    const claims = await verifySession(token);
    const aud = typeof claims.aud === "string" ? claims.aud : "";
    if (aud.startsWith("mcp-read:") && claims.sub) {
      // Two instances can share a database and a signing secret (a canary
      // beside its release). A grant minted by the other one verifies here,
      // and its chat would then be answered by THIS instance's code, which
      // may be older: the canary's offered-change fix was invisible for a
      // day because its bridge was handed the release's address. Refuse it
      // by name instead of answering with the wrong build.
      // A grant from before grants said where they came from has no claim
      // to compare, and expires within the quarter hour.
      const minted = claims.ins;
      if (minted !== undefined && minted !== instanceOfGrants()) {
        throw new GrantFromElsewhere(minted, instanceOfGrants());
      }
      return { kind: "grant", slug: aud.slice("mcp-read:".length), userId: String(claims.sub) };
    }
  } catch (err) {
    if (err instanceof GrantFromElsewhere) {
      console.error(`[mcp] ${err.message}`);
      throw err;
    }
    // Not a JWT we can read — let the api's own auth reject it per call.
  }
  return { kind: "full" };
}

export type McpWriteMode = "off" | "ask" | "auto";
type WriteMode = McpWriteMode;

/** The user's chat consent, read with their own grant. Unreachable/unknown =
 *  "ask", which is the product default and the safe direction. */
async function writeModeFor(token: string, slug: string): Promise<WriteMode> {
  try {
    const body = (await rest(token, "GET", `/orgs/${slug}/modules/core-ai/chat/prefs`)) as {
      write_mode?: unknown;
    } | null;
    const m = body?.write_mode;
    return m === "auto" || m === "off" ? m : "ask";
  } catch {
    return "ask";
  }
}

/** Why this caller may not run this write tool, or null if they may.
 *
 *  TOOL granularity. invoke_action used to be refused here in every mode, on
 *  the reasoning that actions always confirm and a relay cannot ask - which
 *  removed the tool from the list entirely, so the assistant reported having no
 *  way to run ANY action rather than a reason (2026-08-19). But the real line
 *  was never actions-vs-records: a relay auto-applies create / update on
 *  records because those are tracked and undoable, and reordering locations
 *  is undone by reordering them again. So the tool follows the same consent as
 *  every other write, and the per-ACTION judgement moves to actionRefusal,
 *  where it can name the action and say what to do instead.
 *
 *  The one per-tool rule is the delete, held for a person in every mode, as
 *  the in-app chat holds it at auto. */
export function writeRefusal(tool: string, mode: WriteMode): string | null {
  // A delete is held for a person in the in-app chat at "auto" too: a
  // record's own text (a name, a scanned note) must never be able to steer
  // an unconfirmed delete, and an outside assistant reads the same text. So
  // the relay never offers one, whatever the mode.
  if (tool === "delete_record") {
    return "Deleting needs a person to confirm it, and this connection has no way to show a confirmation. Delete it in Cobblr, where the confirm step appears.";
  }
  if (mode === "auto") return null;
  return mode === "off"
    ? 'Changes are turned off for this chat. The user can allow them in the chat\'s tool settings ("Changes" → Ask or Auto).'
    : 'Changes are set to "Ask" for this chat, and this connection cannot show a confirmation prompt. The user can switch "Changes" to Auto in the chat\'s tool settings (every change stays tracked and undoable), or make this one in Cobblr directly.';
}

export { actionRefusal };

/** Why a RELAY grant (an in-app chat turn on a bridge) may not call this
 *  write tool at all, or null. The one answer the tool list and the call path
 *  both read, so the list can never offer a tool the call refuses.
 *
 *  A record write goes to the chat's own write door in every mode but "off":
 *  that door applies it, or OFFERS it to the person watching the turn when it
 *  may not apply on its own (#4574), so "no way to confirm" is never a reason
 *  to refuse it here. */
export function relayRefusal(tool: string, mode: WriteMode): string | null {
  if (LEDGERED_TOOLS.has(tool)) {
    return mode === "off" ? (writeRefusal(tool, "off") ?? "Changes are turned off for this chat.") : null;
  }
  return writeRefusal(tool, mode);
}

// Read tools that POST to read, shared with the stdio MCP server.
export { READ_TOOLS_THAT_POST };

/** The tool list a relay grant sees at `write_mode`. Exported so the guardrail
 *  test can assert advertise-equals-execute without going over HTTP. */
export function toolsForWriteMode(mode: WriteMode): typeof HOSTED_MCP_TOOLS {
  return HOSTED_MCP_TOOLS.filter((t) => {
    // A grant is pinned to the one workspace it was made in; the list of
    // workspaces is refused to it, and there is nothing to choose between.
    if (t.name === "cobblr_list_workspaces") return false;
    const reg = toolFromMcpName(t.name);
    // A service job's consent is the server's gate, not the Changes setting:
    // work that changes nothing runs even on Ask, and a physical job is
    // refused there with what to do instead.
    if (!reg || reg.consentBy) return true;
    if (reg.mode === "read") return !READ_TOOLS_THAT_POST.has(reg.name);
    return relayRefusal(reg.name, mode) === null;
  });
}

/** What a token held to look only is offered: no writes, and no read that has
 *  to POST. */
export function toolsForLookOnly(): typeof HOSTED_MCP_TOOLS {
  return HOSTED_MCP_TOOLS.filter((t) => {
    const reg = toolFromMcpName(t.name);
    return !reg || (reg.mode !== "write" && !READ_TOOLS_THAT_POST.has(reg.name));
  });
}

async function toolsFor(caller: Caller, token: string): Promise<typeof HOSTED_MCP_TOOLS> {
  if (caller.kind === "full") return HOSTED_MCP_TOOLS;
  if (caller.kind === "held") return caller.lookOnly ? toolsForLookOnly() : HOSTED_MCP_TOOLS;
  return toolsForWriteMode(await writeModeFor(token, caller.slug));
}

/** Tell the user's open chat turn what this relayed call is doing.
 *
 *  Fire-and-forget in both directions: a turn that is not open, a slow write, a
 *  failed one — none of it may delay or fail the tool the model is waiting on.
 *  Narration is worth exactly nothing if it can break the thing it narrates. */
/** The one human-readable thing in a tool result: what the record is called. */
function nameOf(data: unknown): string {
  if (data && typeof data === "object") {
    const n = (data as Record<string, unknown>).name;
    if (typeof n === "string" && n.trim()) return n.trim();
  }
  return "";
}

/** The writes the chat ledger knows how to record and undo. Exported because a
 *  write tool that is NOT in here bypasses the ledger silently — no undo beside
 *  the answer, no record of what was asked for — which is exactly how this bug
 *  arrived. A test holds this set against the registry's write tools. */
export const LEDGERED_TOOLS = new Set([
  "add_thing",
  "file_inbox_items",
  "create_record",
  "create_records",
  "update_record",
  "delete_record",
  "invoke_action",
]);

function narrate(token: string, slug: string, step: Record<string, unknown>): void {
  void rest(token, "POST", `/orgs/${slug}/modules/core-ai/chat/turns/open/steps`, step).catch(() => {});
}

async function callTool(name: string, args: Json, token: string, defaultSlug: string | null): Promise<unknown> {
  // The one non-workspace tool.
  if (name === "cobblr_list_workspaces") return rest(token, "GET", "/orgs");

  const tool = toolFromMcpName(name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  const caller = await callerOf(token);
  // A grant is pinned to ONE workspace server-side; honour that here too, so a
  // `workspace` argument can never aim the call — or the write grant minted for
  // it — at a different workspace than the one the user is chatting in.
  if (caller.kind === "held" && caller.lookOnly && (tool.mode === "write" || READ_TOOLS_THAT_POST.has(tool.name))) {
    throw new Error("This connection's token can look but not change anything. Make changes in Cobblr, or connect with a token that can make changes.");
  }
  const slug =
    caller.kind === "grant"
      ? caller.slug
      : caller.kind === "held" && caller.slug
        ? heldSlug(caller.slug, args)
        : slugOf(args, defaultSlug);

  // A relay grant reads with the token it was given; a consented record write
  // runs on a 60-second write grant minted here, for this call only, and never
  // handed back to the bridge.
  let execToken = token;
  if (caller.kind === "grant" && tool.mode === "write") {
    // A record write goes to the chat's own door, which applies it or offers
    // it for the person to confirm on the turn they are watching: a relayed
    // chat HAS a confirm step (#4574). Everything else is judged as before.
    const refusal = tool.consentBy ? null : relayRefusal(tool.name, await writeModeFor(token, caller.slug));
    if (refusal) throw new Error(refusal);
    execToken = await signMcpWriteGrant(caller.userId, caller.slug);
  }

  // Only a relay grant narrates: that is the caller that IS an in-app chat turn
  // the user is watching. A full API token is a script or a connector with no
  // panel in front of it.
  const write = tool.mode === "write";
  if (caller.kind === "grant") narrate(token, slug, { kind: "tool", name: tool.name, write, args });

  // A RECORD write goes through the chat's own write endpoint, not straight at
  // the module route, so it lands in the change ledger with a before-image and
  // an undo — the same treatment an in-app write gets. Doing it here rather
  // than at the module route is the point: the ledger is a property of "the
  // assistant changed something", not of any one module.
  if (caller.kind === "grant" && write && LEDGERED_TOOLS.has(tool.name)) {
    const led = (await rest(execToken, "POST", `/orgs/${slug}/modules/core-ai/chat/writes`, {
      tool: tool.name,
      args,
    })) as { ok?: boolean; message?: string; entity?: unknown } | null;
    // The endpoint narrates its own result (it is the one that knows the ledger
    // id, which is what an Undo is made of), so nothing more is said here.
    if (!led?.ok) throw new Error(led?.message ?? "the change could not be made");
    return led;
  }

  const result = await tool.execute(workspaceApiFor(execToken, slug), args);
  if (caller.kind === "grant") {
    narrate(token, slug, {
      kind: write && result.ok ? "applied" : "tool-result",
      name: tool.name,
      ok: result.ok,
      // A NAME, not the record. The panel is showing a person what is
      // happening; a serialised row with its uuid and its nulls is noise
      // wearing the clothes of detail.
      summary: (result.ok ? nameOf(result.data) : (result.error ?? "")).slice(0, 160),
    });
  }
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

/** One JSON-RPC message, answered. Exported so a test can ask the endpoint
 *  what it answers a grant without going over HTTP. */
export async function dispatch(msg: Json, token: string, defaultSlug: string | null): Promise<Json | null> {
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
      try {
        return rpcResult(id, { tools: await toolsFor(await callerOf(token), token) });
      } catch (e) {
        if (e instanceof GrantFromElsewhere) return rpcErr(id, -32001, e.message);
        throw e;
      }
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
      // Where a connector learns how to sign in (RFC 9728): every 401 names
      // the protected-resource metadata, so claude.ai can start OAuth from
      // nothing but this URL.
      const origin = originOf({ headers: req.headers as Record<string, string | string[] | undefined> });
      const challenge = (extra = "") =>
        `Bearer resource_metadata="${protectedResourceMetadataUrl(origin)}"${extra}`;
      if (!token) {
        return {
          status: 401,
          headers: { "www-authenticate": challenge() },
          body: { jsonrpc: "2.0", error: { code: -32001, message: "Missing bearer token. Connect with OAuth, or send Authorization: Bearer <cbt_…> (Configuration → Connect an AI assistant)." }, id: null },
        };
      }
      if (token.startsWith("cbt_")) {
        // An expired, revoked or foreign token is an HTTP 401, not a tool
        // error: that is what tells a connector to refresh or sign in again.
        const t = await resolveApiToken(token).catch(() => null);
        // A token in this deployment's own database, issued for its MCP
        // endpoint. Comparing the full URL re-derived the origin with a
        // guessed scheme and refused the connector's own token on a server
        // reached over plain http.
        if (!t || (t.audience && !t.audience.endsWith(MCP_PATH))) {
          return {
            status: 401,
            headers: { "www-authenticate": challenge(', error="invalid_token"') },
            body: { jsonrpc: "2.0", error: { code: -32001, message: "This token is not valid here. Sign in again." }, id: null },
          };
        }
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
