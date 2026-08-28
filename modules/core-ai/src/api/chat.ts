// Agentic chat — Cobb can READ the workspace and PROPOSE writes, in a real
// tool-calling loop (agent-loop.ts): read tools (search/list/get/kinds/
// actions) auto-run under the caller's own permissions and feed back into the
// model; WRITE tools stop the loop and come back as PROPOSALS the user
// confirms via POST /chat/execute — writes NEVER run inside the loop. The
// tools come from the SHARED registry (@cobblr/workspace-tools — the exact
// set the MCP server exposes), so the two AI surfaces stay capability-
// identical. Providers without tool support (e.g. a bridge target that
// ignores the field) degrade to the legacy one-JSON-move protocol below.

import { Router, type Response } from "express";
import { humanizeProviderError } from "./provider-error.js";
import { renderEntityActions, renderWorkspaceActions, RAIL_LOOKUP_NOTE, type RailMode } from "./action-rail.js";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { matchCommand } from "./basics.js";
import { selectionLine } from "../selection-line.js";
import { suggestionLine } from "../suggestion-line.js";
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
import { runAgentLoop, type AgentLoopDeps, type AgentLoopOutcome, type AppliedWrite } from "./agent-loop.js";
import { createTurn, emitTurnEvent, finishTurn, readTurn, eventsAfter, openTurnFor, subscribe, sweepTurns } from "./turns.js";
import { recordRound } from "../providers/replay.js";
import { performWrite, performWrites, undoWrite, undoableOf, type WriteRequest, type WriteOutcome } from "./chat-ledger.js";
import type { ToolCall, ChatTurn } from "../providers/tool-wire.js";
import { summariseAction, type ActionCopy } from "./action-summary.js";
import { appSurfacePrompt } from "./app-surface.js";
import { inferMoveFromToolShape, jsonBlockIn } from "./tool-shaped-move.js";

/** ToolCall → the ledgered write request shape (null = not a known write). */
/** The writes a tool call MEANS — one for a single write, many for a bulk one.
 *  Both write paths (the in-app loop and the relayed one) go through here, so
 *  neither can learn about a new write tool without the other. */
export function writeRequestsOf(call: ToolCall): WriteRequest[] {
  const a = call.args ?? {};
  if (call.name === "create_records") {
    const kind = typeof a.kind === "string" ? a.kind : "";
    const rows = Array.isArray(a.records) ? (a.records as Array<Record<string, unknown>>) : [];
    if (!kind || rows.length === 0) return [];
    // The tool's own schema caps this too; enforced again here because this is
    // the side that actually writes, and a cap that lives only in a schema the
    // model is asked to respect is a suggestion.
    return rows.slice(0, BULK_RECORD_CAP).map((fields) => ({ tool: "create" as const, entity_kind: kind, fields }));
  }
  const one = writeRequestOf(call);
  return one ? [one] : [];
}

/** In auto mode, which write calls STILL hold for confirmation instead of
 *  auto-applying. Actions (irreversible side effects) hold, and so do
 *  destructive record ops — a delete, including any bulk/multi delete. Creates
 *  and updates auto-apply. The reason deletes hold even in auto: untrusted
 *  workspace content (entity names/descriptions/scanned text pulled into Cobb's
 *  context) must never be able to steer an UNCONFIRMED delete. Pure so the same
 *  decision the auto-write closure makes can be asserted directly. */
export function autoWriteMustHold(ws: WriteRequest[]): boolean {
  const w = ws[0];
  if (!w) return true;
  return w.tool === "action" || ws.some((r) => r.tool === "delete");
}

/** One deliberate instruction may carry many records; a LOOP that keeps
 *  deciding to write is the thing AUTO_WRITE_CAP is for. So a bulk call counts
 *  as one write against that cap, and its own size is capped here — the same
 *  200 a learned command is allowed. */
