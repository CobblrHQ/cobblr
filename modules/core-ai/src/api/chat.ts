// Agentic chat — Cobb can READ the workspace and PROPOSE writes, in a real
// tool-calling loop (agent-loop.ts): read tools (search/list/get/kinds/
// actions) auto-run under the caller's own permissions and feed back into the
// model; WRITE tools stop the loop and come back as PROPOSALS the user
// confirms via POST /chat/execute — writes NEVER run inside the loop. The
// tools come from the SHARED registry (@cobblr/workspace-tools — the exact
// set the MCP server exposes), so the two AI surfaces stay capability-
// identical. Providers without tool support (e.g. a bridge target that
// ignores the field) degrade to the legacy one-JSON-move protocol below.

import { Router } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { tenantContext, sessionUserId, sessionDisplayName, tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import {
  WORKSPACE_TOOLS,
  WRITE_TOOLS,
  getTool,
  jsonSchemaOf,
  resolveCreatePath,
  resolveUpdatePath,
  resolveDeletePath,
  fetchKinds,
  type KindRec,
  type WorkspaceApi,
} from "@cobblr/workspace-tools";
import { runAgentLoop, type AgentLoopOutcome, type AppliedWrite } from "./agent-loop.js";
import { performWrite, undoWrite, undoableOf, type WriteRequest, type WriteOutcome } from "./chat-ledger.js";
import type { ToolCall, ChatTurn } from "../providers/tool-wire.js";

/** ToolCall → the ledgered write request shape (null = not a known write). */
function writeRequestOf(call: ToolCall): WriteRequest | null {
  const a = call.args ?? {};
  const kind = typeof a.kind === "string" ? a.kind : typeof a.entity_kind === "string" ? a.entity_kind : "";
  switch (call.name) {
    case "create_record":
      return kind ? { tool: "create", entity_kind: kind, fields: (a.fields as Record<string, unknown>) ?? {} } : null;
    case "update_record":
      return kind && a.id
        ? { tool: "update", entity_kind: kind, entity_id: String(a.id), fields: (a.fields as Record<string, unknown>) ?? {} }
        : null;
    case "delete_record":
      return kind && a.id ? { tool: "delete", entity_kind: kind, entity_id: String(a.id) } : null;
    case "invoke_action":
      return {
        tool: "action",
        entity_kind: kind,
        entity_id: a.entity_id ? String(a.entity_id) : undefined,
        action_id: String(a.action_id ?? ""),
        args: (a.args as Record<string, unknown>) ?? undefined,
      };
    default:
      return null;
  }
}

/** Applied-write summaries for the widget's "✓ done — Undo" cards. */
function appliedSummaries(applied: AppliedWrite[]): Array<{ summary: string; ledger_id?: string; undoable?: boolean }> {
  return applied.map((a) => {
    const r = a.result as WriteOutcome;
    return { summary: r?.message ?? a.call.name, ledger_id: r?.ledger_id, undoable: r?.undoable };
  });
}

export const chatRouter = Router({ mergeParams: true });
export { resolveCreatePath, type KindRec };

const WRITE_NAMES = new Set(WRITE_TOOLS.map((t) => t.name));

/** The registry's transport seam, bound to this request's workspace + auth —
 *  read tools run with exactly the caller's permissions. */
function chatWorkspaceApi(c: Ctx): WorkspaceApi {
  return {
    async request(method, path, body) {
      return callApi(c, method, path, body);
    },
  };
}

/** Per-user tool consent (migrations 0004+0005): may the chat READ workspace
 *  data into prompts, and the WRITE MODE — Claude-Code style:
 *    off  → no write proposals at all
 *    ask  → every write is a proposal the user confirms (default)
 *    auto → record creates/updates/deletes APPLY IMMEDIATELY (ledgered +
 *           undoable); ACTIONS still ask (irreversible side effects).
 *  Absent row = read on + ask. */
export type WriteMode = "off" | "ask" | "auto";
export interface ChatToolPrefs {
  read_tools: boolean;
  write_mode: WriteMode;
}
const DEFAULT_PREFS: ChatToolPrefs = { read_tools: true, write_mode: "ask" };

function asWriteMode(v: unknown): WriteMode {
  return v === "off" || v === "auto" ? v : "ask";
}

async function chatPrefsOf(req: Parameters<typeof tenantDb>[0]): Promise<ChatToolPrefs> {
  try {
    const row = await tenantDb(req)
      .selectFrom("core_ai_chat_prefs")
      .select(["read_tools", "write_mode"])
      .where("user_id", "=", sessionUserId(req) ?? "")
      .executeTakeFirst();
    return row ? { read_tools: !!row.read_tools, write_mode: asWriteMode(row.write_mode) } : DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS; // fail-open to defaults, never break the chat
  }
}

/** Neutral tool defs for the providers, FILTERED by the user's consent. Write
 *  tool descriptions match the mode (propose vs apply-with-undo). Read off +
 *  write off → [] → no tools sent, pure conversation. Exported for tests. */
export function toolDefsFor(prefs: ChatToolPrefs): Array<{ name: string; description: string; parameters: unknown }> {
  return WORKSPACE_TOOLS.filter((t) => (t.mode === "read" ? prefs.read_tools : prefs.write_mode !== "off")).map(
    (t) => ({
      name: t.name,
      description:
        t.mode === "write"
          ? prefs.write_mode === "auto" && t.name !== "invoke_action"
            ? `${t.description} (Applied immediately — every change is tracked and undoable.)`
            : `${t.description} (This PROPOSES the change — the user confirms before anything runs.)`
          : t.description,
      parameters: jsonSchemaOf(t.params),
    }),
  );
}

async function createPathFor(c: Ctx, kind: string): Promise<string | null> {
  const list = ((await callApi(c, "GET", "/entity-kinds")).body.items as KindRec[] | undefined) ?? [];
  return resolveCreatePath(kind, list);
}

interface Ctx {
  slug: string;
  /** Workspace display name ("Log it or Frog it") for prose; slug is for routing. */
  orgName: string;
  auth: string;
  base: string;
  /** The signed-in user Cobb is talking to — the only identity in the prompt.
   *  The bridge runs claude -p hermetically, so there is no host name to
   *  override; we just state who this is. */
  userName: string | null;
}
function ctxOf(req: Parameters<typeof tenantContext>[0]): Ctx {
  const org = tenantContext(req).org;
  return {
    slug: org.slug,
    orgName: org.name,
    auth: req.headers.authorization ?? "",
    base: `http://127.0.0.1:${process.env.API_PORT ?? "4000"}/api/v1`,
    userName: sessionDisplayName(req),
  };
}

async function callApi(
  c: Ctx,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`${c.base}/orgs/${c.slug}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: c.auth },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const b = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: r.status, body: b };
}

// ── context for the prompt: kinds + their wireable actions ──
interface Move {
  type: "reply" | "create" | "action" | "build";
  text?: string;
  entity_kind?: string;
  fields?: Record<string, unknown>;
  action_id?: string;
  entity_query?: string;
  intent?: string;
  summary?: string;
}

async function buildSystemPrompt(c: Ctx): Promise<string> {
  // include=custom_fields → the workspace's user-defined fields ride along, so
  // the hints below cover the WHOLE settable shape, not just native fields.
  const kindsRes = await callApi(c, "GET", "/entity-kinds?include=custom_fields");
  const kinds = ((kindsRes.body.items as KindRec[] | undefined) ?? []);
  const kindLines = kinds.map((k) => `- ${k.id} (${k.display_name ?? k.id})`).join("\n") || "(none)";

  // Actions per kind (a few in-process inspect calls).
  const actionLines: string[] = [];
  for (const k of kinds) {
    const insp = await callApi(c, "GET", `/actions/inspect?kind=${encodeURIComponent(k.id)}`);
    const acts = (insp.body.actions as Array<{ id: string; label: string; description?: string }> | undefined) ?? [];
    for (const a of acts) actionLines.push(`- ${a.id} (on ${k.id}) — ${a.label}${a.description ? `: ${a.description}` : ""}`);
  }
  // Createable = exactly what resolveCreatePath will accept at execute time —
  // the prompt never advertises a create that would 404 on confirm.
  const createableKinds = kinds.filter((k) => resolveCreatePath(k.id, kinds) !== null);
  const createable = createableKinds.map((k) => k.id);
  // Field hints so the model uses the kind's REAL field names (knowledge wants
  // "title", inventory wants "name", …) instead of guessing and 400ing at
  // confirm. Native fields only, capped to keep the prompt lean.
  const createFieldLines = createableKinds
    .map((k) => {
      const fs = (k.fields ?? []).slice(0, 8).map((f) => {
        const req = f.required || f.role === "title" ? " (required)" : "";
        return `${f.name}${f.type && f.type !== "text" ? `:${f.type}` : ""}${req}`;
      });
      // The workspace's own custom fields are just as settable (values land in
      // the record's metadata) — hint them too, marked so the model can tell.
      const cfs = (k.custom_fields ?? []).slice(0, 8).map((f) => {
        const choices = f.choices?.length ? ` [${f.choices.slice(0, 6).join("|")}]` : "";
        return `${f.name}${f.type && f.type !== "text" ? `:${f.type}` : ""}${choices} (custom)`;
      });
      const all = [...fs, ...cfs];
      return all.length ? `- ${k.id}: ${all.join(", ")}` : null;
    })
    .filter(Boolean) as string[];

  const whoLine = c.userName
    ? `You are talking to ${c.userName}.`
    : `You do not know the user's name — greet them without one, and do not guess.`;

  return `You are Cobb, the helpful assistant inside the "${c.orgName}" Cobblr workspace. Be genuinely useful and warm — you are NOT limited to workspace chores.

${whoLine}

Your name is Cobb. When the user asks who or what you are, introduce yourself as "Cobb, your assistant" — never as a generic "Cobblr workspace assistant" or "AI assistant". Cobb is who you are; Cobblr is the app you live in.

TWO THINGS YOU DO:
1. Answer questions and help with whatever the user asks — including general knowledge, how-to, crafts, ideas, explanations. Answer directly and fully; do not deflect a real question by saying you "only manage records". If you happen to know what's in their workspace that's relevant, weave it in.
2. Take actions in THIS workspace when the user wants to save, create, or change something — you PROPOSE the write and the user confirms before anything runs.

After a helpful answer, if it's natural, OFFER to save it (e.g. "want me to add this to your list / save it as a knowledge entry?") — but never force it, and never refuse the answer itself.

ENTITY KINDS in this workspace:
${kindLines}

You can CREATE new records of these kinds: ${createable.join(", ") || "(none)"}

Each createable kind's fields (use these EXACT field names in "fields"):
${createFieldLines.join("\n") || "(none)"}

ACTIONS you can run on existing records:
${actionLines.join("\n") || "(none)"}

TOOLS: when tools are available to you, PREFER them over the JSON shapes below. Use the read tools (search_records, list_records, get_record, list_record_kinds, list_actions, get_putaway_plan) to look at the user's ACTUAL data before answering questions about it — never guess what they have. get_putaway_plan is the live put-away/organize state — reach for it whenever the user mentions putting things away, bins, or their plan. After creating/renaming locations for them, call replan_putaway ONCE (non-destructive; their open plan refreshes itself) — optionally with a hint distilling the conversation. Use the write tools (create_record, update_record, delete_record, invoke_action) to act; they only PROPOSE — the user confirms every change. You can chain: read first, then write. The JSON shapes below are the fallback for when you cannot call tools.

Reply with ONE JSON object and nothing else, in ONE of these shapes:
- Chat/answer/ask:   {"type":"reply","text":"<your full, helpful answer or question>"}
- Create a record:   {"type":"create","entity_kind":"<id>","fields":{"name":"<...>", ...},"summary":"<one line, e.g. Create a part called Widget>"}
- Run an action:     {"type":"action","action_id":"<id>","entity_kind":"<id>","entity_query":"<the record's name to find it>","summary":"<one line>"}
- Build a whole app:  {"type":"build","intent":"<the user's FULL description of the workspace/app to set up>","summary":"<one line, e.g. Set up a yarn & crochet tracker>"}

Rules:
- Default to "reply" for questions, explanations, and anything conversational — put your ACTUAL answer in "text", not a deflection.
- Only use create/action when the user clearly wants to save or change something in the workspace.
- Use entity_kind / action_id values EXACTLY from the lists above. Never invent ids. If a needed kind/action isn't listed, use "reply" to answer and say what you can't save yet.
- create: use the kind's field names from the list above (its required/title field at minimum); add other obvious fields the user gave.
- action: entity_query is the name/text to find the existing record — the system looks it up.
- Use "build" only when the user wants to SET UP or DESIGN a whole new app/workspace (several kinds/modules at once). Put their full description in "intent". Never use "build" for a single record.`;
}

/** Best-effort display label for a record (falls back to the id). */
async function labelOf(wsApi: WorkspaceApi, kind: string, id: string): Promise<string> {
  try {
    const r = await getTool("get_record")!.execute(wsApi, { kind, id });
    if (r.ok) {
      const d = r.data as { title?: string; name?: string; fields?: { title?: string; name?: string } };
      return d.title ?? d.name ?? d.fields?.title ?? d.fields?.name ?? id;
    }
  } catch {
    /* fall through */
  }
  return id;
}

/** Turn one WRITE tool call into a user-facing proposal — or an honest error
 *  when the call couldn't succeed on confirm (undeclared kind, missing args). */
async function proposalOf(
  wsApi: WorkspaceApi,
  kinds: KindRec[],
  call: ToolCall,
): Promise<{ summary: string; proposal: Record<string, unknown> } | { error: string }> {
  const a = call.args ?? {};
  const kind = typeof a.kind === "string" ? a.kind : typeof a.entity_kind === "string" ? a.entity_kind : "";
  switch (call.name) {
    case "create_record": {
      if (!kind || !resolveCreatePath(kind, kinds)) return { error: `I can't create "${kind || "that"}" from chat yet.` };
      const fields = (a.fields as Record<string, unknown>) ?? {};
      const name = String(fields.title ?? fields.name ?? "").trim();
      return {
        summary: `Create a ${kind}${name ? `: “${name}”` : ""}`,
        proposal: { kind: "create", entity_kind: kind, fields },
      };
    }
    case "update_record": {
      const id = String(a.id ?? "");
      if (!kind || !id || !resolveUpdatePath(kind, id, kinds)) {
        return { error: `Records of "${kind || "that"}" can't be updated from chat yet.` };
      }
      const fields = (a.fields as Record<string, unknown>) ?? {};
      const label = await labelOf(wsApi, kind, id);
      return {
        summary: `Update “${label}” (${Object.keys(fields).join(", ") || "fields"})`,
        proposal: { kind: "update", entity_kind: kind, entity_id: id, fields, entity_label: label },
      };
    }
    case "delete_record": {
      const id = String(a.id ?? "");
      if (!kind || !id || !resolveDeletePath(kind, id, kinds)) {
        return { error: `Records of "${kind || "that"}" can't be deleted from chat yet.` };
      }
      const label = await labelOf(wsApi, kind, id);
      return {
        summary: `Delete “${label}” — permanent`,
        proposal: { kind: "delete", entity_kind: kind, entity_id: id, entity_label: label },
      };
    }
    case "invoke_action": {
      const actionId = String(a.action_id ?? "");
      const id = String(a.entity_id ?? "");
      if (!actionId || !kind || !id) return { error: "I need the action and the exact record to run it on." };
      const label = await labelOf(wsApi, kind, id);
      return {
        summary: `Run ${actionId} on “${label}”`,
        proposal: {
          kind: "action",
          action_id: actionId,
          entity_kind: kind,
          entity_id: id,
          entity_label: label,
          ...(a.args && typeof a.args === "object" ? { args: a.args } : {}),
        },
      };
    }
    default:
      return { error: `I tried an operation I don't actually have (“${call.name}”).` };
  }
}

function parseMove(raw: string): Move | null {
  const s = raw.indexOf("{");
  const e = raw.lastIndexOf("}");
  if (s === -1 || e === -1 || e < s) return null;
  try {
    const o = JSON.parse(raw.slice(s, e + 1)) as Move;
    return o && typeof o === "object" && typeof o.type === "string" ? o : null;
  } catch {
    return null;
  }
}

const ChatBody = z.object({
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })).min(1).max(40),
  // What the user is looking at right now (route + a one-line view summary the
  // page publishes). BOUNDED so a client can't stuff the prompt. See
  // web/src/lib/chat-context.ts.
  context: z
    .object({ label: z.string().min(1).max(120), summary: z.string().max(600).optional() })
    .optional(),
});

