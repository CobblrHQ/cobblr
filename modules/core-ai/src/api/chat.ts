// Agentic chat — Cobb can READ the workspace and PROPOSE writes, in a real
// tool-calling loop (agent-loop.ts): read tools (search/list/get/kinds/
// actions) auto-run under the caller's own permissions and feed back into the
// model; WRITE tools stop the loop and come back as PROPOSALS the user
// confirms via POST /chat/execute — writes NEVER run inside the loop. The
// tools come from the SHARED registry (@cobblr/workspace-tools — the exact
// set the MCP server exposes), so the two AI surfaces stay capability-
// identical. Providers without tool support (e.g. a bridge target that
// ignores the field) degrade to the legacy one-JSON-move protocol below.

import { humanOnlyRefusal } from "@cobblr/platform-contract/human-only";
import { Router, type Response } from "express";
import { humanizeProviderError, type ProviderFailureDetail } from "./provider-error.js";
import { providerReasonOf } from "@cobblr/platform-contract/provider-reason";
import { missingActionArgs, reconcileActionArgs } from "./action-args-guard.js";
import { groundingNudgeFor } from "./groundless-answer.js";
import { destinationNotThere, movedNotCreated } from "./move-not-create.js";
import { outsideChoices } from "./field-choices.js";
import { noneFromOneList } from "./none-from-one-list.js";
import { answeredNotProposed } from "./answer-dont-propose.js";
import { askDontRank } from "./ask-dont-rank.js";
import { misreportedWrites } from "./reported-truthfully.js";
import { chatModelMenu, type ReportedModels, type RoutedConnection } from "./chat-model-menu.js";
import { describedInsteadOfActing } from "./act-dont-describe.js";
import { escortCoveredByAction, resolveActionId, ESCORT_COVERAGE } from "./act-dont-escort.js";
import { buildSystemPromptBlocks, situationalSuffix, type PromptWorkspace, type PromptOptions, type SystemPrompt } from "./system-prompt.js";
import { GROUNDING_RULES, PLAIN_ANSWER_RULES, TOOL_USE_RULES } from "./prompt-rules.js";
import { z } from "zod";
import { CHAT_HISTORY_MESSAGES, platform, type AiChainStep, countOf } from "@cobblr/platform-contract";
import { kindWordsFrom } from "@cobblr/platform-contract/kind-label";
import { matchCommand } from "./basics.js";
import { replyDespiteRefusal, withPlanCard } from "./plan-card.js";
import { withDeleteThisCard } from "./delete-this.js";
import { tenantContext, sessionUserId, sessionDisplayName, tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { chosenModel, storedModel } from "./model-follows.js";
import {
  WORKSPACE_TOOLS,
  WRITE_TOOLS,
  getTool,
  jsonSchemaOf,
  resolveCreatePath,
  resolveUpdatePath,
  resolveDeletePath,
  fetchKinds,
  workspaceLinks,
  type KindRec,
  type WorkspaceApi,
} from "@cobblr/workspace-tools";
import { actionToolCall } from "./action-tool-call.js";
import { runAgentLoop, type AgentLoopDeps, type AgentLoopOutcome, type AppliedWrite } from "./agent-loop.js";
import { recordsFromToolResult, withMentions, type ChatMention } from "./mentions.js";
import { createTurn, emitTurnEvent, finishTurn, readTurn, eventsAfter, openTurnFor, subscribe, sweepTurns } from "./turns.js";
import { answerOffer, claimOffer, offerAnsweredSentence, readConversation, readOffers, sweepOffers, withOffers, writeConversation } from "./offers.js";
import { recordRound } from "../providers/replay.js";
import { performWrite, performWrites, undoWrite, undoableOf, type WriteRequest, type WriteOutcome } from "./chat-ledger.js";
import type { ToolCall, ChatTurn } from "../providers/tool-wire.js";
import { summariseAction, type ActionCopy } from "./action-summary.js";
import { actionArgValues, writeValues } from "./write-values.js";
import { actionRunsUnconfirmed, type ActionConsent } from "@cobblr/platform-contract/action-consent";
import { moveInReply } from "./tool-shaped-move.js";
import { withArticle } from "@cobblr/platform-contract/plural";
import { asksForAChange, proposesSeriousChange } from "./plan-tier.js";
import type { PlanStepBefore } from "@cobblr/platform-contract";
import { WHOLE, cardsOf, planTitle, withCards, type Card } from "./one-plan.js";
import { forAPerson } from "./says-something.js";
import { insteadList, listMadeBy, mayPassOnRetry, missingList, orderWrites, personReason, retryAfter, saidWhatFailed, stepSaid } from "./failed-steps.js";
import { optionalUuid } from "@cobblr/platform-contract/optional-fields";

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
 *  auto-applying. Destructive record ops hold: a delete, including any
 *  bulk/multi delete. The reason, even in auto: untrusted workspace content
 *  (entity names/descriptions/scanned text pulled into Cobb's context) must
 *  never be able to steer an UNCONFIRMED delete. Creates and updates
 *  auto-apply. An action auto-applies exactly when its declaration says an AI
 *  may run it with no person confirming (`undoable`, the same rule the relay
 *  reads: actionRunsUnconfirmed in platform-contract), and holds otherwise,
 *  unknown included. Pure so the same decision the auto-write closure makes
 *  can be asserted directly, and so the relay and this door can be held to
 *  the same answer for every action. */
export function autoWriteMustHold(ws: WriteRequest[], action?: ActionConsent | null): boolean {
  const w = ws[0];
  if (!w) return true;
  if (w.tool === "action") return !actionRunsUnconfirmed(action);
  return ws.some((r) => r.tool === "delete");
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
    case "add_thing":
      // The kind is the intake's to decide; the ledger records the one it filed.
      return typeof a.name === "string" && a.name.trim() ? { tool: "create", via: "add_thing", entity_kind: "", args: a } : null;
    case "file_inbox_items":
      return Array.isArray(a.ids) && a.ids.length && typeof a.list === "string" && a.list.trim()
        ? { tool: "create", via: "file_inbox", entity_kind: "", args: { ids: a.ids, list: a.list } }
        : null;
    case "put_back_scan_item":
      return typeof a.id === "string" && a.id.trim()
        ? { tool: "update", via: "put_back_scan", entity_kind: "", args: { id: a.id, ...(typeof a.revision === "string" && a.revision ? { revision: a.revision } : {}) } }
        : null;
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
function appliedSummaries(applied: AppliedWrite[]): Array<{
  summary: string;
  ledger_id?: string;
  undoable?: boolean;
  entity?: WriteOutcome["entity"];
  touched?: WriteOutcome["touched"];
  destination?: WriteOutcome["destination"];
}> {
  return applied.map((a) => {
    const r = a.result as WriteOutcome;
    return {
      summary: r?.message ?? a.call.name,
      ledger_id: r?.ledger_id,
      undoable: r?.undoable,
      // Which record, and what it is called: the panel draws the name as a
      // chip that opens it (web/src/lib/entity-chips.ts).
      ...(r?.entity?.id && r.entity.label ? { entity: r.entity } : {}),
      ...(r?.touched?.length ? { touched: r.touched } : {}),
      ...(r?.destination ? { destination: r.destination } : {}),
    };
  });
}

export const chatRouter = Router({ mergeParams: true });
export { resolveCreatePath, type KindRec };

// A tool whose consent the server's service gate decides is not proposed as
// a card first: the job waits on its own card when it needs a person, and a
// proposal before it would ask twice (services.md section 11).
const WRITE_NAMES = new Set(WRITE_TOOLS.filter((t) => !t.consentBy).map((t) => t.name));

/** The registry's transport seam, bound to this request's workspace + auth —
 *  read tools run with exactly the caller's permissions. */
export function chatWorkspaceApi(c: Ctx): WorkspaceApi {
  return {
    // The chat is read in the app, on this origin: same-origin paths open.
    link: workspaceLinks({ apiBase: "/api/v1", appOrigin: "" }, c.slug),
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
  /** The model pill: which AI answers THIS person's chat. All null = whatever
   *  the workspace would have used. See chat-model-menu.ts. */
  provider_id?: string | null;
  model?: string | null;
  credential_id?: string | null;
}
const DEFAULT_PREFS: ChatToolPrefs = { read_tools: true, write_mode: "ask" };

function asWriteMode(v: unknown): WriteMode {
  return v === "off" || v === "auto" ? v : "ask";
}

async function chatPrefsOf(req: Parameters<typeof tenantDb>[0]): Promise<ChatToolPrefs> {
  try {
    const row = await tenantDb(req)
      .selectFrom("core_ai_chat_prefs")
      .select(["read_tools", "write_mode", "provider_id", "model", "credential_id", "model_follows"])
      .where("user_id", "=", sessionUserId(req) ?? "")
      .executeTakeFirst();
    if (!row) return DEFAULT_PREFS;
    // The model fields ride along only when a choice exists. A caller that
    // never chose sees exactly the two-field shape it always did, and "never
    // chose" and "went back to the default" are the same state, which they are.
    const pick =
      row.model && (row.provider_id || row.credential_id)
        ? {
            provider_id: (row.provider_id as string | null) ?? null,
            // A family's latest, when that was picked (model-follows.ts).
            model: (row.model_follows as string | null) ?? (row.model as string),
            credential_id: (row.credential_id as string | null) ?? null,
          }
        : {};
    return { read_tools: !!row.read_tools, write_mode: asWriteMode(row.write_mode), ...pick };
  } catch {
    return DEFAULT_PREFS; // fail-open to defaults, never break the chat
  }
}

/** Neutral tool defs for the providers, FILTERED by the user's consent. Write
 *  tool descriptions match the mode (propose vs apply-with-undo). Read off +
 *  write off → [] → no tools sent, pure conversation. Exported for tests. */
export function toolDefsFor(
  prefs: ChatToolPrefs,
  opts: { services?: boolean; "scan-stations"?: boolean; modules?: ReadonlySet<string> | null } = {},
): Array<{ name: string; description: string; parameters: unknown }> {
  return WORKSPACE_TOOLS.filter((t) => !t.sentWhen || !!opts[t.sentWhen])
    // A module's tools only where the module is on. Not knowing which are on
    // (the read failed) sends them all: a tool too many costs characters, a
    // tool hidden costs the person the answer.
    .filter((t) => !t.module || !opts.modules || opts.modules.has(t.module))
    // A part's tools only where the part is on: the module list names it `<module>/<part>`.
    .filter((t) => !t.part || !t.module || !opts.modules || opts.modules.has(`${t.module}/${t.part}`))
    .filter((t) => (t.consentBy ? true : t.mode === "read" ? prefs.read_tools : prefs.write_mode !== "off"))
    .map(
    (t) => ({
      name: t.name,
      description:
        t.mode === "write" && !t.consentBy
          ? prefs.write_mode === "auto"
            ? t.name === "invoke_action"
              ? `${t.description} (An action whose list_actions entry says undoable: true is applied immediately, tracked and undoable. Any other action PROPOSES the change and the user confirms before it runs.)`
              : `${t.description} (Applied immediately. Every change is tracked and undoable.)`
            : `${t.description} (This PROPOSES the change. The user confirms before anything runs.)`
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
  /** Says which client is calling: "cobb" on the calls that start service
   *  jobs, so the api stamps them as Cobb's door. */
  client?: "cobb";
  /** "assistant" on Cobb's READ tools: the api then lets the person's own
   *  assistant see what the person wrote for themselves (a part's notes,
   *  #4798). Only ever more of what the person can already read. */
  reader?: "assistant";
}
export function ctxOf(req: Parameters<typeof tenantContext>[0]): Ctx {
  const org = tenantContext(req).org;
  return {
    slug: org.slug,
    orgName: org.name,
    auth: req.headers.authorization ?? "",
    base: "/api/v1",
    userName: sessionDisplayName(req),
  };
}

/** The prompt builder reads the workspace through the caller's own client. */
function promptWorkspace(c: Ctx): PromptWorkspace {
  return { orgName: c.orgName, userName: c.userName, get: (path) => callApi(c, "GET", path) };
}

async function callApi(
  c: Ctx,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  let r: Awaited<ReturnType<typeof fetch>>;
  try {
    r = await platform().selfFetch(`${c.base}/orgs/${c.slug}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: c.auth, ...(c.client ? { "x-cobblr-client": c.client } : {}), ...(c.reader ? { "x-cobblr-reader": c.reader } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    // The assistant's call to the api it runs in failed before any answer.
    // fetch says only "fetch failed"; the reason is in its cause (a closed or
    // refused connection, a timeout). Said here, in the log and the error, so
    // an intermittent one names itself (#4901: a plan section's run failed
    // with a bare "fetch failed" and nothing kept why).
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const why = cause?.code ?? cause?.message ?? (err as Error).message;
    console.error(`[core-ai] the call to the api itself failed: ${method} ${path}: ${why}`);
    throw new Error(`The assistant could not reach this Cobblr to ${method === "GET" ? "read" : "make the change"} (${why}). Try again.`, { cause: err });
  }
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



/** Every action's user-facing name, memoised beside the arg schemas. */
async function actionLabels(c: Ctx): Promise<string[]> {
  const hit = argsSchemaCache.get(c.slug);
  if (!hit || Date.now() - hit.at > 60_000) await actionArgsSchema(c, "");
  return argsSchemaCache.get(c.slug)?.labels ?? [];
}

/** An action's declared arguments, from the registry, memoised per workspace
 *  for a minute: the guard above asks once per invoke, not once per turn. */
const argsSchemaCache = new Map<
  string,
  { at: number; byId: Map<string, Record<string, { label?: string; type?: string }>>; labels: string[] }
>();
/** Every action id this workspace has, memoised beside the arg schemas. */
/** The registry with the inverse-only actions it hides by default, for the
 *  one reader that needs to know they exist: the refusal below. */
async function actionsIncludingInternal(c: Ctx): Promise<Array<{ id: string; internal?: boolean; label?: string | null }>> {
  try {
    const reg = await callApi(c, "GET", "/registered-actions?include_internal=1");
    return (reg.body.items as Array<{ id: string; internal?: boolean; label?: string | null }> | undefined) ?? [];
  } catch {
    return [];
  }
}

/** Why the model may not call this action, or null. An action that exists
 *  only as the way back for another (declared `internal`) is run by Undo on
 *  a card and by nothing else; a model that names one gets the sentence
 *  rather than a card with guessed arguments. */
export function internalActionRefusal(
  actionId: string,
  registry: ReadonlyArray<{ id: string; internal?: boolean; label?: string | null }>,
): string | null {
  const hit = registry.find((a) => a.id === actionId);
  if (!hit?.internal) return null;
  return (
    `${actionId}${hit.label ? ` ("${hit.label}")` : ""} is the way back for another action: it runs only when the user ` +
    `presses Undo on a card, never on request. If the user wants a change undone, tell them the card has an Undo; ` +
    `do not call this.`
  );
}

async function actionIds(c: Ctx): Promise<string[] | null> {
  const hit = argsSchemaCache.get(c.slug);
  if (!hit || Date.now() - hit.at > 60_000) {
    await actionArgsSchema(c, "");
  }
  const now = argsSchemaCache.get(c.slug);
  return now ? [...now.byId.keys()] : null;
}

async function actionArgsSchema(c: Ctx, actionId: string): Promise<Record<string, { label?: string; type?: string }> | null> {
  const hit = argsSchemaCache.get(c.slug);
  if (!hit || Date.now() - hit.at > 60_000) {
    try {
      const reg = await callApi(c, "GET", "/registered-actions");
      const items =
        (reg.body.items as
          | Array<{ id: string; label?: string; args_schema?: Record<string, { label?: string; type?: string }> | null }>
          | undefined) ?? [];
      argsSchemaCache.set(c.slug, {
        at: Date.now(),
        byId: new Map(items.map((a) => [a.id, a.args_schema ?? {}])),
        // The user-facing names, for the act-don't-describe guard: a reply
        // that names one of these found the action and wrote about it.
        labels: items.map((a) => a.label ?? "").filter(Boolean),
      });
    } catch {
      return null;
    }
  }
  return argsSchemaCache.get(c.slug)?.byId.get(actionId) ?? null;
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
async function actionPlan(
  c: Ctx,
  actionId: string,
  args: Record<string, unknown>,
  on: { kind: string; id: string } | null,
  before: PlanStepBefore[] = [],
): Promise<{ plan: { title: string; lines: string[] } } | { error: string } | null> {
  try {
    const r = await callApi(c, "POST", "/actions/plan", {
      actionId,
      args,
      ...(on ? { entityKind: on.kind, entityId: on.id } : {}),
      ...(before.length ? { before } : {}),
    });
    // The planner's reason is the model's correction. It reaches the model
    // through validateWrite, and if the model still cannot plan it, the person
    // reads the reason instead of a card that names only the action.
    if (typeof r.body.error === "string" && r.body.error) return { error: r.body.error };
    const plan = r.body.plan as { title?: unknown; lines?: unknown } | null | undefined;
    if (!plan || typeof plan.title !== "string" || !Array.isArray(plan.lines)) return null;
    return { plan: { title: plan.title, lines: plan.lines.filter((l): l is string => typeof l === "string") } };
  } catch {
    return null;
  }
}

/** Whether an action may run with no person confirming, from the registry:
 *  the same `undoable` the relay reads for the same question. Unknown reads
 *  as null, which holds. */
async function actionSafety(c: Ctx, actionId: string): Promise<ActionConsent | null> {
  try {
    const reg = await callApi(c, "GET", "/registered-actions");
    const items = (reg.body.items as Array<{ id: string; undoable?: boolean; effect?: string | null }> | undefined) ?? [];
    const hit = items.find((a) => a.id === actionId);
    return hit ? { undoable: hit.undoable === true, effect: hit.effect ?? null } : null;
  } catch {
    return null;
  }
}

async function isWorkspaceAction(c: Ctx, actionId: string): Promise<boolean> {
  try {
    const reg = await callApi(c, "GET", "/registered-actions");
    const items = (reg.body.items as Array<{ id: string; scope?: string }> | undefined) ?? [];
    return items.find((a) => a.id === actionId)?.scope === "workspace";
  } catch {
    return false; // unknown → treat as record-scoped, the stricter path
  }
}

/** Whether an action can be proposed with no record: a workspace action, or
 *  an entity action whose manifest says `recordOptional` ("put milk on the
 *  shopping list", #3255). The invoke door reads the same flag. */
async function runsWithoutARecord(c: Ctx, actionId: string): Promise<boolean> {
  try {
    const reg = await callApi(c, "GET", "/registered-actions");
    const items = (reg.body.items as Array<{ id: string; scope?: string; record_optional?: boolean }> | undefined) ?? [];
    const a = items.find((x) => x.id === actionId);
    return a?.scope === "workspace" || a?.record_optional === true;
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

/** The changes one message asks for, as one card (one-plan.ts says why).
 *  Each action step is planned again after the steps before it, so its words
 *  count what they leave; each step says whether it can be undone, from what
 *  its action declares. "As a whole" puts the records in a bundle's removal. */
async function asOnePlan(c: Ctx, result: unknown, asked: string): Promise<unknown> {
  if (!result || typeof result !== "object") return result;
  const r = result as Record<string, unknown>;
  const cards = cardsOf(r);
  if (cards.length === 0) return result;
  const whole = WHOLE.test(asked);
  let changed = false;
  const before: PlanStepBefore[] = [];
  const steps: Array<Card & { undoable: boolean | null }> = [];
  for (const card of cards) {
    let { summary, proposal } = card;
    if (proposal.kind === "action" && typeof proposal.action_id === "string") {
      const args = { ...((proposal.args as Record<string, unknown> | undefined) ?? {}) };
      const rewhole = whole && proposal.action_id === "platform:remove-bundle" && args.delete_records === undefined;
      if (rewhole) args.delete_records = true;
      if (rewhole || before.length) {
        const on = typeof proposal.entity_kind === "string" && typeof proposal.entity_id === "string" ? { kind: proposal.entity_kind, id: proposal.entity_id } : null;
        const planned = await actionPlan(c, proposal.action_id, args, on, before);
        if (planned && "plan" in planned) {
          proposal = { ...proposal, args, plan: planned.plan };
          summary = planned.plan.title;
          changed = true;
        }
      }
    }
    const undoable =
      proposal.kind === "action" && typeof proposal.action_id === "string"
        ? ((await actionCopy(c, proposal.action_id))?.undoable ?? null)
        : proposal.kind === "build"
          ? false
          : true;
    // A step says once whether it comes back: "(permanent)" beside "Can be
    // undone" was the card arguing with itself.
    if (undoable === true) summary = summary.replace(/\s*\(permanent\)\s*$/i, "");
    steps.push({ summary, proposal, undoable });
    if (proposal.kind === "delete" && typeof proposal.entity_kind === "string" && typeof proposal.entity_id === "string") {
      before.push({ op: "delete", kind: proposal.entity_kind, id: proposal.entity_id });
    }
  }
  if (steps.length === 1) return changed ? withCards(r, [{ summary: steps[0]!.summary, proposal: steps[0]!.proposal }]) : result;
  const title = planTitle(steps.map((x) => x.summary));
  return withCards(r, [{ summary: title, proposal: { kind: "plan", title, steps } }]);
}

/** Turn one WRITE tool call into a user-facing proposal — or an honest error
 *  when the call couldn't succeed on confirm (undeclared kind, missing args). */
async function proposalOf(
  c: Ctx,
  wsApi: WorkspaceApi,
  kinds: KindRec[],
  call: ToolCall,
  /** The person's own words, to tell a value they gave from one Cobb chose. */
  said = "",
): Promise<{ summary: string; proposal: Record<string, unknown> } | { error: string }> {
  const a = call.args ?? {};
  const titleOf = async (k: string, id: string): Promise<string | null> => {
    const t = await labelOf(wsApi, k, id);
    return t && t !== id ? t : null;
  };
  const kind = typeof a.kind === "string" ? a.kind : typeof a.entity_kind === "string" ? a.entity_kind : "";
  switch (call.name) {
    case "create_record": {
      if (!kind || !resolveCreatePath(kind, kinds)) return { error: `I can't create "${kind || "that"}" from chat yet.` };
      const fields = (a.fields as Record<string, unknown>) ?? {};
      const name = String(fields.title ?? fields.name ?? "").trim();
      // The card's line is what the person confirms: "Create a location:
      // “Bin 4”", never the kind id (#3237).
      const words = kindWordsFrom(kind, kinds);
      // Every value it will set, on the card (#3658): the room, the count, the
      // price, and the one Cobb chose himself, marked as his.
      const values = await writeValues({ kind, kinds, fields, said, titleOf });
      return {
        summary: `Create ${/^[aeiou]/i.test(words.one) ? "an" : "a"} ${words.one}${name ? `: “${name}”` : ""}`,
        proposal: { kind: "create", entity_kind: kind, fields, ...(values.length ? { values } : {}) },
      };
    }
    case "file_inbox_items": {
      const ids = Array.isArray(a.ids) ? a.ids.map(String).filter(Boolean) : [];
      const list = String(a.list ?? "").trim();
      if (!ids.length) return { error: "Which inbox items? Tick them, or name them." };
      if (!list) return { error: "Which list should they go into?" };
      // The list as the app names it, when it exists already; a list made by
      // an earlier step of the same plan is named the way it was asked for.
      const lists = ((await callApi(c, "GET", "/instances").catch(() => ({ body: {} }))).body as { items?: Array<{ instance_name: string; display_name?: string | null }> }).items ?? [];
      const hit = lists.find((l) => l.instance_name === list.toLowerCase() || (l.display_name ?? "").toLowerCase() === list.toLowerCase());
      const label = hit?.display_name ?? (list.length > 1 ? list[0]!.toUpperCase() + list.slice(1) : list);
      const names: string[] = [];
      for (const id of ids.slice(0, 50)) {
        const r = await getTool("get_scan_item")?.execute(wsApi, { id }).catch(() => null);
        const d = r?.ok ? (r.data as { name?: string; suggested_name?: string } | undefined) : undefined;
        names.push(d?.name ?? d?.suggested_name ?? "an inbox item");
      }
      if (ids.length > 50) names.push(`and ${ids.length - 50} more`);
      return {
        summary: `File ${ids.length === 1 ? "1 inbox item" : `${ids.length} inbox items`} into ${label}`,
        proposal: { kind: "file", ids, list, list_label: label, lines: names },
      };
    }
    case "put_back_scan_item": {
      const id = String(a.id ?? "").trim();
      if (!id) return { error: "Which inbox item? Name it, or open it." };
      const r = await getTool("get_scan_item")?.execute(wsApi, { id }).catch(() => null);
      const d = r?.ok ? (r.data as { name?: string; history_words?: Array<{ said: string; revision?: string }> } | undefined) : undefined;
      const revision = typeof a.revision === "string" && a.revision ? a.revision : undefined;
      const step = d?.history_words?.find((h) => (revision ? h.revision === revision : !!h.revision));
      return {
        summary: `Put back ${d?.name ? `“${d.name}”` : "this inbox item"} as it was before: ${step?.said ?? "its last change"}`,
        proposal: { kind: "put_back", id, ...(revision ? { revision } : {}), ...(d?.name ? { label: d.name } : {}) },
      };
    }
    case "add_thing": {
      const name = String(a.name ?? "").trim();
      if (!name) return { error: "I need to know what the thing is called." };
      return {
        summary: `Add “${name}” through the scan inbox${a.file === true ? " and file it" : ""}`,
        proposal: { kind: "add", args: a },
      };
    }
    case "update_record": {
      const id = String(a.id ?? "");
      if (!kind || !id || !resolveUpdatePath(kind, id, kinds)) {
        return { error: `Records of "${kind || "that"}" can't be updated from chat yet.` };
      }
      const fields = (a.fields as Record<string, unknown>) ?? {};
      const label = await labelOf(wsApi, kind, id);
      // What each field is now and what it will be, in the form's words.
      const now = await getTool("get_record")!.execute(wsApi, { kind, id }).catch(() => null);
      const current = now?.ok ? ((now.data as { fields?: Record<string, unknown> }).fields ?? null) : null;
      const values = await writeValues({ kind, kinds, fields, said, titleOf, current, update: true });
      return {
        summary: `Update “${label}”${values.length ? `: ${values.map((v) => v.label).join(", ")}` : ""}`,
        proposal: { kind: "update", entity_kind: kind, entity_id: id, fields, entity_label: label, ...(values.length ? { values } : {}) },
      };
    }
    case "delete_record": {
      const id = String(a.id ?? "");
      if (!kind || !id || !resolveDeletePath(kind, id, kinds)) {
        return { error: `Records of "${kind || "that"}" can't be deleted from chat yet.` };
      }
      const label = await labelOf(wsApi, kind, id);
      return {
        summary: `Delete “${label}” (permanent)`,
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
      // What it WILL touch, from the action's own planner: the card says the
      // change ("Move 5 records from Pantry into Tea") and lists every record,
      // never only the action's name. An action with no planner keeps the
      // sentence summariseAction makes from its label and arguments.
      const planned = await actionPlan(c, actionId, argValues, kind && id ? { kind, id } : null);
      // The planner could not: say why, and show no card. This is the last
      // door, after validateWrite has already handed the model the same
      // reason; a card here would be the bare label the rule forbids.
      if (planned && "error" in planned) return { error: planned.error };
      const plan = planned?.plan ?? null;
      // No planner: the card still lists what the action was handed, in the
      // action's own labels (#3658), never its name alone.
      const argLines = plan ? [] : await actionArgValues({ args: argValues, schema: copy?.args_schema ?? null, said, titleOf });
      const values = argLines.length ? { values: argLines } : {};
      if (!kind || !id) {
        if (!(await runsWithoutARecord(c, actionId))) {
          return { error: "I need the action and the exact record to run it on." };
        }
        return {
          summary: plan?.title ?? summariseAction(actionId, copy, argValues),
          proposal: { kind: "action", action_id: actionId, ...args, ...(plan ? { plan } : {}), ...values },
        };
      }
      const label = await labelOf(wsApi, kind, id);
      return {
        summary: plan?.title ?? summariseAction(actionId, copy, argValues, label),
        proposal: {
          kind: "action",
          action_id: actionId,
          entity_kind: kind,
          entity_id: id,
          entity_label: label,
          ...args,
          ...(plan ? { plan } : {}),
          ...values,
        },
      };
    }
    default:
      return { error: `I tried an operation I don't actually have (“${call.name}”).` };
  }
}

// No `type`, but it may still plainly BE a call: some models answer a request
// to act by writing out the tool's own arguments in a fenced block instead of
// calling it (granite3.3, command-r7b — measured 2026-08-25, both scoring 1/8
// for this reason alone). They wrote the right thing; nobody was reading it.
// The bench reads replies through the same function (tool-shaped-move.ts).
function parseMove(raw: string): Move | null {
  return moveInReply(raw) as Move | null;
}

const ChatBody = z.object({
  // The newest part of the conversation is what is read; a client that
  // sends more than that is trimmed, never refused. Refusing it was a red
  // "Bad request body" on every send once a conversation passed forty
  // messages (#3087).
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() }))
    .min(1)
    .transform((m) => m.slice(-CHAT_HISTORY_MESSAGES)),
  // What the user is looking at right now (route + a one-line view summary the
  // page publishes). BOUNDED so a client can't stuff the prompt. See
  // web/src/lib/chat-context.ts.
  context: z
    .object({ label: z.string().min(1).max(120), summary: z.string().max(600).optional(), kind: z.string().max(120).optional() })
    .optional(),
  // What the user is POINTING AT: rows they ticked, or a highlight. Bounded the
  // same way as the context above — a client cannot stuff the prompt.
  selection: z
    .object({
      label: z.string().min(1).max(200),
      kind: z.string().max(120).optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
      ids: z.array(z.string().max(64)).max(200).optional(),
      text: z.string().max(2000).optional(), // none-refused-ok: it fills the prompt's typed selection, which takes text or nothing
    })
    .optional(),
});


/** Everything a chat turn does after the request is validated: run the
 *  agent loop, turn the outcome into the response the widget renders.
 *  Extracted so the SAME code serves the legacy blocking POST and the
 *  persisted-turn path; a `res.json` in here would tie it to one. */
class TurnError extends Error {
  constructor(public status: number, message: string, public detail?: ProviderFailureDetail) { super(message); }
}

/** What a failed call carried beside its message (the router's refusal:
 *  provider-reason.ts), for the sentence a person reads. */
function failureDetailOf(err: unknown): ProviderFailureDetail | undefined {
  if (err instanceof TurnError) return err.detail;
  const e = err as { reason?: unknown; door?: unknown; retryAfterSec?: unknown; message?: string } | null;
  const reason = providerReasonOf(err);
  if (!reason) return undefined;
  const provider = String(e?.message ?? "").replace(/^core-ai invoke failed:\s*/i, "").match(/^([a-z0-9-]+):/i)?.[1];
  return {
    reason,
    ...(e?.door === "personal" || e?.door === "workspace" ? { door: e.door } : {}),
    ...(typeof e?.retryAfterSec === "number" ? { retryAfterSec: e.retryAfterSec } : {}),
    ...(provider ? { provider } : {}),
  };
}

async function runTurn(
  req: Parameters<typeof tenantDb>[0],
  parsed: { data: z.infer<typeof ChatBody> },
  system: SystemPrompt | string,
  c: Ctx,
  orgId: string,
  onEvent?: AgentLoopDeps["onEvent"],
  /** The persisted turn this run belongs to, so a write can be traced back to
   *  the sentence that asked for it. Absent for the blocking (non-turn) path. */
  turnId?: string,
): Promise<Record<string, unknown>> {
  // Every record the turn's reads handed back. The answer goes out with the
  // ones its words name (`mentions`), so a read answer opens what it names
  // the way a write's card does. See mentions.ts.
  const reads: ChatMention[] = [];
  const out = await answerTurn(req, parsed, system, c, orgId, reads, onEvent, turnId);
  return withMentions(out, reads);
}

async function answerTurn(
  req: Parameters<typeof tenantDb>[0],
  parsed: { data: z.infer<typeof ChatBody> },
  system: SystemPrompt | string,
  c: Ctx,
  orgId: string,
  reads: ChatMention[],
  onEvent?: AgentLoopDeps["onEvent"],
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
  // The service tools go out only where a service capability is connected.
  const hasServices = await callApi(c, "GET", "/services/capabilities")
    .then((r) => r.status < 400 && Array.isArray(r.body.items) && r.body.items.length > 0)
    .catch(() => false);
  const hasStations = await callApi(c, "GET", "/scan-stations")
    .then((r) => r.status < 400 && Array.isArray(r.body.items) && r.body.items.length > 0)
    .catch(() => false);
  const enabledModules = await callApi(c, "GET", "/modules")
    .then((r) => (r.status < 400 && Array.isArray(r.body.items)
      ? new Set((r.body.items as Array<{ name?: string; enabled?: boolean; enabled_at?: string | null; parts?: Array<{ id: string; on: boolean }> }>).filter((m) => m.enabled === true || !!m.enabled_at).flatMap((m) => [String(m.name), ...(m.parts ?? []).filter((p) => p.on).map((p) => `${m.name}/${p.id}`)]))
      : null))
    .catch(() => null);
  const toolDefs = toolDefsFor(prefs, { services: hasServices, "scan-stations": hasStations, modules: enabledModules });
  // Service jobs are started on Cobb's door, not the person's: the header
  // makes the api stamp them as Cobb's, so they follow Cobb's consent.
  const cobbApi = chatWorkspaceApi({ ...c, client: "cobb" });
  const readApi = chatWorkspaceApi({ ...c, reader: "assistant" });
  const serviceJobs: Array<{ job_id: string; capability?: string; status?: string }> = [];
  // The consent + auto-mode sentences ride in the prompt the caller built
  // (system-prompt.ts consentLine): a prompt assembled in two places is one
  // that differs between callers, and lint:one-system-prompt says so.
  // AUTO mode: record creates and updates, and the actions declared safe to
  // run unconfirmed, apply immediately through the ledger (undoable); deletes
  // and every other action return null and are proposed. Hard cap per turn,
  // and every auto write counts against it, actions included.
  const AUTO_WRITE_CAP = 10;
  let autoWrites = 0;
  const userId = sessionUserId(req) ?? "";
  const ldb = tenantDb(req);
  // Escorts the loop's take_user_to calls produced this turn — the widget
  // navigates to each (and pages read the prefill params). Inert server-side.
  const escorts: Array<{ path: string; label: string }> = [];
  // Every search this turn ran and what came back, so a write aimed at one
  // of several look-alikes can be asked whether the person chose it
  // (ask-dont-rank.ts). When they did not, the turn carries the candidates
  // as taps; the reply below says so.
  const ambiguity = askDontRank(askedFor);
  // The kinds, read once per turn and only when a record write needs them.
  let kindsForWrites: Promise<KindRec[]> | null = null;
  const kindsOnce = () => (kindsForWrites ??= fetchKinds(wsApi).catch(() => [] as KindRec[]));
  const askModel = async (capability: "chat" | "plan-changes", turns: ChatTurn[]) => {
    // FREE-TEXT: a chat turn: the answer is Cobb's own words or a tool call
    const r = await platform().ai.invoke({
      orgId,
      capability,
      // The model pill: this person's choice for THEIR chat, when they
      // made one. A provider_id names a workspace connection, a
      // credential_id names a personal one routed here; null is the
      // workspace's default, which is the whole path below untouched.
      ...(prefs.credential_id ? { credential_id: prefs.credential_id } : {}),
      ...(prefs.provider_id && !prefs.credential_id ? { provider_id: prefs.provider_id } : {}),
      ...(prefs.model && (prefs.provider_id || prefs.credential_id) ? { model: prefs.model } : {}),
      // Show the answer being written. Only when somebody is listening to
      // this turn (the persisted-turn path); the blocking POST has nobody
      // to show it to.
      ...(onEvent ? { onDelta: (text: string) => void onEvent({ kind: "text-delta", text }) } : {}),
      // system rides as a first-class field (Anthropic drops a
      // "system"-role message); tools are the neutral defs every adapter
      // translates to its native dialect (tool-wire.ts).
      // `system_blocks` (fixed rules, this workspace, this moment) lets a
      // provider that caches by breakpoint keep the shared part warm (#5319).
      input: {
        system: typeof system === "string" ? system : system.text,
        ...(typeof system === "string" ? {} : { system_blocks: system.blocks }),
        messages: turns,
        ...(toolDefs.length ? { tools: toolDefs } : {}),
      },
      source: { kind: "core-ai:chat", id: orgId },
      userId: sessionUserId(req),
    });
    const calls = typeof r.result === "object" && r.result !== null ? (r.result as { tool_calls?: ToolCall[] }).tool_calls : undefined;
    const round = { content: r.text, tool_calls: calls };
    // Cassette recording (COBBLR_AI_REPLAY_RECORD): capture what a REAL
    // model said, per round, to build replay fixtures. No-op unless set,
    // and the provider id is what keeps a replay from recording itself.
    recordRound(turns, round, r.provider_id);
    const known = calls?.some((call) => call.name.includes(":")) ? (await actionIds(c)) ?? [] : [];
    return { ...round, tool_calls: calls?.map((call) => actionToolCall(call, known)) };
  };
  // The fuller model plans a change; the chat model answers the rest. A
  // message that asks for one starts there; a round that proposes one moves
  // the turn there (plan-tier.ts).
  let tier: "chat" | "plan-changes" = asksForAChange(askedFor) ? "plan-changes" : "chat";
  const actionIsSerious = async (actionId: string): Promise<boolean> => {
    const safety = await actionSafety(c, actionId);
    return !safety?.undoable || (await isWorkspaceAction(c, actionId));
  };
  let outcome: AgentLoopOutcome;
  try {
    outcome = await runAgentLoop(parsed.data.messages as ChatTurn[], {
      callModel: async (turns) => {
        // The chat model answers, unless this round plans a change: then the
        // fuller one does, asked again before anything is offered (plan-tier.ts).
        let round = await askModel(tier, turns);
        if (tier === "chat" && (await proposesSeriousChange(round.tool_calls, actionIsSerious))) {
          tier = "plan-changes";
          round = await askModel(tier, turns);
        }
        return round;
      },
      executeRead: async (name, args) => {
        const tool = getTool(name);
        if (tool?.consentBy === "service-gate") {
          const r = await tool.execute(cobbApi, args);
          const job = r.ok ? (r.data as { job_id?: string; capability?: string; status?: string } | null) : null;
          if (job?.job_id) serviceJobs.push({ job_id: job.job_id, capability: job.capability, status: job.status });
          return r;
        }
        if (!tool || tool.mode !== "read") return { ok: false, error: `no such read tool: ${name}` };
        // An escort to a screen whose job an action already does is the least
        // useful answer available, and saying so in the prompt was not enough:
        // "hide the manufacturer field on parts" still went to the Fields
        // screen. The destinations already declare which actions cover them.
        if (name === "take_user_to") {
          const dest = String((args as { destination?: unknown }).destination ?? "");
          const known = new Set((await actionIds(c)) ?? []);
          const bounce = known.size ? escortCoveredByAction(dest, ESCORT_COVERAGE[dest], known) : null;
          if (bounce) return { ok: false, error: bounce };
        }
        const result = await tool.execute(readApi, args);
        // What it read, kept: the reply is named by these and nothing else.
        for (const r of recordsFromToolResult(result)) reads.push(r);
        ambiguity.onRead(name, args, result);
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
      validateWrite: async (call, seenNames) => {
        // Asked how much of something there is and about to make one. A
        // question is answered, never proposed. See answer-dont-propose.ts.
        const asked = answeredNotProposed(askedFor, call);
        if (asked) return asked;
        // Asked to MOVE something and about to create a second copy of a
        // record it has just been shown. Caught here, before the write, so
        // nothing has to be undone. See move-not-create.ts.
        const dup = movedNotCreated(askedFor, call, seenNames);
        if (dup) return dup;
        // Asked to MOVE something into a place it did not find, and about to
        // create the place with nothing said. A missing destination is a
        // question, never a silent card (#3255). See move-not-create.ts.
        const gone = destinationNotThere(askedFor, call, seenNames);
        if (gone) return gone;
        // Aimed at one of several records a search returned, and the person's
        // words do not say which. Two CubePros, one label printed for the
        // first hit (#3154): the write is bounced with both named, and the
        // turn carries them as taps. See ask-dont-rank.ts.
        const ranked = ambiguity.validate(call);
        if (ranked) return ranked;
        // A value a field cannot take ("bin" for a location's kind) is handed
        // back with the values it can, before any card. See field-choices.ts.
        if (call.name === "create_record" || call.name === "update_record") {
          const off = outsideChoices(call, await kindsOnce());
          if (off) return off;
        }
        if (call.name !== "invoke_action") return null;
        const a = call.args ?? {};
        const typed = String(a.action_id ?? "");
        if (!typed) return null;
        // The way back for another action is not something to call.
        const internal = internalActionRefusal(typed, await actionsIncludingInternal(c));
        if (internal) return internal;
        // What only a person does (human-only.ts) gets no card at all, so
        // there is nothing to press on the assistant's say-so.
        const human = humanOnlyRefusal(typed, (a.args as Record<string, unknown> | undefined) ?? null);
        if (human) return human;
        // platform:group_fields for platform:group-fields: the model chose the
        // right action and typed the separator its own way. Correct it in
        // place rather than refusing the turn.
        const real = resolveActionId(typed, (await actionIds(c)) ?? []);
        if (real && real !== typed) {
          a.action_id = real;
          const humanReal = humanOnlyRefusal(real, (a.args as Record<string, unknown> | undefined) ?? null);
          if (humanReal) return humanReal;
        }
        const schema = await actionArgsSchema(c, real ?? typed);
        // Right action, right value, its own name for the argument
        // ({name: "shipments"} for {module}). Corrected in place, like the id
        // above - the user still confirms the proposal either way.
        const fixed = reconcileActionArgs(schema, a.args);
        if (fixed) a.args = fixed.args;
        const missing = missingActionArgs(real ?? typed, schema, a.args);
        if (missing) return missing;
        // The arguments are all there; can a plan be made from them? An action
        // that knows how to say what it will touch is asked now, before a
        // card exists, and its reason ("no list called tea", "pass ids not
        // names") goes back as the tool result so the model corrects itself.
        // The card that used to appear here said only "Move records into
        // another list" (2026-09-11), which is a card nobody can check.
        const argValues = (a.args && typeof a.args === "object" ? a.args : {}) as Record<string, unknown>;
        const on = a.entity_kind && a.entity_id ? { kind: String(a.entity_kind), id: String(a.entity_id) } : null;
        const planned = await actionPlan(c, real ?? typed, argValues, on);
        return planned && "error" in planned ? planned.error : null;
      },
      // Only where there is something to look WITH. A chat whose owner turned
      // workspace reading off has no read tools, and telling that model to
      // call one is telling it to do the thing they just forbade. A provider
      // with no tool-calling at all is the same story from the other side: it
      // answers by writing the JSON move the app parses into a proposal, and
      // there is no tool for it to reach for either.
      ...(prefs.read_tools && toolDefs.length > 0 ? { groundingNudge: groundingNudgeFor, absenceNudge: noneFromOneList } : {}),
      // The answer has to match the ledger: a turn that only created things
      // cannot say it moved them. See reported-truthfully.ts.
      reportCheck: (_said, reply, appliedTools) => misreportedWrites(reply, appliedTools),
      // A step that makes a list runs before one that names it, and a step
      // refused for a list not made yet runs again once it is (#5067).
      orderWrites,
      retryAfter,
      // The mirror: an instruction answered by naming the action instead of
      // running it. Needs a write tool to exist for the answer to be "run it".
      ...(prefs.write_mode !== "off" && toolDefs.length > 0
        ? {
            // The loop stands this down after any write was handed back
            // this turn (agent-loop.ts handedBack): the question a door
            // asked for is the act, not a description of one.
            actNudge: async (said: string, reply: string, reads: string[]) =>
              describedInsteadOfActing(said, reply, await actionLabels(c), reads.includes("list_actions")),
          }
        : {}),
      // A failed step's reason is shown to the person under the step: their
      // half of it, never the hint meant for the model (#5067).
      ...(onEvent
        ? {
            onEvent: (ev: Parameters<NonNullable<AgentLoopDeps["onEvent"]>>[0]) =>
              onEvent(ev.kind === "tool-result" && !ev.ok ? { ...ev, summary: personReason(ev.summary) } : ev),
          }
        : {}),
      ...(prefs.write_mode === "auto"
        ? {
            executeWrite: async (call: ToolCall) => {
              const ws = writeRequestsOf(call);
              const w = ws[0];
              // Destructive record ops (delete, incl. bulk/multi delete) and
              // any action not declared safe to run unconfirmed keep the
              // confirm gate even in auto mode; over-cap too. See
              // autoWriteMustHold. Creates/updates and undoable actions apply.
              const action = w?.tool === "action" && w.action_id ? await actionSafety(c, w.action_id) : null;
              if (!w || autoWriteMustHold(ws, action) || autoWrites >= AUTO_WRITE_CAP) return null;
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
    throw new TurnError(status, msg, failureDetailOf(err));
  }

  const done = appliedSummaries(outcome.applied);
  // Proposals offered after a step that did not happen say that step first.
  const failedFirst = outcome.failed?.length ? saidWhatFailed(outcome.failed, done.length) : null;

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
      const built = await proposalOf(c, wsApi, kinds, call, askedFor);
      if ("error" in built) problems.push(built.error);
      else items.push(built);
    }
    if (items.length === 0) {
      return {
        type: "reply",
        text: (problems.length ? forAPerson(problems.join(" "), kinds) : "") || failedFirst || outcome.text || "I couldn't line that up — can you rephrase?",
        ...(done.length ? { applied: done } : {}),
        ...(escorts.length ? { escorts } : {}), ...(serviceJobs.length ? { service_jobs: serviceJobs } : {}),
      };
    }
    if (items.length === 1) {
      return {
        type: "proposal",
        text: failedFirst ?? (outcome.text || undefined),
        summary: items[0]!.summary,
        proposal: items[0]!.proposal,
        ...(done.length ? { applied: done } : {}),
        ...(escorts.length ? { escorts } : {}), ...(serviceJobs.length ? { service_jobs: serviceJobs } : {}),
      };
    }
    return { type: "proposals", text: failedFirst ?? (outcome.text || undefined), items, ...(done.length ? { applied: done } : {}), ...(escorts.length ? { escorts } : {}), ...(serviceJobs.length ? { service_jobs: serviceJobs } : {}) };
  }

  // A write that did not happen is said as not done, in words built from the
  // step and its refusal, never in the model's sentence, which is the one
  // that claimed it (#5067). Each comes back with the proposal that retries
  // it, so the panel can offer Retry on the step itself.
  const unresolved = outcome.failed ?? [];
  if (unresolved.length) {
    const kinds = await fetchKinds(wsApi).catch(() => [] as KindRec[]);
    // The ways out a person can take, per step. A plain retry only when the
    // failure may pass by itself (a timeout, a busy service): "no list called
    // Cups" fails the same way every time, so it is offered somewhere else to
    // file, or the list made first and then filed into (#5067).
    const lists = ((await callApi(c, "GET", "/instances").catch(() => ({ body: {} }))).body as {
      items?: Array<{ display_name?: string | null; instance_name: string; module_name: string; is_scan_fallback?: boolean }>;
    }).items ?? [];
    const made = outcome.applied.map((a) => listMadeBy(a.call)).filter((x): x is string => !!x);
    const proposal = async (call: ToolCall) => {
      const built = await proposalOf(c, wsApi, kinds, call, askedFor).catch(() => ({ error: "" }));
      return "proposal" in built ? built : null;
    };
    const failed = await Promise.all(
      unresolved.map(async (f) => {
        const ways: Array<{ label: string; proposal: Record<string, unknown> }> = [];
        const missing = missingList(f);
        if (mayPassOnRetry(f.error)) {
          const again = await proposal(f.call);
          if (again) ways.push({ label: "Retry", proposal: again.proposal });
        } else if (missing) {
          const instead = insteadList(missing, made, lists.map((l) => l.display_name ?? l.instance_name));
          if (instead) {
            const there = await proposal({ ...f.call, args: { ...f.call.args, list: instead } });
            if (there) ways.push({ label: `File into ${instead} instead`, proposal: there.proposal });
          }
          // Kept like the list this turn made, else like where the inbox files
          // what it cannot place; with neither, no guess is offered.
          const like = lists.find((l) => (l.display_name ?? l.instance_name) === made.at(-1)) ?? lists.find((l) => l.is_scan_fallback);
          const makeIt = like ? await proposal({ id: `${f.call.id}-make`, name: "invoke_action", args: { action_id: "platform:create-instance", args: { module_name: like.module_name, display_name: missing } } }) : null;
          const fileIt = await proposal(f.call);
          if (makeIt && fileIt) {
            ways.push({
              label: `Create a list called ${missing}`,
              proposal: {
                kind: "plan",
                title: `Make the list ${missing}, then file into it`,
                steps: [
                  { summary: makeIt.summary, proposal: makeIt.proposal, undoable: true },
                  { summary: fileIt.summary, proposal: fileIt.proposal, undoable: true },
                ],
              },
            });
          }
        }
        return { step: stepSaid(f.call), error: personReason(f.error), ...(ways.length ? { ways } : {}) };
      }),
    );
    return {
      type: "reply",
      text: saidWhatFailed(unresolved, done.length),
      failed,
      ...(done.length ? { applied: done } : {}),
      ...(escorts.length ? { escorts } : {}), ...(serviceJobs.length ? { service_jobs: serviceJobs } : {}),
    };
  }

  const text = outcome.text;

  const move = parseMove(text);
  if (!move || move.type === "reply") {
    // The candidates a bounced write named ride as taps when the turn ended
    // in words (the question), never beside a proposal for something else.
    return {
      type: "reply",
      text: move?.text ?? text,
      ...(done.length ? { applied: done } : {}),
      ...(escorts.length ? { escorts } : {}), ...(serviceJobs.length ? { service_jobs: serviceJobs } : {}),
      ...(ambiguity.choices ? { choices: ambiguity.choices } : {}),
    };
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
      summary: move.summary ?? `Create ${withArticle(move.entity_kind)}`,
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
    // A workspace action has no record to resolve, and neither does a
    // record-optional one asked for with none named ("put milk on the
    // shopping list", #3255).
    if ((await isWorkspaceAction(c, move.action_id)) || (!move.entity_query && (await runsWithoutARecord(c, move.action_id)))) {
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
      return { type: "reply", text: `I couldn't find ${withArticle(move.entity_kind)} matching "${move.entity_query}".` };
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
function sendWriteOutcome(res: Response, out: { ok: boolean; message: string }): void {
  // A failed write's message is what the card says: a person's words, never a
  // tool's or a route's (#4574).
  if (!out.ok) out = { ...out, message: forAPerson(out.message) };
  res
    .status(out.ok ? 200 : 400)
    .json(out.ok ? out : { ...(out as object), error: { code: "write_failed", message: out.message } });
}

// AI-REACH: exempt — the chat door itself; the assistant calling it would be a
// turn inside its own turn
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
    // What the free path would have done with this sentence, if anything.
    // Asked before the prompt is built, so it can ride INSIDE it: this is the
    // same match the offer strip uses, and asking the client would use an
    // offer that may be stale by now. A suggestion is a nicety; a turn must
    // not fail for want of one.
    const asked = String([...parsed.data.messages].reverse().find((m) => m.role === "user")?.content ?? "");
    const hit = await matchCommand(tenantDb(req), asked, tenantContext(req).org.id, {
      wsApi: chatWorkspaceApi(c),
      ...(parsed.data.selection?.ids?.length ? { selectionIds: parsed.data.selection.ids } : {}),
      ...(parsed.data.context?.kind ? { pageKind: parsed.data.context.kind } : {}),
    }).catch(() => null);
    // The plan rides in the prompt so the model can narrate it, AND in the
    // reply as a card (withPlanCard) so it is offered whatever the model does.
    const suggestion = hit
      ? {
          template: hit.template,
          summary: hit.summary ?? `${countOf(hit.operations.length, "change")}`,
          operations: hit.operations.length,
          ...(hit.note ? { note: hit.note } : {}),
          ...(hit.leftHeading ? { leftHeading: hit.leftHeading } : {}),
          ...(hit.also?.length ? { also: hit.also } : {}),
        }
      : undefined;
    const situational: PromptOptions = {
      consent: promptPrefs,
      ...(parsed.data.context ? { context: parsed.data.context } : {}),
      ...(parsed.data.selection ? { selection: parsed.data.selection } : {}),
      ...(suggestion ? { suggestion } : {}),
    };
    let system: SystemPrompt | string;
    try {
      system = await buildSystemPromptBlocks(promptWorkspace(c), promptPrefs.read_tools ? "brief" : "full", situational);
    } catch {
      // The degraded prompt still says where the user is: situationalSuffix is
      // the one definition of those sentences.
      system =
        `You are Cobb, the helpful assistant inside the "${c.orgName}" Cobblr workspace. Introduce yourself as Cobb if asked.${c.userName ? ` You are talking to ${c.userName}.` : ""} Chat helpfully; reply with {"type":"reply","text":"..."}.` +
        situationalSuffix(situational);
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
        res.json(await withOffers(tenantDb(req), sessionUserId(req) ?? "", null, await asOnePlan(c, withDeleteThisCard(withPlanCard(await runTurn(req, parsed, system, c, orgId), hit, asked), asked, parsed.data.selection), asked)));
      } catch (err) {
        const status = err instanceof TurnError ? err.status : 502;
        const msg = err instanceof Error ? err.message : String(err);
        if (status === 502) console.error(`[core-ai] chat failed: ${msg}`);
        // The blocking route (older clients, tests, the MCP server) gets the
        // same one sentence the turn path gives a person, never a provider's
        // JSON body; the raw text is in the log above and the AI call log.
        const human = humanizeProviderError(msg, failureDetailOf(err));
        // A plan worked out before the model was asked does not need it: the
        // reply is the refusal, and the card is still the plan.
        if (hit) {
          res.json(await withOffers(tenantDb(req), sessionUserId(req) ?? "", null, replyDespiteRefusal(human, hit, asked)));
          return;
        }
        res.status(status).json({
          type: "error",
          error: {
            code: "no_ai",
            message: human.message,
            ...(human.code ? { reason: human.code } : {}),
            ...(human.retryAfterSec ? { retry_after_sec: human.retryAfterSec } : {}),
            ...(human.resetsAt ? { resets_at: human.resetsAt } : {}),
          },
        });
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
    if (Math.random() < 0.02) void sweepTurns(tdb).then(() => sweepOffers(tdb)).catch(() => {}); // DETACHED: an occasional sweep of stale turns; the next request runs another

    // Detached. The request is answered; this continues on its own. Every
    // outcome - success, a refused provider, a thrown error - lands in the
    // turn row and its event log, so nothing about it depends on a socket.
    // DETACHED: the turn itself; every outcome lands in its turn row, which the client reads
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
        // Every offer the turn makes is kept as a record before the turn is
        // finished, so the card a reload draws is the one this turn drew.
        await finishTurn(tdb, turnId, { ok: true, result: await withOffers(tdb, userId, turnId, await asOnePlan(c, withDeleteThisCard(withPlanCard(result, hit, asked), asked, parsed.data.selection), asked)) });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!(err instanceof TurnError) || err.status === 502) console.error(`[core-ai] chat failed: ${msg}`);
        // The raw provider text is in the log above and in the AI call log;
        // the person gets one sentence, never a JSON body.
        const human = humanizeProviderError(msg, failureDetailOf(err));
        if (hit) {
          // The plan needed no model; the turn ends on it, with the refusal as
          // what the reply says.
          await finishTurn(tdb, turnId, { ok: true, result: await withOffers(tdb, userId, turnId, replyDespiteRefusal(human, hit, asked)) }).catch(() => {});
          return;
        }
        await finishTurn(tdb, turnId, {
          ok: false,
          error: human.message,
          ...(human.code ? { code: human.code } : {}),
          ...(human.retryAfterSec ? { retryAfterSec: human.retryAfterSec } : {}),
          ...(human.resetsAt ? { resetsAt: human.resetsAt } : {}),
        }).catch(() => {});
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
// UI-REACH: the assistant's own door for a write it makes; the panel lists each write and offers its undo
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
    if (prefs.write_mode === "off") {
      res.status(403).json({
        error: {
          code: "writes_off",
          message: 'Changes are turned off for this chat. The person can allow them in the chat\'s settings ("Changes" to Ask or Auto).',
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

    // A change that may not apply on its own (Changes is Ask, a delete, an
    // action that cannot be undone or acts outside the workspace) is OFFERED,
    // not refused. This door is always an in-app chat turn with a person
    // watching it, so the change becomes the same confirm card the built-in
    // path makes, on that turn: "this connection has no way to show you a
    // confirm step" was never true of it (the owner, 2026-10-02, on the
    // Claude bridge). The model is told it was offered and nothing changed.
    let hold = prefs.write_mode !== "auto" || (ws[0]?.tool !== "action" && autoWriteMustHold(ws));
    if (!hold && ws[0]?.tool === "action") {
      const actionId = String((body.data.args as Record<string, unknown>).action_id ?? "");
      hold = !actionRunsUnconfirmed(await actionCopy(ctxOf(req), actionId));
    }
    if (hold) {
      const wsApiOffer = chatWorkspaceApi(ctxOf(req));
      const kinds = await fetchKinds(wsApiOffer).catch(() => [] as KindRec[]);
      const built = await proposalOf(ctxOf(req), wsApiOffer, kinds, { id: "relay", name: body.data.tool, args: body.data.args as Record<string, unknown> }, turn?.prompt ?? "");
      if ("error" in built) {
        // Adding several at once has no single card yet; say so in words the
        // assistant can pass on, never "an operation I don't have".
        const message =
          body.data.tool === "create_records"
            ? "Adding several at once needs Changes set to Auto in this chat for now. Offer them one at a time instead, each as its own change for the person to confirm."
            : built.error;
        res.status(400).json({ ok: false, message, error: { code: "not_offerable", message } });
        return;
      }
      const kept = (await withOffers(db, userId, turn?.id ?? null, { type: "proposal", summary: built.summary, proposal: built.proposal })) as { offer_id?: string };
      if (turn) await emitTurnEvent(db, turn.id, "tool-result", { name: body.data.tool, ok: true, summary: `Offered: ${built.summary}` }).catch(() => {});
      res.json({
        ok: true,
        offered: true,
        offer_id: kept.offer_id ?? null,
        summary: built.summary,
        message: `Offered for the person to confirm: ${built.summary}. Nothing has changed yet. A Confirm card shows under your reply, so tell them in one sentence what it will do.`,
      });
      return;
    }

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
        ...("entity" in out && out.entity?.id && out.entity.label ? { entity: out.entity } : {}),
        ...("touched" in out && out.touched?.length ? { touched: out.touched } : {}),
        ...(out.destination ? { destination: out.destination } : {}),
      }).catch(() => {});
    }
    sendWriteOutcome(res, out);
  }),
);

// AI-REACH: exempt — this is the assistant TELLING the panel what it is doing,
// not a capability for it to choose. It writes no workspace data; the whole of
// it is a progress line on the caller's own open turn.
// UI-REACH: the assistant telling the open panel what it is doing; nothing for a person to press
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
        // state-flips-last: a stream; readTurn below only heals
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
  write_mode: z.enum(["off", "ask", "auto"]).optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  write_tools: z.boolean().optional(),
  // The model pill. Omitted = leave as is; null = back to the workspace
  // default. A choice is a provider_id OR a credential_id, plus a model.
  provider_id: z.string().max(120).nullable().optional(),
  model: z.string().max(200).nullable().optional(),
  credential_id: z.string().max(80).nullable().optional(),
});

// AI-REACH: exempt — the person's model pill decides which provider reads their
// messages and who pays; the assistant never picks its own model
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
    // The model choice, only when the body spoke to it: a pill toggling
    // "read my data" must not wipe the model somebody picked a minute ago.
    const spoke = "provider_id" in parsed.data || "model" in parsed.data || "credential_id" in parsed.data;
    const stored = parsed.data.model ? storedModel(parsed.data.model, { providerId: parsed.data.provider_id ?? null }) : { model: null, model_follows: null };
    const pick = spoke
      ? {
          provider_id: parsed.data.provider_id ?? null,
          ...stored,
          credential_id: parsed.data.credential_id ?? null,
        }
      : {};
    await tenantDb(req)
      .insertInto("core_ai_chat_prefs")
      .values({ user_id: userId, read_tools: parsed.data.read_tools, write_tools: writeTools, write_mode: mode, ...pick })
      .onConflict((oc) =>
        oc.column("user_id").doUpdateSet({
          read_tools: parsed.data.read_tools,
          write_tools: writeTools,
          write_mode: mode,
          ...pick,
          updated_at: new Date(),
        }),
      )
      .execute();
    res.json(await chatPrefsOf(req));
  }),
);

// ── GET /chat/models — what the model pill can offer, and what it is set to ──
//
/** The personal connections in a chain, once each, in the order asked. */
export function routedFromChain(steps: AiChainStep[]): RoutedConnection[] {
  const seen = new Set<string>();
  const out: RoutedConnection[] = [];
  for (const st of steps) {
    if (!st.credential_id || seen.has(st.credential_id)) continue;
    seen.add(st.credential_id);
    out.push({ credentialId: st.credential_id, providerId: st.provider_id, label: st.label, ownerUserId: st.owner_user_id ?? "", approved: true, active: false });
  }
  return out;
}

/** The chain's order as the menu's group keys: "ws" for the workspace's own. */
export function chainOrder(steps: AiChainStep[]): string[] {
  const out: string[] = [];
  for (const st of steps) {
    const key = st.credential_id ?? (st.source === "workspace" ? "ws" : "");
    if (key && !out.includes(key)) out.push(key);
  }
  return out;
}

// The workspace's own providers plus the personal connections routed in and
// approved, each with its provider's short list of chat models. The choice is
// per person and lives on the same prefs row as the other two pills.
// AI-REACH: this module IS the assistant; which model answers it is not a thing it should reach into
chatRouter.get(
  "/models",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const userId = sessionUserId(req) ?? "";
    const orgId = tenantContext(req).org.id;
    const [prefs, rows, routed, chain, chatDefault] = await Promise.all([
      chatPrefsOf(req),
      tenantDb(req)
        .selectFrom("core_ai_providers")
        .select(["provider_id", "label", "enabled", "config"])
        .where("enabled", "=", true)
        .execute()
        .catch(() => []),
      // The module-facing seam for "which personal connections may this
      // workspace name": the same list the AI page's per-job picker uses.
      platform().connections.routedTo("ai-provider", orgId).catch(() => []),
      // Who can answer this person's chat, in the order the router asks:
      // their own "Just me" connections are here, which the Share list is
      // not, so a person could never pick their own bridge (#3842).
      platform().ai.chainFor(orgId, userId || null, "chat", { limit: 20 }).catch(() => null),
      // What the workspace's own chat default is, so the pill can SAY it at
      // rest ("Flash Lite") instead of "Default". The per-job row when one
      // was set; otherwise the first enabled provider's default, which is
      // the same first step the resolver takes.
      tenantDb(req)
        .selectFrom("core_ai_capability_defaults")
        .select(["provider_id", "model", "credential_id", "model_follows"])
        .where("capability", "=", "chat")
        .executeTakeFirst()
        .catch(() => undefined),
    ]);
    const providers = platform().ai.listProviders().map((p) => ({
      id: p.id,
      label: p.label,
      models: p.capabilities.chat?.models ?? [],
      ...(p.capabilities.chat?.defaultModel ? { defaultModel: p.capabilities.chat.defaultModel } : {}),
      ...(p.modelNotes ? { modelNotes: p.modelNotes } : {}),
    }));
    const firstEnabled = rows[0] ? providers.find((p) => p.id === rows[0]!.provider_id) : undefined;
    const workspaceDefault = chatDefault?.provider_id && chatDefault.model
      ? { provider_id: chatDefault.credential_id ? (routed.find((c) => c.credentialId === chatDefault.credential_id)?.providerId ?? chatDefault.provider_id) : chatDefault.provider_id, model: chosenModel(chatDefault) }
      : firstEnabled?.defaultModel
        ? { provider_id: firstEnabled.id, model: firstEnabled.defaultModel }
        : null;
    // What each connection that can be asked says it serves, asked together
    // (each answer cached a minute). `?fresh=1` is the menu's Retry.
    const fresh = req.query.fresh === "1";
    const routedConns = chain ? routedFromChain(chain.steps) : routed;
    const askable: Array<[string, { providerId?: string; credentialId?: string }]> = [
      ...rows.filter((r) => r.enabled).map((r) => [`ws:${r.provider_id}`, { providerId: r.provider_id }] as [string, { providerId: string }]),
      ...routedConns.filter((c) => c.approved).map((c) => [c.credentialId, { credentialId: c.credentialId }] as [string, { credentialId: string }]),
    ];
    const answers = await Promise.all(
      askable.map(async ([key, ref]) => [key, await platform().ai.modelsReportedBy(orgId, userId || null, ref, { fresh, capability: "chat" }).catch(() => null)] as const),
    );
    const reported: ReportedModels = Object.fromEntries(answers.filter((a): a is readonly [string, NonNullable<(typeof a)[1]>] => a[1] !== null));
    const menu = chatModelMenu({
      providers,
      reported,
      workspaceDefault,
      workspace: rows.map((r) => ({
        provider_id: r.provider_id,
        label: r.label,
        enabled: !!r.enabled,
        model: typeof (r.config as Record<string, unknown> | null)?.model === "string" ? String((r.config as Record<string, unknown>).model) : null,
      })),
      routed: routedConns,
      ...(chain ? { order: chainOrder(chain.steps) } : {}),
      viewerUserId: userId,
      prefs,
    });
    res.json(menu);
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
      // list-cap-ok: the recent changes an assistant made, the ones a person reviews and undoes; not an archive
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

// AI-REACH: exempt — putting a change back is a person's decision about the
// assistant's work, never the assistant's own move.
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
    sendWriteOutcome(res, out);
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
const ExecStep = z.union([
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
    // What the card showed. Carried back so the execute step is the same
    // object the person confirmed; nothing reads it server-side.
    plan: z.object({ title: z.string(), lines: z.array(z.string()) }).optional(),
  }),
  z.object({ kind: z.literal("build"), draft_id: z.string() }),
  // add_thing (#4472): what the agent asked to add, run through the inbox.
  z.object({ kind: z.literal("add"), args: z.record(z.unknown()) }),
  // put_back_scan_item (#6100): a scan inbox item put back as a step found it.
  z.object({ kind: z.literal("put_back"), id: z.string().min(1), revision: z.string().optional(), label: z.string().optional() }),
  // file_inbox_items: inbox items filed into one list, each its record there.
  z.object({
    kind: z.literal("file"),
    ids: z.array(z.string()).min(1).max(200),
    list: z.string().min(1),
    list_label: z.string().optional(),
    lines: z.array(z.string()).optional(),
  }),
]);
type ExecStepT = z.infer<typeof ExecStep>;

// One request's changes as one card (one-plan.ts): its steps, run in order.
const ExecProposal = z.union([
  ExecStep,
  z.object({
    kind: z.literal("plan"),
    title: z.string(),
    steps: z.array(z.object({ summary: z.string(), proposal: ExecStep, undoable: z.boolean().nullable().optional() })).min(2).max(20),
  }),
]);

const ExecBody = z.object({
  // The offer being confirmed. Its stored plan is what runs, never the copy
  // the browser sends back; the copy stays accepted for a panel loaded before
  // offers were kept, and for callers (the MCP server) that make none.
  offer_id: optionalUuid(),
  // What the user asked, so a CONFIRMED write is a worked example too. The
  // widget knows it; the server cannot, because a proposal arrives on its own
  // request. Optional, and only ever used as a label on the ledger row.
  prompt: z.string().max(2000).optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  proposal: ExecProposal.optional(),
});

// AI-REACH: exempt — the person's Confirm on a proposal; an assistant that
// could press its own Confirm would defeat the confirm
chatRouter.post(
  "/execute",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = ExecBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const c = ctxOf(req);
    const me = sessionUserId(req) ?? "";
    const odb = tenantDb(req);
    const offerId = parsed.data.offer_id;
    let p = parsed.data.proposal;
    if (offerId) {
      // The offer kept when it was made is what runs. Claimed first, so a
      // second press (another tab, a double click) finds it answered.
      const claimed = await claimOffer(odb, me, offerId);
      if (!claimed) {
        const [was] = await readOffers(odb, me, [offerId]);
        const message = was ? offerAnsweredSentence(was.status) : "That offer is not there any more. Ask again.";
        res.status(409).json({ ok: false, message, offer: was ?? null, error: { code: "offer_answered", message } });
        return;
      }
      const stored = ExecProposal.safeParse(typeof claimed.proposal === "string" ? JSON.parse(claimed.proposal) : claimed.proposal);
      if (!stored.success) {
        await answerOffer(odb, me, offerId, "failed", { ok: false, message: "That offer could not be read back." });
        res.status(400).json({ ok: false, message: "That offer could not be read back. Ask again.", error: { code: "offer_unreadable", message: "That offer could not be read back." } });
        return;
      }
      p = stored.data;
    }
    if (!p) {
      res.status(400).json({ error: { code: "bad_body", message: "an offer_id or a proposal is required" } });
      return;
    }
    // What happened, kept on the offer, then sent: a reload shows the same
    // outcome the press did.
    const sendOutcome = async (r: Response, said: { ok: boolean; message: string; applied?: unknown[] }): Promise<void> => {
      // A refusal is the action's own sentence, written for whoever called
      // it; the person who pressed Confirm reads it in the workspace's words.
      const out = said.ok ? said : { ...said, message: forAPerson(said.message, await fetchKinds(chatWorkspaceApi(c)).catch(() => [])) };
      if (offerId) await answerOffer(odb, me, offerId, out.ok ? "confirmed" : "failed", out).catch(() => undefined);
      sendWriteOutcome(r, out);
    };
    const prompt = parsed.data.prompt ? { prompt: parsed.data.prompt } : {};
    // One change, run. Every record write + action runs through performWrite
    // → the AI change ledger (before-image captured, undo available). One
    // path, confirmed or auto — the ONLY way chat writes happen.
    const runOne = async (step: ExecStepT): Promise<WriteOutcome & { status?: number }> => {
      if (step.kind === "create" || step.kind === "update" || step.kind === "delete") {
        return performWrite(
          chatWorkspaceApi(c),
          tenantDb(req),
          me,
          {
            tool: step.kind,
            entity_kind: step.entity_kind,
            ...(step.kind !== "create" ? { entity_id: step.entity_id } : {}),
            ...(step.kind !== "delete" ? { fields: step.fields } : {}),
          },
          { auto: false, orgId: tenantContext(req).org.id, ...prompt },
        );
      }
      if (step.kind === "file") {
        return performWrite(
          chatWorkspaceApi(c),
          tenantDb(req),
          me,
          { tool: "create", via: "file_inbox", entity_kind: "", args: { ids: step.ids, list: step.list } },
          { auto: false, orgId: tenantContext(req).org.id, ...prompt },
        );
      }
      if (step.kind === "put_back") {
        return performWrite(
          chatWorkspaceApi(c),
          tenantDb(req),
          me,
          { tool: "update", via: "put_back_scan", entity_kind: "", args: { id: step.id, ...(step.revision ? { revision: step.revision } : {}) } },
          { auto: false, orgId: tenantContext(req).org.id, ...prompt },
        );
      }
      if (step.kind === "add") {
        return performWrite(
          chatWorkspaceApi(c),
          tenantDb(req),
          me,
          { tool: "create", via: "add_thing", entity_kind: "", args: step.args },
          { auto: false, orgId: tenantContext(req).org.id, ...prompt },
        );
      }
      if (step.kind === "build") {
        // Apply the validated design-workspace draft (install re-validates +
        // enables the required modules, then seeds any planned starter records).
        const r = await callApi(c, "POST", `/modules/core-authoring/drafts/${step.draft_id}/apply`, { confirm: true });
        if (r.status >= 400) {
          return { ok: false, status: r.status, message: (r.body.error as { message?: string } | undefined)?.message ?? "Couldn't set up the workspace." };
        }
        const created = (r.body.seeded as { created?: number } | undefined)?.created ?? 0;
        return {
          ok: true,
          message:
            "Your workspace is set up — modules enabled and fields added" +
            (created > 0 ? `, plus ${created} starter record${created === 1 ? "" : "s"} created.` : "."),
        };
      }
      // action — ledgered too (recorded, not undoable).
      return performWrite(
        chatWorkspaceApi(c),
        tenantDb(req),
        me,
        { tool: "action", entity_kind: step.entity_kind ?? "", entity_id: step.entity_id, action_id: step.action_id, args: step.args },
        { auto: false, ...prompt },
      );
    };
    try {
      if (p.kind === "plan") {
        // In order, and no further than the first step that does not go
        // through: what came before it is done (and undoable as each says),
        // what comes after is not started, and the outcome says which.
        const done: string[] = [];
        // Each step that ran is a done card with its own Undo where it has
        // one, the same as a change Cobb made inside a turn.
        const applied: ReturnType<typeof appliedSummaries> = [];
        for (const [i, step] of p.steps.entries()) {
          const out = await runOne(step.proposal);
          const said = out.message.replace(/^[✓✗]\s*/, "");
          if (!out.ok) {
            const rest = p.steps.length - i - 1;
            await sendOutcome(res, {
              ok: false,
              ...(applied.length ? { applied } : {}),
              message: [
                done.length ? `Done: ${done.join(" ")}` : "",
                `Not done: ${step.summary}. ${said}`,
                rest ? (rest === 1 ? "The step after it was not started." : `The ${rest} steps after it were not started.`) : "",
              ]
                .filter(Boolean)
                .join(" "),
            });
            return;
          }
          done.push(/[.!?]$/.test(said) ? said : `${said}.`);
          applied.push(...appliedSummaries([{ call: { id: `step-${i}`, name: step.proposal.kind, args: {} }, result: out }]));
        }
        await sendOutcome(res, { ok: true, message: done.join(" "), applied });
        return;
      }
      const out = await runOne(p);
      if (p.kind === "build") {
        if (offerId) await answerOffer(odb, me, offerId, out.ok ? "confirmed" : "failed", { ok: out.ok, message: out.message }).catch(() => undefined);
        if (out.ok) res.json({ ok: true, message: out.message });
        else res.status(out.status ?? 400).json({ ok: false, message: out.message });
        return;
      }
      await sendOutcome(res, out);
    } catch (err) {
      // A run that threw is answered as failed, never left "confirming".
      if (offerId) await answerOffer(odb, me, offerId, "failed", { ok: false, message: err instanceof Error ? err.message : String(err) }).catch(() => undefined);
      throw err;
    }
  }),
);

// POST /chat/offers/lookup {ids} → my offers, with what became of each: what
//                                  a reloaded panel redraws its cards from. The
//                                  ids ride in the body (#4653).
// AI-REACH: exempt internal: this module IS the assistant; a panel redrawing its own cards is not a thing it should reach into
chatRouter.post(
  "/offers/lookup",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = z.object({ ids: z.array(z.string().max(100)).max(1_000) }).safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    res.json({ items: await readOffers(tenantDb(req), sessionUserId(req) ?? "", parsed.data.ids) });
  }),
);