const BULK_RECORD_CAP = 200;

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
export function chatWorkspaceApi(c: Ctx): WorkspaceApi {
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
 *    auto → record creates/updates APPLY IMMEDIATELY (ledgered + undoable);
 *           DELETES and ACTIONS still ask (destructive / irreversible side
 *           effects — an unconfirmed delete must never be steerable by
 *           untrusted workspace content).
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
export function ctxOf(req: Parameters<typeof tenantContext>[0]): Ctx {
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
  args?: Record<string, unknown>;
  intent?: string;
  summary?: string;
}

/** The anti-confabulation rules, kept as a named constant because they are the
 *  part of the prompt most likely to be "tidied" by someone shortening it.
 *
 *  Measured against gemini-flash-lite (the free-tier default, so the model most
 *  users actually run): asked "tell me about the founder of Cobblr", six of six
 *  runs without these rules invented an answer — three named a real person who
 *  has nothing to do with it, three invented a company. Six of six WITH them
 *  said they do not know. A weaker model does not need a lighter prompt; it
 *  needs a firmer one. */
/** How an answer READS.
 *
 *  Asked "tell me about these" for two racks, Cobb replied with their storage
 *  classification, that they sit under the same parent, the parent's uuid, and
 *  three offers of help. Everything true; almost nothing wanted. A person
 *  asking about two shelves wants to know what is on them.
 *
 *  Kept beside the grounding rules because they are the same job from two
 *  sides: that one is about not saying what you do not know, this one is about
 *  not saying what nobody asked. */
export const PLAIN_ANSWER_RULES = `HOW TO ANSWER:
- Lead with the answer. One or two sentences for a simple question, and stop. A person scanning a shelf does not read a report.
- Never show an id, a uuid, or an internal field name. Say what the thing is CALLED. If you only have an id, say "its parent" rather than printing it.
- Do not narrate the shape of the data: not "a container location configured as a top-level storage unit", just "a rack". Its kind, its parent and its settings are worth mentioning only when they answer what was asked.
- Empty is a fine answer. "Both are empty." beats a paragraph explaining that nothing is placed inside them.
- Offer ONE next step, if an obvious one exists. Not three.`;

export const GROUNDING_RULES = `WHAT YOU CAN SEE, AND WHAT YOU CANNOT. This matters more than sounding helpful:
- You can see three things: this conversation, whatever a tool call has just returned, and the list of app features you are given below. Being inside this app does not tell you how the rest of it works — the list is what you know about the product, and there is nothing behind it. Everything else — the outside world, real people, companies, products, prices, dates — you have only general knowledge of, which is not the same as knowing.
- So never state a SPECIFIC you cannot check: a person's name, who made or owns something, a date, a price, a figure, a URL, a quote. This holds for the makers of this app exactly as it holds for anyone else — being inside their software tells you how it works, not who they are.
- "I don't know" is a complete answer. A confident wrong one costs you the user's trust in every other answer you give, including the ones about their own data.
- Anything about the user's own records comes from a tool call you just made, never from memory. If you have not looked, look — or say you have not.
- None of this makes you cagey. Explain, teach, suggest, and talk through anything you actually do know — how to do a thing, how this app works, what you would try. Answer the part you know and name the part you do not.`;

async function buildSystemPrompt(c: Ctx, railMode: RailMode = "full"): Promise<string> {
  // include=custom_fields → the workspace's user-defined fields ride along, so
  // the hints below cover the WHOLE settable shape, not just native fields.
  const kindsRes = await callApi(c, "GET", "/entity-kinds?include=custom_fields");
  const kinds = ((kindsRes.body.items as KindRec[] | undefined) ?? []);
  const kindLines = kinds.map((k) => `- ${k.id} (${k.display_name ?? k.id})`).join("\n") || "(none)";

  // Every action, in ONE call, carrying the two things the old per-kind
  // inspect loop dropped: which run on the WORKSPACE rather than a record, and
  // what ARGUMENTS each takes.
  //
  // Without those, a tool-less provider cannot express "reorder these ids".
  // Asked to order twelve racks, the model was given a shape with no `args`
  // field and an action list that pretended core-locations:reorder ran on a
  // record, so it proposed the action against the parent location with no ids —
  // uninvokable, and the user was told it could not be done (2026-08-19).
  // Which modules this workspace actually runs. A screen belonging to one it
  // does not have is not somewhere it can go, and naming it would be the
  // original bug wearing a badge.
  let enabledModules: Set<string> | undefined;
  try {
    const mods = await callApi(c, "GET", "/modules");
    const items = (mods.body.items as Array<{ name?: string; module_name?: string; enabled?: boolean }> | undefined) ?? [];
    const names = items
      .filter((m) => m.enabled !== false)
      .map((m) => m.module_name ?? m.name)
      .filter((n): n is string => !!n);
    if (names.length) enabledModules = new Set(names);
  } catch {
    // Unknown: show the whole list rather than hiding features that exist.
  }

  const reg = await callApi(c, "GET", "/registered-actions");
  const allActions =
    (reg.body.items as
      | Array<{
          id: string;
          label: string;
          description?: string;
          scope?: string;
          matched_kinds?: string[];
          args_schema?: Record<string, { label?: string; type?: string }> | null;
          examples?: string[];
        }>
      | undefined) ?? [];
  // With tools, the model can call list_actions for an action's description,
  // arguments and phrasings, so the prompt carries an INDEX (id + label) and
  // spends its tokens elsewhere. Without tools there is nothing to call, so
  // the full rail is the only description it will ever see. See action-rail.ts
  // for what this costs.
  const actionLines = renderEntityActions(allActions, railMode);
  const workspaceActionLines = renderWorkspaceActions(allActions, railMode);
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

${GROUNDING_RULES}

${PLAIN_ANSWER_RULES}

${appSurfacePrompt(enabledModules)}

After a helpful answer, if it's natural, OFFER to save it (e.g. "want me to add this to your list / save it as a knowledge entry?") — but never force it, and never refuse the answer itself.

ENTITY KINDS in this workspace:
${kindLines}

You can CREATE new records of these kinds: ${createable.join(", ") || "(none)"}

Each createable kind's fields (use these EXACT field names in "fields"):
${createFieldLines.join("\n") || "(none)"}

ACTIONS you can run on existing records:
${actionLines.join("\n") || "(none)"}

ACTIONS that run on the WORKSPACE (no record — omit entity_kind/entity_query):
${workspaceActionLines.join("\n") || "(none)"}
${railMode === "full" ? "" : RAIL_LOOKUP_NOTE}

TOOLS: when tools are available to you, PREFER them over the JSON shapes below. Use the read tools (search_records, list_records, count_records, get_record, list_record_kinds, list_actions, get_putaway_plan) to look at the user's ACTUAL data before answering questions about it — never guess what they have. For "how many", "which do I have the most of", "do I have any X": call count_records (group_by a field) — it counts every record in code. A list page marked PARTIAL is never the whole set: do not count, rank, or say "none" from it. get_putaway_plan is the live put-away/organize state — reach for it whenever the user mentions putting things away, bins, or their plan. After creating/renaming locations for them, call replan_putaway ONCE (non-destructive; their open plan refreshes itself) — optionally with a hint distilling the conversation. Use the write tools (create_record, update_record, delete_record, invoke_action) to act; they only PROPOSE — the user confirms every change. You can chain: read first, then write. The JSON shapes below are the fallback for when you cannot call tools.

Reply with ONE JSON object and nothing else, in ONE of these shapes:
- Chat/answer/ask:   {"type":"reply","text":"<your full, helpful answer or question>"}
- Create a record:   {"type":"create","entity_kind":"<id>","fields":{"name":"<...>", ...},"summary":"<one line, e.g. Create a part called Widget>"}
- Run an action:     {"type":"action","action_id":"<id>","entity_kind":"<id>","entity_query":"<the record's name to find it>","args":{...},"summary":"<one line>"}
- Workspace action:  {"type":"action","action_id":"<id>","args":{...},"summary":"<one line>"}
- Build a whole app:  {"type":"build","intent":"<the user's FULL description of the workspace/app to set up>","summary":"<one line, e.g. Set up a yarn & crochet tracker>"}

Rules:
- Default to "reply" for questions, explanations, and anything conversational — put your ACTUAL answer in "text", not a deflection.
- Only use create/action when the user clearly wants to save or change something in the workspace.
- Use entity_kind / action_id values EXACTLY from the lists above. Never invent ids. If a needed kind/action isn't listed, use "reply" to answer and say what you can't save yet.
- create: use the kind's field names from the list above (its required/title field at minimum); add other obvious fields the user gave.
- action: entity_query is the name/text to find the existing record — the system looks it up. For an action in the WORKSPACE list, omit entity_kind and entity_query entirely.
- action args: pass every argument the action lists, under "args", by name. A "list" arg is a JSON array in the order you mean, e.g. {"ids":["<id-a>","<id-b>"]} — read the ids first and pass the real ones, never a name. An action whose args you cannot fill is one to ASK about, not to guess at.
- Use "build" only when the user wants to SET UP or DESIGN a whole new app/workspace (several kinds/modules at once). Put their full description in "intent". Never use "build" for a single record.`;
}

/** The action's own words: its label and what its arguments are called. The
 *  registry has carried these all along; the confirm card simply never asked. */
async function actionCopy(c: Ctx, actionId: string): Promise<ActionCopy | null> {
  try {
    const reg = await callApi(c, "GET", "/registered-actions");
    const items = (reg.body.items as Array<{ id: string } & ActionCopy> | undefined) ?? [];
    return items.find((x) => x.id === actionId) ?? null;
  } catch {
    return null; // summariseAction falls back to the id
  }
}

/** Does this action run on the WORKSPACE rather than a record? Read from the
 *  registry, not guessed from whether the model bothered to name an entity —
 *  the model naming one is exactly the mistake to survive (it invented a parent
 *  location to satisfy a shape that demanded a record). */
async function isWorkspaceAction(c: Ctx, actionId: string): Promise<boolean> {
  try {
    const reg = await callApi(c, "GET", "/registered-actions");
    const items = (reg.body.items as Array<{ id: string; scope?: string }> | undefined) ?? [];
    return items.find((a) => a.id === actionId)?.scope === "workspace";
  } catch {
    return false; // unknown → treat as record-scoped, the stricter path
  }
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
  c: Ctx,
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
      if (!actionId) return { error: "I need to know which action to run." };
      const args = a.args && typeof a.args === "object" ? { args: a.args } : {};
      // A workspace action HAS no record. Demanding one here refused the whole
      // class from chat, which is how reordering locations became something
      // Cobb could describe and not do.
      const copy = await actionCopy(c, actionId);
      const argValues = (a.args && typeof a.args === "object" ? a.args : {}) as Record<string, unknown>;
      if (!kind || !id) {
        if (!(await isWorkspaceAction(c, actionId))) {
          return { error: "I need the action and the exact record to run it on." };
        }
        return {
          summary: summariseAction(actionId, copy, argValues),
          proposal: { kind: "action", action_id: actionId, ...args },
        };
      }
      const label = await labelOf(wsApi, kind, id);
      return {
        summary: summariseAction(actionId, copy, argValues, label),
        proposal: {
          kind: "action",
          action_id: actionId,
          entity_kind: kind,
          entity_id: id,
          entity_label: label,
          ...args,
        },
      };
    }
    default:
      return { error: `I tried an operation I don't actually have (“${call.name}”).` };
  }
}