/** The system-prompt line telling Cobb what screen the user is on, for
 *  situational relevance. Empty when no context. Pure — the injection point is
 *  one call, so it can't silently drift. */
export function pageContextLine(context?: { label: string; summary?: string }): string {
  if (!context?.label) return "";
  const showing = context.summary ? ` Currently showing: ${context.summary}.` : "";
  return (
    `\n\nCURRENT VIEW: the user is looking at the "${context.label}" screen.${showing} ` +
    `Use this for situational relevance — you may lead with or reference what they're looking at — ` +
    `but still answer their ACTUAL question: if they ask about the whole workspace, answer workspace-wide, not just this screen.`
  );
}

chatRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = ChatBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const c = ctxOf(req);
    const orgId = tenantContext(req).org.id;

    let system: string;
    try {
      system = await buildSystemPrompt(c);
    } catch {
      system = `You are Cobb, the helpful assistant inside the "${c.orgName}" Cobblr workspace. Introduce yourself as Cobb if asked.${c.userName ? ` You are talking to ${c.userName}.` : ""} Chat helpfully; reply with {"type":"reply","text":"..."}.`;
    }
    // Situational awareness: what screen is the user on right now?
    system += pageContextLine(parsed.data.context);

    // The agent loop: read tools auto-run (through THIS caller's permissions,
    // via chatWorkspaceApi); write tool calls stop the loop and become the
    // proposals below. Tool-less providers never emit tool_calls, so the loop
    // degrades to exactly one model call → the legacy JSON-move parse.
    const wsApi = chatWorkspaceApi(c);
    // The user's tool consent gates everything downstream: which tool defs the
    // model sees, and (below) whether legacy JSON-move writes may propose.
    const prefs = await chatPrefsOf(req);
    const toolDefs = toolDefsFor(prefs);
    if (!prefs.read_tools || prefs.write_mode === "off") {
      system += `\n\nCONSENT: the user has turned OFF ${
        !prefs.read_tools && prefs.write_mode === "off"
          ? "workspace reading AND change proposals"
          : !prefs.read_tools
            ? "workspace reading (do not claim to know their data)"
            : "change proposals (answer + explain, but do not propose creates/updates/actions)"
      } for this chat. Respect that; if they ask for something it blocks, tell them about the toggles at the top of the chat.`;
    }
    if (prefs.write_mode === "auto") {
      system += `\n\nAUTO MODE: your record creates/updates/deletes apply IMMEDIATELY (every change is tracked and the user can undo it) — report what you did plainly. Actions still require the user's confirm.`;
    }
    // AUTO mode: record CRUD applies immediately through the ledger (undoable);
    // actions return null → still proposed. Hard cap per turn.
    const AUTO_WRITE_CAP = 10;
    let autoWrites = 0;
    const userId = sessionUserId(req) ?? "";
    const ldb = tenantDb(req);
    let outcome: AgentLoopOutcome;
    try {
      outcome = await runAgentLoop(parsed.data.messages as ChatTurn[], {
        callModel: async (turns) => {
          const r = await platform().ai.invoke({
            orgId,
            capability: "chat",
            // system rides as a first-class field (Anthropic drops a
            // "system"-role message); tools are the neutral defs every adapter
            // translates to its native dialect (tool-wire.ts).
            input: { system, messages: turns, ...(toolDefs.length ? { tools: toolDefs } : {}) },
            source: { kind: "core-ai:chat", id: orgId },
            userId: sessionUserId(req),
          });
          const result = r.result as
            | { content?: string; text?: string; tool_calls?: ToolCall[] }
            | string;
          if (typeof result === "string") return { content: result };
          return { content: result?.content ?? result?.text ?? "", tool_calls: result?.tool_calls };
        },
        executeRead: async (name, args) => {
          const tool = getTool(name);
          if (!tool || tool.mode !== "read") return { ok: false, error: `no such read tool: ${name}` };
          return tool.execute(wsApi, args);
        },
        isWrite: (name) => WRITE_NAMES.has(name),
        ...(prefs.write_mode === "auto"
          ? {
              executeWrite: async (call: ToolCall) => {
                const w = writeRequestOf(call);
                // Actions keep the confirm gate (irreversible); over-cap too.
                if (!w || w.tool === "action" || autoWrites >= AUTO_WRITE_CAP) return null;
                autoWrites++;
                return performWrite(wsApi, ldb, userId, w, { auto: true });
              },
            }
          : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(/no provider|not entitled|not available/i.test(msg) ? 409 : 502).json({
        type: "error",
        error: { code: "no_ai", message: msg },
      });
      return;
    }

    const done = appliedSummaries(outcome.applied);

    // Write tool calls → user-confirmed proposals (one per call; the widget
    // renders each with its own Confirm). Invalid calls turn into an honest
    // reply instead of a proposal that would fail on confirm. Anything ALREADY
    // auto-applied this turn rides along as `applied` (done-cards with Undo).
    if (outcome.kind === "writes" && prefs.write_mode === "off") {
      // Belt-and-braces: the model shouldn't have write tools when consent is
      // off, but a hallucinated call must still never become a proposal.
      res.json({ type: "reply", text: "Change proposals are turned off for this chat (see the toggles at the top). Flip “Propose changes” back on and ask again." });
      return;
    }
    if (outcome.kind === "writes") {
      const items: Array<{ summary: string; proposal: Record<string, unknown> }> = [];
      const problems: string[] = [];
      const kinds = await fetchKinds(wsApi).catch(() => [] as KindRec[]);
      for (const call of outcome.calls) {
        const built = await proposalOf(wsApi, kinds, call);
        if ("error" in built) problems.push(built.error);
        else items.push(built);
      }
      if (items.length === 0) {
        res.json({
          type: "reply",
          text: problems.join(" ") || outcome.text || "I couldn't line that up — can you rephrase?",
          ...(done.length ? { applied: done } : {}),
        });
        return;
      }
      if (items.length === 1) {
        res.json({
          type: "proposal",
          text: outcome.text || undefined,
          summary: items[0]!.summary,
          proposal: items[0]!.proposal,
          ...(done.length ? { applied: done } : {}),
        });
        return;
      }
      res.json({ type: "proposals", text: outcome.text || undefined, items, ...(done.length ? { applied: done } : {}) });
      return;
    }

    const text = outcome.text;

    const move = parseMove(text);
    if (!move || move.type === "reply") {
      res.json({ type: "reply", text: move?.text ?? text, ...(done.length ? { applied: done } : {}) });
      return;
    }

    // Consent gate for the LEGACY JSON-move protocol too (a tool-less provider
    // never saw the filtered tool list, so it can still emit write moves).
    if (prefs.write_mode === "off") {
      res.json({ type: "reply", text: "Change proposals are turned off for this chat (see the toggles at the top). Flip “Propose changes” back on and ask again." });
      return;
    }

    if (move.type === "create") {
      if (!move.entity_kind || !(await createPathFor(c, move.entity_kind))) {
        res.json({ type: "reply", text: `I can't create "${move.entity_kind ?? "that"}" from chat yet.` });
        return;
      }
      res.json({
        type: "proposal",
        summary: move.summary ?? `Create a ${move.entity_kind}`,
        proposal: { kind: "create", entity_kind: move.entity_kind, fields: move.fields ?? {} },
      });
      return;
    }

    // build — design a whole workspace. The core-authoring design-workspace
    // engine runs ~150s (enable modules + build fields/wires + auto-repair), so
    // /build returns immediately with a "building" draft and we hand the draft
    // id back to the client to POLL (GET .../drafts/:id). Blocking here would
    // bust the chat request's own proxy timeout. The widget shows the preview +
    // a confirm once the draft finishes.
    if (move.type === "build") {
      if (!move.intent || !move.intent.trim()) {
        res.json({ type: "reply", text: "Tell me what you'd like your workspace to do and I'll set it up." });
        return;
      }
      const br = await callApi(c, "POST", "/modules/core-authoring/build", {
        intent: move.intent.trim(),
        task: "design-workspace",
      });
      if (br.status === 409) {
        res.json({ type: "reply", text: "Setting up a whole workspace needs AI enabled here: it isn't yet." });
        return;
      }
      const b = br.body as { draft_id?: string };
      if (!b.draft_id) {
        res.json({ type: "reply", text: "I couldn't start the build just now. Give it another try in a moment." });
        return;
      }
      // building: true → the widget polls the draft, then renders preview + confirm.
      res.json({
        type: "build-proposal",
        building: true,
        draft_id: b.draft_id,
        summary: move.summary ?? "Designing your workspace…",
      });
      return;
    }

    // action — resolve the entity by name via search before proposing.
    if (move.type === "action") {
      if (!move.action_id || !move.entity_kind || !move.entity_query) {
        res.json({ type: "reply", text: "I need a bit more to do that, which record exactly?" });
        return;
      }
      const sr = await callApi(
        c,
        "GET",
        `/modules/core-search/search?q=${encodeURIComponent(move.entity_query)}&kinds=${encodeURIComponent(move.entity_kind)}`,
      );
      const hits = ((sr.body.items as Array<{ id: string; kind?: string; title?: string }> | undefined) ?? []).filter(
        (h) => !h.kind || h.kind === move.entity_kind,
      );
      if (hits.length === 0) {
        res.json({ type: "reply", text: `I couldn't find a ${move.entity_kind} matching "${move.entity_query}".` });
        return;
      }
      if (hits.length > 1) {
        const names = hits.slice(0, 6).map((h) => `“${h.title ?? h.id}”`).join(", ");
        res.json({ type: "reply", text: `I found a few matching "${move.entity_query}": ${names}. Which one?` });
        return;
      }
      const hit = hits[0]!;
      res.json({
        type: "proposal",
        summary: move.summary ?? `Run ${move.action_id} on “${hit.title ?? hit.id}”`,
        proposal: {
          kind: "action",
          action_id: move.action_id,
          entity_kind: move.entity_kind,
          entity_id: hit.id,
          entity_label: hit.title ?? hit.id,
        },
      });
      return;
    }

    res.json({ type: "reply", text });
  }),
);