// GET /chat/offers?ids=a,b: the pre-#4653 address, kept for a page loaded
// before the update.
chatRouter.get(
  "/offers",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const ids = String(req.query.ids ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    res.json({ items: await readOffers(tenantDb(req), sessionUserId(req) ?? "", ids) });
  }),
);

// POST /chat/offers/:id/cancel   → the person said no. Kept, so another tab or
//                                  a reload shows "Cancelled", not a live card.
// AI-REACH: exempt the person's own answer to Cobb's offer; asking Cobb to press its own Confirm would defeat the confirm
chatRouter.post(
  "/offers/:id/cancel",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = String(req.params.id ?? "");
    const me = sessionUserId(req) ?? "";
    const done = /^[0-9a-f-]{36}$/i.test(id) && (await answerOffer(tenantDb(req), me, id, "cancelled", { ok: true, message: "Okay, left it alone." }, ["open"]));
    const [now] = await readOffers(tenantDb(req), me, [id]);
    res.status(done || now?.status === "cancelled" ? 200 : 409).json({ ok: done, offer: now ?? null });
  }),
);

// `owner` is the account the panel read these messages for. A browser that
// another member signed into still held the last one's conversation, and saved
// it to the new account (#7062); a write for anyone but the person signed in is
// refused, whatever the panel believes.
const ConversationBody = z.object({ messages: z.array(z.record(z.unknown())).max(200), owner: z.string().min(1) });

// GET /chat/conversation         → my conversation, as the panel keeps it, so
//                                  another tab or device opens on the same one.
// PUT /chat/conversation         → replace it (the panel writes what it shows).
chatRouter.get(
  "/conversation",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const me = sessionUserId(req);
    res.json({ conversation: me ? await readConversation(tenantDb(req), me) : null });
  }),
);
// AI-REACH: exempt internal: the panel keeps its own conversation here; nothing in it is a change to the workspace
chatRouter.put(
  "/conversation",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = ConversationBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const me = sessionUserId(req);
    if (!me || parsed.data.owner !== me) {
      res.status(409).json({ error: { code: "not_your_conversation", message: "This conversation was read for another account, so it is not kept for this one." } });
      return;
    }
    if (JSON.stringify(parsed.data.messages).length > 1_000_000) {
      res.status(413).json({ error: { code: "too_large", message: "That conversation is too long to keep; the newest part is kept on this device." } });
      return;
    }
    res.json({ updated_at: await writeConversation(tenantDb(req), me, parsed.data.messages) });
  }),
);

// Re-exported so existing callers (benches, tests) keep one import path.
export { GROUNDING_RULES, PLAIN_ANSWER_RULES, TOOL_USE_RULES };