function parseMove(raw: string): Move | null {
  const parsed = jsonBlockIn(raw);
  if (parsed && typeof parsed === "object" && typeof (parsed as Move).type === "string") {
    return parsed as Move;
  }
  // No `type`, but it may still plainly BE a call: some models answer a request
  // to act by writing out the tool's own arguments in a fenced block instead of
  // calling it (granite3.3, command-r7b — measured 2026-08-25, both scoring 1/8
  // for this reason alone). They wrote the right thing; nobody was reading it.
  return inferMoveFromToolShape(parsed) as Move | null;
}

const ChatBody = z.object({
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })).min(1).max(40),
  // What the user is looking at right now (route + a one-line view summary the
  // page publishes). BOUNDED so a client can't stuff the prompt. See
  // web/src/lib/chat-context.ts.
  context: z
    .object({ label: z.string().min(1).max(120), summary: z.string().max(600).optional() })
    .optional(),
  // What the user is POINTING AT: rows they ticked, or a highlight. Bounded the
  // same way as the context above — a client cannot stuff the prompt.
  selection: z
    .object({
      label: z.string().min(1).max(200),
      kind: z.string().max(120).optional(),
      ids: z.array(z.string().max(64)).max(200).optional(),
      text: z.string().max(2000).optional(),
    })
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

/** Everything a chat turn does after the request is validated: run the
 *  agent loop, turn the outcome into the response the widget renders.
 *  Extracted so the SAME code serves the legacy blocking POST and the
 *  persisted-turn path; a `res.json` in here would tie it to one. */