// ── GET/PUT /chat/prefs — the user's tool consent for THIS workspace ──
chatRouter.get(
  "/prefs",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    res.json(await chatPrefsOf(req));
  }),
);

// write_mode is the source of truth; write_tools (boolean era) accepted for
// back-compat (false → off, true → ask) and kept in sync for old readers.
const PrefsBody = z.object({
  read_tools: z.boolean(),
  write_mode: z.enum(["off", "ask", "auto"]).optional(),
  write_tools: z.boolean().optional(),
});

chatRouter.put(
  "/prefs",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = PrefsBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const userId = sessionUserId(req);
    if (!userId) {
      res.status(401).json({ error: { code: "no_session", message: "Sign in first." } });
      return;
    }
    const mode: WriteMode = parsed.data.write_mode ?? (parsed.data.write_tools === false ? "off" : "ask");
    const writeTools = mode !== "off";
    await tenantDb(req)
      .insertInto("core_ai_chat_prefs")
      .values({ user_id: userId, read_tools: parsed.data.read_tools, write_tools: writeTools, write_mode: mode })
      .onConflict((oc) =>
        oc.column("user_id").doUpdateSet({
          read_tools: parsed.data.read_tools,
          write_tools: writeTools,
          write_mode: mode,
          updated_at: new Date(),
        }),
      )
      .execute();
    res.json({ read_tools: parsed.data.read_tools, write_mode: mode });
  }),
);