class TurnError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function runTurn(
  req: Parameters<typeof tenantDb>[0],
  parsed: { data: z.infer<typeof ChatBody> },
  system: string,
  c: Ctx,
  orgId: string,
  onEvent?: AgentLoopDeps["onEvent"],
  /** The persisted turn this run belongs to, so a write can be traced back to
   *  the sentence that asked for it. Absent for the blocking (non-turn) path. */
  turnId?: string,
): Promise<Record<string, unknown>> {
  // The agent loop: read tools auto-run (through THIS caller's permissions,
  // via chatWorkspaceApi); write tool calls stop the loop and become the
  // proposals below. Tool-less providers never emit tool_calls, so the loop
  // degrades to exactly one model call → the legacy JSON-move parse.
  const wsApi = chatWorkspaceApi(c);
  const askedFor = [...parsed.data.messages].reverse().find((m) => m.role === "user")?.content ?? "";
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
  // Escorts the loop's take_user_to calls produced this turn — the widget
  // navigates to each (and pages read the prefill params). Inert server-side.
  const escorts: Array<{ path: string; label: string }> = [];
  let outcome: AgentLoopOutcome;
  try {
    outcome = await runAgentLoop(parsed.data.messages as ChatTurn[], {
      callModel: async (turns) => {
        const r = await platform().ai.invoke({
          orgId,
          capability: "chat",
          // Show the answer being written. Only when somebody is listening to
          // this turn (the persisted-turn path); the blocking POST has nobody
          // to show it to.
          ...(onEvent ? { onDelta: (text: string) => void onEvent({ kind: "text-delta", text }) } : {}),
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
        const round = { content: result?.content ?? result?.text ?? "", tool_calls: result?.tool_calls };
        // Cassette recording (COBBLR_AI_REPLAY_RECORD): capture what a REAL
        // model said, per round, to build replay fixtures. No-op unless set,
        // and the provider id is what keeps a replay from recording itself.
        recordRound(turns, round, r.provider_id);
        return round;
      },
      executeRead: async (name, args) => {
        const tool = getTool(name);
        if (!tool || tool.mode !== "read") return { ok: false, error: `no such read tool: ${name}` };
        const result = await tool.execute(wsApi, args);
        // The escort tool (tier 1.5) rides the read rail — it mutates nothing
        // — but its OUTPUT is for the widget, not only the model: collect the
        // destinations so the response can move the user's screen there.
        if (name === "take_user_to" && result.ok) {
          const esc = (result.data as { escort?: { path: string; label: string } } | null)?.escort;
          if (esc) escorts.push(esc);
        }
        return result;
      },
      isWrite: (name) => WRITE_NAMES.has(name),
      ...(onEvent ? { onEvent } : {}),
      ...(prefs.write_mode === "auto"
        ? {
            executeWrite: async (call: ToolCall) => {
              const ws = writeRequestsOf(call);
              const w = ws[0];
              // Actions + destructive record ops (delete, incl. bulk/multi
              // delete) keep the confirm gate even in auto mode; over-cap too.
              // See autoWriteMustHold for why deletes hold. Creates/updates auto-apply.
              if (!w || autoWriteMustHold(ws) || autoWrites >= AUTO_WRITE_CAP) return null;
              autoWrites++;
              if (ws.length > 1) {
                return performWrites(wsApi, ldb, userId, ws, {
                  auto: true,
                  orgId,
                  prompt: askedFor,
                  ...(turnId ? { turnId } : {}),
                });
              }
              return performWrite(wsApi, ldb, userId, w, {
                auto: true,
                orgId,
                // Half of a worked example: what was asked, beside what was
                // done. Without it the ledger records twelve racks appearing
                // and no record of anyone asking for them.
                prompt: askedFor,
                ...(turnId ? { turnId } : {}),
              });
            },
          }
        : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = /no provider|not entitled|not available/i.test(msg) ? 409 : 502;
    // A 502 here left NO server-side trace — the only record was one
    // access-log line, so diagnosing one meant reconstructing the turn from
    // proxy, container and relay logs. The chat that fails for an
    // infrastructure reason is exactly the one worth logging (2026-08-18).
    if (status === 502) console.error(`[core-ai] chat failed: ${msg}`);
    throw new TurnError(status, msg);
  }

  const done = appliedSummaries(outcome.applied);

  // Write tool calls → user-confirmed proposals (one per call; the widget
  // renders each with its own Confirm). Invalid calls turn into an honest
  // reply instead of a proposal that would fail on confirm. Anything ALREADY
  // auto-applied this turn rides along as `applied` (done-cards with Undo).
  if (outcome.kind === "writes" && prefs.write_mode === "off") {
    // Belt-and-braces: the model shouldn't have write tools when consent is
    // off, but a hallucinated call must still never become a proposal.
    return { type: "reply", text: "Change proposals are turned off for this chat (see the toggles at the top). Flip “Propose changes” back on and ask again." };
  }
  if (outcome.kind === "writes") {
    const items: Array<{ summary: string; proposal: Record<string, unknown> }> = [];
    const problems: string[] = [];
    const kinds = await fetchKinds(wsApi).catch(() => [] as KindRec[]);
    for (const call of outcome.calls) {
      const built = await proposalOf(c, wsApi, kinds, call);
      if ("error" in built) problems.push(built.error);
      else items.push(built);
    }
    if (items.length === 0) {
      return {
        type: "reply",
        text: problems.join(" ") || outcome.text || "I couldn't line that up — can you rephrase?",
        ...(done.length ? { applied: done } : {}),
        ...(escorts.length ? { escorts } : {}),
      };
    }
    if (items.length === 1) {
      return {
        type: "proposal",
        text: outcome.text || undefined,
        summary: items[0]!.summary,
        proposal: items[0]!.proposal,
        ...(done.length ? { applied: done } : {}),
        ...(escorts.length ? { escorts } : {}),
      };
    }
    return { type: "proposals", text: outcome.text || undefined, items, ...(done.length ? { applied: done } : {}), ...(escorts.length ? { escorts } : {}) };
  }

  const text = outcome.text;

  const move = parseMove(text);
  if (!move || move.type === "reply") {
    return { type: "reply", text: move?.text ?? text, ...(done.length ? { applied: done } : {}), ...(escorts.length ? { escorts } : {}) };
  }

  // Consent gate for the LEGACY JSON-move protocol too (a tool-less provider
  // never saw the filtered tool list, so it can still emit write moves).
  if (prefs.write_mode === "off") {
    return { type: "reply", text: "Change proposals are turned off for this chat (see the toggles at the top). Flip “Propose changes” back on and ask again." };
  }

  if (move.type === "create") {
    if (!move.entity_kind || !(await createPathFor(c, move.entity_kind))) {
      return { type: "reply", text: `I can't create "${move.entity_kind ?? "that"}" from chat yet.` };
    }
    return {
      type: "proposal",
      summary: move.summary ?? `Create a ${move.entity_kind}`,
      proposal: { kind: "create", entity_kind: move.entity_kind, fields: move.fields ?? {} },
    };
  }

  // build — design a whole workspace. The core-authoring design-workspace
  // engine runs ~150s (enable modules + build fields/wires + auto-repair), so
  // /build returns immediately with a "building" draft and we hand the draft
  // id back to the client to POLL (GET .../drafts/:id). Blocking here would
  // bust the chat request's own proxy timeout. The widget shows the preview +
  // a confirm once the draft finishes.
  if (move.type === "build") {
    if (!move.intent || !move.intent.trim()) {
      return { type: "reply", text: "Tell me what you'd like your workspace to do and I'll set it up." };
    }
    const br = await callApi(c, "POST", "/modules/core-authoring/build", {
      intent: move.intent.trim(),
      task: "design-workspace",
    });
    if (br.status === 409) {
      return { type: "reply", text: "Setting up a whole workspace needs AI enabled here: it isn't yet." };
    }
    const b = br.body as { draft_id?: string };
    if (!b.draft_id) {
      return { type: "reply", text: "I couldn't start the build just now. Give it another try in a moment." };
    }
    // building: true → the widget polls the draft, then renders preview + confirm.
    return {
      type: "build-proposal",
      building: true,
      draft_id: b.draft_id,
      summary: move.summary ?? "Designing your workspace…",
    };
  }

  // action — resolve the entity by name via search before proposing, unless the
  // action runs on the WORKSPACE, in which case there is no record to resolve.
  if (move.type === "action") {
    if (!move.action_id) {
      return { type: "reply", text: "I need a bit more to do that, which record exactly?" };
    }
    const args = (move.args && typeof move.args === "object" ? move.args : undefined) as
      | Record<string, unknown>
      | undefined;
    if (await isWorkspaceAction(c, move.action_id)) {
      return {
        type: "proposal",
        summary: move.summary ?? `Run ${move.action_id}`,
        proposal: {
          kind: "action",
          action_id: move.action_id,
          ...(args ? { args } : {}),
        },
      };
    }
    if (!move.entity_kind || !move.entity_query) {
      return { type: "reply", text: "I need a bit more to do that, which record exactly?" };
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
      return { type: "reply", text: `I couldn't find a ${move.entity_kind} matching "${move.entity_query}".` };
    }
    if (hits.length > 1) {
      const names = hits.slice(0, 6).map((h) => `“${h.title ?? h.id}”`).join(", ");
      return { type: "reply", text: `I found a few matching "${move.entity_query}": ${names}. Which one?` };
    }
    const hit = hits[0]!;
    return {
      type: "proposal",
      summary: move.summary ?? `Run ${move.action_id} on “${hit.title ?? hit.id}”`,
      proposal: {
        kind: "action",
        action_id: move.action_id,
        entity_kind: move.entity_kind,
        entity_id: hit.id,
        entity_label: hit.title ?? hit.id,
        ...(args ? { args } : {}),
      },
    };
  }

  return { type: "reply", text };
}

/** Answer a write outcome so BOTH contracts can read it.
 *
 *  These routes said `{ok:false,message:"…"}`; every client wrapper in the repo
 *  reads `error.message` first and falls back to the bare status. Grace
 *  confirmed a save that failed for a perfectly nameable reason and the panel
 *  showed "HTTP 400" - the sentence existed the whole time, one key away from
 *  where anybody was looking. Same class as lint:error-body-kept, one layer up:
 *  there the body was unreadable, here it was readable and in the wrong shape.
 */
function sendOutcome(res: Response, out: { ok: boolean; message: string }): void {
  res
    .status(out.ok ? 200 : 400)
    .json(out.ok ? out : { ...(out as object), error: { code: "write_failed", message: out.message } });
}

// AI-REACH: this module IS the assistant; its own configuration is not a thing it should reach into
chatRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = ChatBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const c = ctxOf(req);
    const orgId = tenantContext(req).org.id;

    // Tools give the model list_actions, so the rail can drop each action's
    // argument names and example phrasings — the half that only matters once
    // an action has been chosen. Measured over 33 utterances against 83 real
    // actions: identical accuracy to the full rail (31/33 both, missing the
    // same two), 30% smaller. Dropping the DESCRIPTIONS as well is a further
    // 68% smaller and loses 12 points, so descriptions stay.
    const promptPrefs = await chatPrefsOf(req).catch(() => DEFAULT_PREFS);
    let system: string;
    try {
      system = await buildSystemPrompt(c, promptPrefs.read_tools ? "brief" : "full");
    } catch {
      system = `You are Cobb, the helpful assistant inside the "${c.orgName}" Cobblr workspace. Introduce yourself as Cobb if asked.${c.userName ? ` You are talking to ${c.userName}.` : ""} Chat helpfully; reply with {"type":"reply","text":"..."}.`;
    }
    // Situational awareness: what screen is the user on right now?
    system += pageContextLine(parsed.data.context);
    system += selectionLine(parsed.data.selection);
    // What the free path would have done, if anything. Asked here rather than
    // sent by the client: the client's offer may be stale by now, and this is
    // the same match the offer strip uses.
    try {
      const hit = await matchCommand(
        tenantDb(req),
        String([...parsed.data.messages].reverse().find((m) => m.role === "user")?.content ?? ""),
        tenantContext(req).org.id,
        {
          wsApi: chatWorkspaceApi(c),
          ...(parsed.data.selection?.ids?.length ? { selectionIds: parsed.data.selection.ids } : {}),
        },
      );
      if (hit) {
        system += suggestionLine({
          template: hit.template,
          summary: hit.summary ?? `${hit.operations.length} changes`,
          operations: hit.operations.length,
        });
      }
    } catch {
      // A suggestion is a nicety; a turn must not fail for want of one.
    }

    // ── The turn ─────────────────────────────────────────────────────────
    // `?mode=turn` (the widget from now on): create a persisted turn, run the
    // loop DETACHED, and return the id at once. The widget subscribes to
    // /turns/:id/events and gets progress as it happens; a refresh or a second
    // tab subscribes to the same id. Anything else (older clients, tests, the
    // MCP server) gets the blocking response it always did.
    const asTurn = req.query.mode === "turn";
    if (!asTurn) {
      try {
        res.json(await runTurn(req, parsed, system, c, orgId));
      } catch (err) {
        const status = err instanceof TurnError ? err.status : 502;
        const msg = err instanceof Error ? err.message : String(err);
        if (status === 502) console.error(`[core-ai] chat failed: ${msg}`);
        res.status(status).json({ type: "error", error: { code: "no_ai", message: msg } });
      }
      return;
    }

    const userId = sessionUserId(req) ?? "";
    const tdb = tenantDb(req);
    const lastUser = [...parsed.data.messages].reverse().find((m) => m.role === "user");
    const turnId = await createTurn(tdb, userId, String(lastUser?.content ?? ""));
    res.status(202).json({ type: "turn", turn_id: turnId });
    // Opportunistic sweep, roughly one turn in fifty. Finished turns are kept a
    // day, and anything stranded "running" for an hour (a process died mid-turn)
    // is marked failed so a tab does not sit on it forever. A per-tenant timer
    // would need a pool per tenant held open; this needs nothing.
    if (Math.random() < 0.02) void sweepTurns(tdb).catch(() => {});

    // Detached. The request is answered; this continues on its own. Every
    // outcome - success, a refused provider, a thrown error - lands in the
    // turn row and its event log, so nothing about it depends on a socket.
    void (async () => {
      try {
        const result = await withDeadline(
          runTurn(
            req,
            parsed,
            system,
            c,
            orgId,
            async (ev) => {
              await emitTurnEvent(tdb, turnId, ev.kind, ev as unknown as Record<string, unknown>);
            },
            turnId,
          ),
          TURN_DEADLINE_MS,
          `this took longer than ${Math.round(TURN_DEADLINE_MS / 60000)} minutes, so I stopped waiting. Nothing was changed. If your AI is a local model or a bridge it may be busy or wedged; try again, or check Configuration → AI.`,
        );
        await finishTurn(tdb, turnId, { ok: true, result });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!(err instanceof TurnError) || err.status === 502) console.error(`[core-ai] chat failed: ${msg}`);
        // The raw provider text is in the log above and in the AI call log;
        // the person gets one sentence, never a JSON body.
        await finishTurn(tdb, turnId, { ok: false, error: humanizeProviderError(msg).message }).catch(() => {});
      }
    })();
  }),
);

/** A turn must never sit "running" forever.
 *
 *  The sweeper below fails turns stranded for an HOUR, which is the right
 *  backstop for a process that died mid-turn and the wrong one for a user
 *  watching a spinner: Cobb sat on "Thinking…" indefinitely when the provider
 *  accepted the connection and never answered (2026-08-19). pinnedFetch now
 *  bounds each model call, and this bounds the whole turn — including any wait
 *  that is not a model call at all — so the widget always gets an answer,
 *  even when the answer is that we gave up.
 *
 *  Well above a slow multi-round turn (each model call is capped at 120s) and
 *  well below the stranded-turn sweep. */
const TURN_DEADLINE_MS = 5 * 60_000;

function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    work.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TurnError(504, message)), ms);
    }),
  ]);
}

// ── Turns: the persisted-turn read side ─────────────────────────────────────
//
// GET /chat/turns/open          → the user's running turn, if any. What a tab
//                                 asks on open: "is something already going?"
// GET /chat/turns/:id           → the turn row (status, prompt, result).
// GET /chat/turns/:id/events    → SSE. Replays every event after ?after=N,
//                                 then follows live until done/error. A
//                                 reconnect passes the last seq it saw and
//                                 misses nothing. Falls back to plain JSON
//                                 (the same events array) if the client
//                                 sends Accept: application/json, so a
//                                 poller works where SSE cannot.
//
// A turn is private to the person who started it; every read checks the
// row's user_id against the session.

chatRouter.get(
  "/turns/open",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const me = sessionUserId(req) ?? "";
    const turn = await openTurnFor(tenantDb(req), me);
    res.json({ turn: turn ?? null });
  }),
);

// POST /chat/turns/open/steps   → record ONE step against my own open turn.
//
// The gap this fills: when the assistant is a personal connection reached over
// the MCP relay, the tool calls happen INSIDE the model's own turn, on the
// other side of one long request. The in-process agent loop narrates itself
// (thinking → tool → applied), but the relay narrated nothing, so a chat that
// created sixty locations over two minutes recorded exactly two events —
// `thinking`, then `done` — and the panel sat on "Thinking" the whole time
// while the work was visibly happening in the access log.
//
// Deliberately narrow. It writes to the caller's OWN open turn or nothing at
// all, and only step-shaped kinds: a caller cannot finish a turn, fail one, or
// put words in Cobb's mouth. The worst it can do is add a step to a panel its
// own user is looking at.
// POST /chat/writes            → apply ONE write from a relayed assistant, the
//                                 same way an in-app one is applied.
//
// The invariant one screen down says every chat write goes through
// performWrite → the change ledger, before-image captured, undo available. A
// relayed assistant broke it without anyone noticing: its tool calls go
// straight at the module's REST route, so sixty locations arrived in a
// workspace with ZERO ledger rows — no undo beside the answer, and no record
// of what was asked for, which is also what the workspace learns commands
// from. "Changes: auto is safe because everything is tracked" was not true
// for that connection.
//
// So the relay comes here instead. Consent is checked again on this side:
// the relay checks it too, but a rule that only holds because the caller
// remembered to check is not a rule.
//
// AI-REACH: exempt — the door an assistant's write comes THROUGH, not a
// capability it chooses; the tools it fronts are the reachable ones.
chatRouter.post(
  "/writes",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const body = z
      .object({ tool: z.string().min(1).max(60), args: z.record(z.unknown()).default({}) })
      .safeParse(req.body);
    if (!body.success) return badBody(res, body.error);

    const ws = writeRequestsOf({
      id: "relay",
      name: body.data.tool,
      args: body.data.args as Record<string, unknown>,
    });
    if (ws.length === 0) {
      res.status(400).json({
        error: { code: "not_a_write", message: `${body.data.tool} is not a record write` },
      });
      return;
    }

    const prefs = await chatPrefsOf(req);
    if (prefs.write_mode !== "auto") {
      res.status(403).json({
        error: {
          code: "writes_not_auto",
          message:
            'Changes are not set to apply automatically for this chat, and a relayed connection cannot show a confirmation. The user can switch "Changes" to Auto, or make this one in Cobblr directly.',
        },
      });
      return;
    }

    const db = tenantDb(req);
    const userId = sessionUserId(req) ?? "";
    // The turn gives the write its two halves of a worked example — the
    // sentence that asked for it, and the turn it belongs to — so a relayed
    // change teaches the workspace exactly as an in-app one does.
    const turn = await openTurnFor(db, userId);
    const opts = {
      auto: true,
      orgId: tenantContext(req).org.id,
      ...(turn?.prompt ? { prompt: turn.prompt } : {}),
      ...(turn?.id ? { turnId: turn.id } : {}),
    };
    const wsApi = chatWorkspaceApi(ctxOf(req));
    const out =
      ws.length > 1
        ? await performWrites(wsApi, db, userId, ws, opts)
        : await performWrite(wsApi, db, userId, ws[0]!, opts);
    // Carry the ledger handle onto the turn, because that is what the panel
    // builds an Undo out of. Without it the change is tracked and the person
    // watching still has no way to reach it.
    if (turn && out.ok) {
      const ids = "ledger_ids" in out ? out.ledger_ids : out.ledger_id ? [out.ledger_id] : [];
      await emitTurnEvent(db, turn.id, "applied", {
        name: body.data.tool,
        summary: out.message,
        ...(ids.length === 1 ? { ledger_id: ids[0] } : {}),
        // A bulk write is ONE thing the person asked for, so it is one card
        // with one Undo — which presses every handle it made.
        ...(ids.length > 1 ? { ledger_ids: ids, count: "count" in out ? out.count : ids.length } : {}),
        undoable: out.undoable === true,
      }).catch(() => {});
    }
    sendOutcome(res, out);
  }),
);