// ── The AI change ledger: list + undo ──
chatRouter.get(
  "/writes",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const c = ctxOf(req);
    const wsApi = chatWorkspaceApi(c);
    const kinds = await fetchKinds(wsApi).catch(() => [] as KindRec[]);
    const rows = await tenantDb(req)
      .selectFrom("core_ai_chat_writes")
      .selectAll()
      .orderBy("created_at", "desc")
      .limit(50)
      .execute();
    res.json({
      items: rows.map((r) => ({
        id: r.id,
        tool: r.tool,
        entity_kind: r.entity_kind,
        entity_id: r.entity_id,
        entity_label: r.entity_label,
        auto_applied: r.auto_applied,
        undone_at: r.undone_at,
        undo_of: r.undo_of,
        created_at: r.created_at,
        undoable: undoableOf(r, kinds),
      })),
    });
  }),
);

chatRouter.post(
  "/writes/:id/undo",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const c = ctxOf(req);
    const userId = sessionUserId(req);
    if (!userId) {
      res.status(401).json({ error: { code: "no_session", message: "Sign in first." } });
      return;
    }
    const out = await undoWrite(chatWorkspaceApi(c), tenantDb(req), userId, String(req.params.id));
    res.status(out.ok ? 200 : 400).json(out);
  }),
);