// AI-REACH: exempt — this is the assistant TELLING the panel what it is doing,
// not a capability for it to choose. It writes no workspace data; the whole of
// it is a progress line on the caller's own open turn.
chatRouter.post(
  "/turns/open/steps",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const body = z
      .object({
        kind: z.enum(["tool", "tool-result", "applied"]),
        name: z.string().trim().min(1).max(80),
        write: z.boolean().optional(),
        ok: z.boolean().optional(),
        summary: z.string().max(400).optional(),
        args: z.record(z.unknown()).optional(),
      })
      .safeParse(req.body);
    if (!body.success) return badBody(res, body.error);
    const db = tenantDb(req);
    const turn = await openTurnFor(db, sessionUserId(req) ?? "");
    // No open turn is the normal case for a connector used outside the chat
    // panel. Say so plainly rather than erroring: the caller is not at fault
    // and has nothing to fix.
    if (!turn) {
      res.json({ recorded: false });
      return;
    }
    const { kind, ...payload } = body.data;
    await emitTurnEvent(db, turn.id, kind, payload);
    res.json({ recorded: true });
  }),
);

chatRouter.get(
  "/turns/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const me = sessionUserId(req) ?? "";
    const turn = await readTurn(tenantDb(req), req.params.id!);
    if (!turn || turn.user_id !== me) {
      res.status(404).json({ error: { code: "not_found", message: "no such turn" } });
      return;
    }
    res.json({ turn });
  }),
);

chatRouter.get(
  "/turns/:id/events",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const me = sessionUserId(req) ?? "";
    const db = tenantDb(req);
    const turnId = req.params.id!;
    const turn = await readTurn(db, turnId);
    if (!turn || turn.user_id !== me) {
      res.status(404).json({ error: { code: "not_found", message: "no such turn" } });
      return;
    }
    const after = Math.max(0, parseInt(String(req.query.after ?? "0"), 10) || 0);
    const wantsJson = String(req.headers.accept ?? "").includes("application/json");

    if (wantsJson) {
      const events = await eventsAfter(db, turnId, after);
      res.json({ status: turn.status, events });
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");
    let last = after;
    const send = (ev: { seq: number; kind: string; payload: unknown }) => {
      if (ev.seq <= last) return; // replay + live can overlap by one; dedupe
      last = ev.seq;
      res.write(`id: ${ev.seq}\nevent: ${ev.kind}\ndata: ${JSON.stringify(ev.payload)}\n\n`);
    };

    // Subscribe FIRST, then replay: an event that lands between the two is
    // delivered by the subscription and deduped by seq, so nothing is lost.
    let closed = false;
    const unsub = subscribe(turnId, (ev) => {
      if (closed) return;
      send(ev);
      if (ev.kind === "done" || ev.kind === "error") end();
    });
    // SINGLE-PROCESS-SAFE: a keepalive on ONE open response in this process.
    const hb = setInterval(() => !closed && res.write(": ping\n\n"), 25000);
    // The listener map is per-process; if the loop runs elsewhere (a second
    // api replica) the live push never arrives, so also poll the log. Cheap,
    // and it is what makes this correct rather than merely fast.
    // finishTurn writes the row's status and the terminal EVENT as two separate
    // statements, and the event can even queue behind another one, so a turn
    // reads "done" for a window in which its done/error event does not exist
    // yet. Closing on the status alone ends the stream with no terminal event —
    // the one thing this stream promises — and a client left holding a
    // half-finished answer. So a terminal row only ARMS the close; the poll
    // below finishes it properly when the event lands, and the counter bounds
    // the wait so a terminal row whose event never materialises still ends.
    let terminalArmed = false;
    let armedTicks = 0;
    const ARMED_TICK_LIMIT = 8; // ~12s at the 1500ms poll
    // SINGLE-PROCESS-SAFE: reads this turn's events for the one caller holding
    // this stream open. It writes nothing; a second api streaming its own
    // caller's turn is the correct behaviour, not a duplicate.
    const poll = setInterval(async () => {
      if (closed) return;
      try {
        for (const ev of await eventsAfter(db, turnId, last)) {
          send(ev);
          if (ev.kind === "done" || ev.kind === "error") end();
        }
        if (!closed && terminalArmed && ++armedTicks >= ARMED_TICK_LIMIT) end();
        // A tab already attached to a turn whose process died would otherwise
        // sit here forever: no new events are coming, and nothing else on this
        // request re-reads the row. readTurn heals a stranded turn and emits
        // its ending, which the next tick above then delivers.
        if (!closed) await readTurn(db, turnId);
      } catch {
        /* next tick */
      }
    }, 1500);
    function end() {
      if (closed) return;
      closed = true;
      clearInterval(hb);
      clearInterval(poll);
      unsub();
      res.end();
    }
    req.on("close", end);

    for (const ev of await eventsAfter(db, turnId, after)) {
      send(ev);
      if (ev.kind === "done" || ev.kind === "error") {
        end();
        return;
      }
    }
    if (turn.status === "done" || turn.status === "failed") terminalArmed = true;
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

// AI-REACH: this module IS the assistant; its own configuration is not a thing it should reach into
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
        // What was asked for. Stored since the ledger learned to pair a write
        // with its message, and worth showing: "you asked for X" is the only
        // thing that makes a list of changes readable a week later.
        prompt: r.prompt,
        undoable: undoableOf(r, kinds),
      })),
    });
  }),
);