// ── POST /chat/execute — run a confirmed proposal ──
const ExecBody = z.object({
  proposal: z.union([
    z.object({ kind: z.literal("create"), entity_kind: z.string(), fields: z.record(z.unknown()) }),
    z.object({
      kind: z.literal("update"),
      entity_kind: z.string(),
      entity_id: z.string(),
      fields: z.record(z.unknown()),
    }),
    z.object({ kind: z.literal("delete"), entity_kind: z.string(), entity_id: z.string() }),
    z.object({
      kind: z.literal("action"),
      action_id: z.string(),
      entity_kind: z.string(),
      entity_id: z.string(),
      args: z.record(z.unknown()).optional(),
    }),
    z.object({ kind: z.literal("build"), draft_id: z.string() }),
  ]),
});

chatRouter.post(
  "/execute",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = ExecBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const c = ctxOf(req);
    const p = parsed.data.proposal;

    // Every record write + action runs through performWrite → the AI change
    // ledger (before-image captured, undo available). One path, confirmed or
    // auto — the ONLY way chat writes happen.
    if (p.kind === "create" || p.kind === "update" || p.kind === "delete") {
      const userId = sessionUserId(req) ?? "";
      const out = await performWrite(
        chatWorkspaceApi(c),
        tenantDb(req),
        userId,
        {
          tool: p.kind,
          entity_kind: p.entity_kind,
          ...(p.kind !== "create" ? { entity_id: p.entity_id } : {}),
          ...(p.kind !== "delete" ? { fields: p.fields } : {}),
        },
        { auto: false },
      );
      res.status(out.ok ? 200 : 400).json(out);
      return;
    }

    if (p.kind === "build") {
      // Apply the validated design-workspace draft (install re-validates +
      // enables the required modules, then seeds any planned starter records).
      const r = await callApi(c, "POST", `/modules/core-authoring/drafts/${p.draft_id}/apply`, { confirm: true });
      if (r.status >= 400) {
        res.status(r.status).json({
          ok: false,
          message: (r.body.error as { message?: string } | undefined)?.message ?? "Couldn't set up the workspace.",
        });
        return;
      }
      const created = (r.body.seeded as { created?: number } | undefined)?.created ?? 0;
      res.json({
        ok: true,
        message:
          "Your workspace is set up — modules enabled and fields added" +
          (created > 0 ? `, plus ${created} starter record${created === 1 ? "" : "s"} created.` : "."),
      });
      return;
    }

    // action — ledgered too (recorded, not undoable).
    const out = await performWrite(
      chatWorkspaceApi(c),
      tenantDb(req),
      sessionUserId(req) ?? "",
      { tool: "action", entity_kind: p.entity_kind, entity_id: p.entity_id, action_id: p.action_id, args: p.args },
      { auto: false },
    );
    res.status(out.ok ? 200 : 400).json(out);
  }),
);