// AI-REACH: this module IS the assistant; its own configuration is not a thing it should reach into
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
    const out = await undoWrite(chatWorkspaceApi(c), tenantDb(req), userId, String(req.params.id), tenantContext(req).org.id);
    sendOutcome(res, out);
  }),
);

// ── POST /chat/undo-turn — put back everything ONE instruction did ──
//
// An instruction is the unit a person thinks in: "each rack should have Shelf 1
// through 5" is one thing they asked for, so it is one thing to take back. The
// changes it made are already grouped by the turn that made them, so the client
// names THAT, not the sixty ids it happens to have.
//
// Newest first, because a later change can depend on an earlier one still being
// there (a shelf inside a rack goes before the rack does). Failures do not stop
// the sweep: a partial undo is reported and can be pressed again — every step
// is idempotent by id.
//
// AI-REACH: exempt — putting a change back is a person's decision about the
// assistant's work, never the assistant's own move.
chatRouter.post(
  "/undo-turn/:turnId",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const userId = sessionUserId(req);
    if (!userId) {
      res.status(401).json({ error: { code: "no_session", message: "Sign in first." } });
      return;
    }
    const db = tenantDb(req);
    const rows = await db
      .selectFrom("core_ai_chat_writes")
      .select(["id"])
      .where("turn_id", "=", String(req.params.turnId))
      .where("undone_at", "is", null)
      .where("undo_of", "is", null)
      .orderBy("created_at", "desc")
      .execute();
    if (rows.length === 0) {
      res.json({ ok: false, undone: 0, total: 0, message: "Nothing left to put back." });
      return;
    }
    const wsApi = chatWorkspaceApi(ctxOf(req));
    const orgId = tenantContext(req).org.id;
    // Going through with the ones held back is a SECOND press, by a person who
    // has been told what is in the way — never the first one's fallback.
    const force = req.query.force === "1";
    let undone = 0;
    const held: Array<{ label: string; reason: string; detail?: string }> = [];
    for (const r of rows) {
      const out = await undoWrite(wsApi, db, userId, r.id, orgId, force);
      if (out.ok) undone++;
      else if (out.held && out.held !== "deleted-since") {
        held.push({
          label: out.label ?? "a record",
          reason: out.held,
          ...(out.detail ? { detail: out.detail } : {}),
        });
      }
    }
    const names = held.map((h) => h.label);
    res.json({
      ok: undone > 0,
      undone,
      total: rows.length,
      // What is still there, and why — the client turns this into an offer
      // rather than a dead end.
      held,
      can_force: held.length > 0,
      message:
        undone === rows.length
          ? `Put back all ${undone}.`
          : held.length > 0
            ? `Put back ${undone} of ${rows.length}. Left ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""} alone, because ${
                held[0]!.reason === "has-contents"
                  ? names.length === 1
                    ? "there are still things inside it"
                    : "there are still things inside them"
                  : names.length === 1
                    ? "you have changed it since"
                    : "you have changed them since"
              }.`
            : `Put back ${undone} of ${rows.length}.`,
    });
  }),
);

// ── POST /chat/execute — run a confirmed proposal ──
const ExecBody = z.object({
  // What the user asked, so a CONFIRMED write is a worked example too. The
  // widget knows it; the server cannot, because a proposal arrives on its own
  // request. Optional, and only ever used as a label on the ledger row.
  prompt: z.string().max(2000).optional(),
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
      // Optional: a workspace-scoped action runs on the workspace, not a
      // record. Requiring them here rejected the proposal at the confirm step.
      entity_kind: z.string().optional(),
      entity_id: z.string().optional(),
      args: z.record(z.unknown()).optional(),
    }),
    z.object({ kind: z.literal("build"), draft_id: z.string() }),
  ]),
});

// AI-REACH: this module IS the assistant; its own configuration is not a thing it should reach into
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
        { auto: false, orgId: tenantContext(req).org.id, ...(parsed.data.prompt ? { prompt: parsed.data.prompt } : {}) },
      );
      sendOutcome(res, out);
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
      { tool: "action", entity_kind: p.entity_kind ?? "", entity_id: p.entity_id, action_id: p.action_id, args: p.args },
      { auto: false, ...(parsed.data.prompt ? { prompt: parsed.data.prompt } : {}) },
    );
    sendOutcome(res, out);
  }),
);
