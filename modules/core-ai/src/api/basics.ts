// Ask Cobb "basic mode" — the no-AI floor, now per-workspace + trainable.
// When a workspace has no AI provider, the chat calls POST /basics/answer and
// gets a lexical, deterministic answer from the EFFECTIVE ruleset: the built-in
// catalog (basics-catalog.ts) overlaid with this workspace's overrides + custom
// rules (core_ai_basics). Owners/admins manage the rules here; matching + the
// list are member-visible. No provider, no cost, no dead-end.
//
// See docs/design-decisions/no-ai-chat-training.md.

import { Router } from "express";
import { groupWritesByRequest } from "./group-writes.js";
import { z } from "zod";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { tenantDb, tenantContext, sessionUserId } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { matchBasics, normalize } from "../basics-match.js";
import { CONTROL_KEYS, actReply, resolveControlAct } from "../control-context.js";
import { COMPUTED_COMMANDS, computedCommandFor } from "../computed-commands.js";
import type { WorkspaceApi } from "@cobblr/workspace-tools";
import { bindCommand, deriveCommand, type LearnedCommand, type Operation } from "../learned-commands.js";
import { readQuestionOf, MIN_PEEK_LENGTH, type KindWords } from "../live-answers.js";
import { performWrite, performWrites } from "./chat-ledger.js";
import { chatWorkspaceApi, ctxOf } from "./chat.js";
import {
  loadEffectiveRules,
  toMatchable,
  nextCustomPosition,
  isBuiltinKey,
  builtinDefaultPosition,
} from "../basics-store.js";

export const basicsRouter = Router({ mergeParams: true });

/** The written-down floor, offered before the message is even sent. Stricter on
 *  purpose than the send path: a rule qualifies only on a MULTI-WORD phrase,
 *  because a one-word trigger like "help" or "options" fires partway through
 *  half the sentences anyone types, and a bubble that appears every third
 *  keystroke is noise however true it is. */
const MIN_PEEK_RULE_SCORE = 2;

async function guideAnswerFor(
  db: ReturnType<typeof tenantDb>,
  message: string,
  aiOn: boolean,
): Promise<string | null> {
  const rules = toMatchable(await loadEffectiveRules(db));
  const m = matchBasics(message, rules, { aiOn, offering: true });
  if (!m.matched) return null;
  if (m.score >= MIN_PEEK_RULE_SCORE) return m.reply;
  // ...with one exception: a single word that is the WHOLE message is not a
  // fragment of a longer sentence, it is the sentence. "hello" is a complete
  // thing to say and deserves an answer; "hello" inside "hello can you add a
  // rack" does not, and the phrase rule above already withholds it there.
  const whole = normalize(message);
  const rule = rules.find((r) => r.key === m.key);
  return rule?.keywords.some((k) => normalize(k) === whole) ? m.reply : null;
}

const Keywords = z.array(z.string().trim().min(1).max(80)).min(1).max(40);
const AnswerBody = z.object({
  message: z.string().min(1).max(2000),
  selection_ids: z.array(z.string().max(64)).max(200).optional(),
  /** The prior turn, summarised by the client (which keeps the conversation) so
   *  control words — yes, again, undo — can point at something. Bounded, and
   *  never trusted to act by itself: every act it produces is executed through
   *  endpoints that re-validate (see control-context.ts). */
  prior: z
    .object({
      offered: z.object({ id: z.string().max(64), message: z.string().max(2000) }).optional(),
      ran: z.object({ id: z.string().max(64), message: z.string().max(2000) }).optional(),
      ledger_ids: z.array(z.string().uuid()).max(50).optional(),
    })
    .optional(),
});

const BasicCreate = z.object({
  intent: z.string().trim().min(1).max(120),
  keywords: Keywords,
  reply: z.string().trim().min(1).max(4000),
  enabled: z.boolean().optional(),
  // Set to override a built-in (snapshotting its fields); omit for a custom rule.
  builtin_key: z.string().min(1).optional(),
});
const BasicUpdate = z.object({
  intent: z.string().trim().min(1).max(120).optional(),
  keywords: Keywords.optional(),
  reply: z.string().trim().min(1).max(4000).optional(),
  enabled: z.boolean().optional(),
  position: z.number().int().optional(),
});

// GET /basics — the effective ruleset (built-ins overlaid with overrides + customs).
basicsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const rules = await loadEffectiveRules(tenantDb(req));
    res.json({ rules });
  }),
);

// POST /basics/answer — match a message → reply (chat's no-AI path + the tester).
// AI-REACH: this module IS the assistant; its own configuration is not a thing it should reach into
basicsRouter.post(
  "/answer",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = AnswerBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    // Control words FIRST, when the prior turn gives them something to point
    // at: "go for it" after an offer is the person saying yes, and matching it
    // against learned commands or keyword rules would answer a different
    // question than the one asked. Without a usable prior these fall through
    // to the rules below, whose replies honestly say nothing is queued.
    if (parsed.data.prior) {
      const effectiveForProbe = await loadEffectiveRules(db);
      const probe = matchBasics(parsed.data.message, toMatchable(effectiveForProbe));
      if (probe.matched && probe.key && CONTROL_KEYS.has(probe.key)) {
        const act = resolveControlAct(probe.key, parsed.data.prior);
        if (act) {
          res.json({
            matched: true,
            intent: probe.intent,
            key: probe.key,
            score: probe.score,
            candidates: [],
            reply: actReply(act),
            act,
          });
          return;
        }
      }
    }
    // A COMMAND this workspace taught itself wins over a keyword answer: the
    // keyword rules explain how to do something, and a command just does it.
    // It is offered, never run from here — writing to a workspace needs a
    // person to say yes, and this endpoint answers a keystroke.
    const command = await matchCommand(db, parsed.data.message, tenantContext(req).org.id, {
      wsApi: chatWorkspaceApi(ctxOf(req)),
      ...(parsed.data.selection_ids?.length ? { selectionIds: parsed.data.selection_ids } : {}),
    }).catch(() => null);
    if (command) {
      res.json({
        matched: true,
        intent: "learned command",
        key: null,
        score: 99,
        candidates: [],
        reply: `I can do that: **${command.template}**.`,
        command: {
          id: command.id,
          template: command.template,
          operations: command.operations.length,
          summary: describeOps(command.operations),
        },
      });
      return;
    }
    const effective = await loadEffectiveRules(db);
    const result = matchBasics(parsed.data.message, toMatchable(effective));
    res.json(result);
    // Remember what we could NOT answer, so the ruleset can grow from what
    // people actually ask. After the response: a question is not worth failing
    // over, and the user is waiting.
    if (!result.matched) void recordMiss(db, parsed.data.message).catch(() => {});
  }),
);

// POST /basics — create a custom rule, or override a built-in (builtin_key set).
// AI-REACH: this module IS the assistant; its own configuration is not a thing it should reach into
basicsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = BasicCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const { intent, keywords, reply, enabled, builtin_key } = parsed.data;
    if (builtin_key && !isBuiltinKey(builtin_key)) {
      res.status(400).json({ error: { code: "unknown_builtin", message: `No built-in rule "${builtin_key}"` } });
      return;
    }
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    // Overrides keep the built-in's place; new customs append after everything.
    const position = builtin_key ? builtinDefaultPosition(builtin_key) : nextCustomPosition(await loadEffectiveRules(db));
    try {
      const row = await db
        .insertInto("core_ai_basics")
        .values({
          builtin_key: builtin_key ?? null,
          intent,
          reply,
          keywords: sql`${JSON.stringify(keywords)}::jsonb` as never,
          enabled: enabled ?? true,
          position,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      void platform().events.emit("core-ai.basic.created", { orgId: ctx.org.id, rowId: row.id });
      res.status(201).json(row);
    } catch (e) {
      // The partial unique index guards against a second override of one
      // built-in. Match on pg's SQLSTATE, with a message fallback in case the
      // driver error is wrapped before it reaches here.
      const code = (e as { code?: string }).code;
      const msg = String((e as Error)?.message ?? "");
      if (code === "23505" || /unique|duplicate key/i.test(msg)) {
        res.status(409).json({ error: { code: "already_overridden", message: `"${builtin_key}" already has an override — edit it instead` } });
        return;
      }
      throw e;
    }
  }),
);

// PATCH /basics/:id — edit a custom rule or an existing built-in override.
// AI-REACH: this module IS the assistant; its own configuration is not a thing it should reach into
basicsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = BasicUpdate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const d = parsed.data;
    const set: Record<string, unknown> = { updated_at: new Date() };
    if (d.intent !== undefined) set.intent = d.intent;
    if (d.reply !== undefined) set.reply = d.reply;
    if (d.enabled !== undefined) set.enabled = d.enabled;
    if (d.position !== undefined) set.position = d.position;
    if (d.keywords !== undefined) set.keywords = sql`${JSON.stringify(d.keywords)}::jsonb` as never;

    const row = await tenantDb(req)
      .updateTable("core_ai_basics")
      .set(set as never)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "No such rule" } });
      return;
    }
    void platform().events.emit("core-ai.basic.updated", { orgId: tenantContext(req).org.id, rowId: id });
    res.json(row);
  }),
);

// DELETE /basics/:id — remove a custom rule, or reset a built-in to its default.
// AI-REACH: destructive on a record with no undo path through the ledger; delete_record covers kinds that declare it
basicsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const del = await tenantDb(req).deleteFrom("core_ai_basics").where("id", "=", id).executeTakeFirst();
    if (!del.numDeletedRows) {
      res.status(404).json({ error: { code: "not_found", message: "No such rule" } });
      return;
    }
    void platform().events.emit("core-ai.basic.deleted", { orgId: tenantContext(req).org.id, rowId: id });
    res.status(204).end();
  }),
);

/** How many unanswered questions a workspace keeps. Enough to see a pattern,
 *  bounded so a chat box someone types into all day cannot grow without end. */
const MISS_CAP = 200;

/** Note one unanswered question, deduped by the matcher's own normalized form
 *  so "How do I add a part?" and "how do i add a part" are one row with a
 *  count of two. */
async function recordMiss(db: ReturnType<typeof tenantDb>, message: string): Promise<void> {
  const normalized = normalize(message);
  if (!normalized) return;
  const sample = message.trim().slice(0, 500);
  await db
    .insertInto("core_ai_basics_misses")
    .values({ normalized, sample } as never)
    .onConflict((c) =>
      c.column("normalized").doUpdateSet({
        times: sql`core_ai_basics_misses.times + 1`,
        last_seen: new Date(),
        sample,
        // Asking again after it was dismissed is the workspace saying it still
        // matters, so it comes back to the list.
        dismissed: false,
      } as never),
    )
    .execute();
  const total = await db
    .selectFrom("core_ai_basics_misses")
    .select(({ fn }) => fn.countAll<number>().as("n"))
    .executeTakeFirst();
  if (Number(total?.n ?? 0) > MISS_CAP) {
    // Drop the least-asked, oldest ones — a question asked once a month ago is
    // the least useful thing in the list.
    await sql`
      delete from core_ai_basics_misses
      where id in (
        select id from core_ai_basics_misses
        order by times asc, last_seen asc
        limit greatest(0, (select count(*) from core_ai_basics_misses) - ${MISS_CAP})
      )
    `.execute(db);
  }
}

// GET /basics/misses — what basic mode could not answer, most asked first.
// This is the whole point of recording them: a list you can turn into rules.
basicsRouter.get(
  "/misses",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const rows = await tenantDb(req)
      .selectFrom("core_ai_basics_misses")
      .select(["id", "sample", "times", "first_seen", "last_seen"])
      .where("dismissed", "=", false)
      .orderBy("times", "desc")
      .orderBy("last_seen", "desc")
      .limit(50)
      .execute();
    res.json({ items: rows });
  }),
);

// DELETE /basics/misses/:id — dealt with (a rule was written, or it does not
// deserve one). Kept as a flag rather than a delete so asking again brings it
// back rather than silently starting the count over.
// AI-REACH: exempt — this module IS the assistant, and deciding which questions
// it should learn to answer is the workspace owner's call, not its own
basicsRouter.delete(
  "/misses/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    await tenantDb(req)
      .updateTable("core_ai_basics_misses")
      .set({ dismissed: true } as never)
      .where("id", "=", req.params.id!)
      .execute();
    res.status(204).end();
  }),
);

// GET /basics/learned — the successful interactions that could become commands.
//
// This is what the no-AI ruleset has been missing. Its 26 rules answer with
// TEXT, so a workspace without AI can be TOLD how to add a location and cannot
// be asked to add twelve. But every write Ask Cobb performs is recorded, and
// now so is the sentence that caused it — which makes each one a worked
// example. Group a turn's writes, generalise the literals the sentence and the
// operations share, and you have a command the workspace can run on its own.
//
// Only examples that GENERALISE are returned: deriveCommand refuses anything it
// cannot explain from the message, and an example that explains nothing is not
// a candidate, it is just history.
// AI-REACH: exempt — this module IS the assistant; which of its own commands a
// workspace adopts is the owner's call, not its own
basicsRouter.get(
  "/learned",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const rows = await tenantDb(req)
      .selectFrom("core_ai_chat_writes")
      .select(["id", "turn_id", "prompt", "tool", "entity_kind", "entity_label", "payload", "created_at"])
      .where("prompt", "is not", null)
      .where("undone_at", "is", null)
      .orderBy("created_at", "desc")
      .limit(400)
      .execute();

    // One sentence, all of its writes: twelve racks are ONE example. The rule
    // is in group-writes.ts — it used to key on the wall-clock MINUTE, which
    // split any request unlucky enough to straddle :59.
    const groups = groupWritesByRequest(rows);

    const items: Array<{
      prompt: string;
      did: string;
      operations: number;
      template: string;
      pattern: string;
      slots: Array<{ name: string; kind: string }>;
      plan: Operation[];
      repeat_field?: string;
      repeat_shape?: string;
      last_used: string;
    }> = [];
    for (const group of groups) {
      const first = group[0]!;
      const ops: Operation[] = group.map((r) => ({
        tool: r.tool,
        entity_kind: r.entity_kind,
        payload: ((r.payload as { args?: Record<string, unknown> } | null)?.args ??
          (r.payload as Record<string, unknown> | null) ??
          {}) as Record<string, unknown>,
        ...(r.tool === "action"
          ? { action_id: String((r.payload as { action_id?: string } | null)?.action_id ?? r.entity_label) }
          : {}),
      }));
      const cmd = deriveCommand(String(first.prompt ?? ""), ops);
      if (!cmd) continue; // history, not a command
      items.push({
        prompt: String(first.prompt ?? ""),
        did: `${ops.length} × ${first.tool} ${first.entity_kind || String(ops[0]?.action_id ?? "")}`.trim(),
        operations: ops.length,
        template: cmd.template,
        pattern: cmd.pattern,
        slots: cmd.slots,
        plan: cmd.plan,
        ...(cmd.repeatField ? { repeat_field: cmd.repeatField } : {}),
        ...(cmd.repeatShape ? { repeat_shape: cmd.repeatShape } : {}),
        last_used: new Date(first.created_at).toISOString(),
      });
    }
    // Same template twice is the same command; the most recent wording wins.
    const seen = new Set<string>();
    const unique = items.filter((i) => (seen.has(i.template) ? false : (seen.add(i.template), true)));
    res.json({ items: unique.slice(0, 50) });
  }),
);

// ── Adopted commands: things this workspace can do with no AI at all ────────
//
// A candidate from /basics/learned is a suggestion. Adopting one makes it a
// command: a pattern that binds a sentence and produces writes. The PATTERN is
// the contract, so the server re-binds on every run from what it stored, and
// never runs operations a client sent it — otherwise "run this command" would
// be "write whatever I say" with extra steps.

const CommandCreate = z.object({
  template: z.string().trim().min(3).max(300),
  pattern: z.string().trim().min(3).max(1000),
  slots: z.array(z.object({ name: z.string().min(1).max(60), kind: z.enum(["text", "number", "range"]) })).max(10),
  plan: z.array(z.object({
    tool: z.enum(["create", "update", "delete", "action"]),
    entity_kind: z.string().max(120),
    action_id: z.string().max(120).nullish(),
    payload: z.record(z.unknown()),
  })).min(1).max(5),
  repeat_field: z.string().max(60).optional(),
  repeat_shape: z.string().max(120).optional(),
});

function asLearned(row: {
  template: string;
  pattern: string;
  slots: unknown;
  plan: unknown;
  repeat_field: string | null;
  repeat_shape: string | null;
}): LearnedCommand {
  return {
    template: row.template,
    pattern: row.pattern,
    slots: (row.slots as LearnedCommand["slots"]) ?? [],
    plan: (row.plan as Operation[]) ?? [],
    ...(row.repeat_field ? { repeatField: row.repeat_field } : {}),
    ...(row.repeat_shape ? { repeatShape: row.repeat_shape } : {}),
  };
}

/** "Creates 4 locations" — what a person is agreeing to, in words.
 *
 *  Not the kind id. "3 × create core-locations:location" is the shape of the
 *  data, and a confirm button is the last place to make somebody read one. */
function describeOps(ops: Operation[]): string {
  const first = ops[0]!;
  const n = ops.length;
  if (first.tool === "action") {
    const label = String(first.action_id ?? "").split(":")[1]?.replace(/-/g, " ") || "an action";
    return n === 1 ? `Runs ${label}` : `Runs ${label}, ${n} times`;
  }
  const noun = (first.entity_kind.split(":")[1] ?? first.entity_kind).replace(/-/g, " ");
  const verb = first.tool === "create" ? "Creates" : first.tool === "update" ? "Updates" : "Deletes";
  return `${verb} ${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** The enabled commands, newest first. Shared by the list route and matching. */
async function loadCommands(db: ReturnType<typeof tenantDb>) {
  return db
    .selectFrom("core_ai_commands")
    .select(["id", "template", "pattern", "slots", "plan", "repeat_field", "repeat_shape", "enabled", "times_used", "last_used_at", "created_at"])
    .orderBy("created_at", "desc")
    .execute();
}

interface ShippedCommandRow {
  id: string;
  module_name: string;
  template: string;
  description: string | null;
  pattern: string;
  slots: unknown;
  plan: unknown;
  repeat_field: string | null;
  repeat_shape: string | null;
}

/** Commands the workspace's ENABLED modules ship.
 *
 *  Teaching a command by watching an AI only helps somebody who had an AI. A
 *  brand-new workspace with none at all should already be able to be asked for
 *  the handful of things everyone wants, so modules declare those in their
 *  manifests and registry-sync compiles them into entity_commands at boot.
 *
 *  Filtered by what this workspace has ENABLED, or a workspace would be offered
 *  a command that writes to tables it does not have. */
async function loadShippedCommands(orgId: string): Promise<ShippedCommandRow[]> {
  const meta = platform().db.meta as {
    selectFrom: (t: string) => {
      innerJoin: (t: string, a: string, b: string) => {
        select: (cols: string[]) => {
          where: (c: string, op: string, v: unknown) => {
            execute: () => Promise<ShippedCommandRow[]>;
          };
        };
      };
    };
  };
  try {
    return await meta
      .selectFrom("entity_commands")
      .innerJoin("org_modules", "org_modules.module_name", "entity_commands.module_name")
      .select([
        "entity_commands.id as id",
        "entity_commands.module_name as module_name",
        "entity_commands.template as template",
        "entity_commands.description as description",
        "entity_commands.pattern as pattern",
        "entity_commands.slots as slots",
        "entity_commands.plan as plan",
        "entity_commands.repeat_field as repeat_field",
        "entity_commands.repeat_shape as repeat_shape",
      ])
      // A row in org_modules IS enablement; there is no `enabled` column, and
      // asking for one threw, which the catch below turned into "this
      // workspace has no shipped commands". Silent-empty-on-error is how a
      // broken query looks exactly like an empty world.
      .where("org_modules.org_id", "=", orgId)
      .execute();
  } catch (e) {
    // An instance whose platform migration has not run yet genuinely has none.
    // Anything else is a bug, and must not read as an empty world.
    const msg = (e as Error).message ?? "";
    if (!/entity_commands/.test(msg)) console.warn(`[core-ai] shipped commands unreadable: ${msg}`);
    return [];
  }
}

/** Does any adopted command claim this message? First match wins, newest
 *  first, which is the same "most recently taught wins" a person expects. */
export async function matchCommand(
  db: ReturnType<typeof tenantDb>,
  message: string,
  orgId?: string,
  /** Where to look, when the user pointed at something. */
  ctx?: { wsApi: WorkspaceApi; selectionIds?: string[] },
): Promise<{ id: string; template: string; operations: Operation[]; summary?: string } | null> {
  // A COMPUTED command is checked first: it is the most specific thing that
  // can match, and unlike the others it has to go and look at the workspace
  // before it can say what it would do.
  if (ctx?.wsApi) {
    const computed = computedCommandFor(message);
    if (computed) {
      const plan = await computed
        .plan({ wsApi: ctx.wsApi, ...(ctx.selectionIds?.length ? { selectionIds: ctx.selectionIds } : {}) })
        .catch(() => null);
      // No plan means nothing to do — "delete duplicates" in a workspace with
      // none is not an offer, it is an answer, and the rules below give it.
      if (plan?.operations.length) {
        return {
          id: `computed:${computed.id}`,
          template: computed.template,
          operations: plan.operations,
          summary: plan.summary,
        };
      }
    }
  }
  // The workspace's OWN commands first: something it taught itself beats
  // something we guessed everyone would want, and it is the more specific of
  // the two by definition.
  for (const row of await loadCommands(db)) {
    if (!row.enabled) continue;
    const ops = bindCommand(asLearned(row), message);
    if (ops?.length) return { id: row.id, template: row.template, operations: ops };
  }
  if (!orgId) return null;
  for (const row of await loadShippedCommands(orgId)) {
    // A workspace can turn a shipped command off by adopting it and disabling
    // that copy; a disabled row with the same template wins here.
    const ops = bindCommand(asLearned(row), message);
    if (ops?.length) return { id: `shipped:${row.id}`, template: row.template, operations: ops };
  }
  return null;
}

// POST /basics/commands/match — "does anything I know fit what is being typed?"
//
// Asked WHILE the user types, before they press enter, so the offer appears
// beside a sentence they have not sent yet. That is what lets a learned command
// and a real AI live together without either one hijacking the other: the AI
// path is untouched (enter still sends), and the free path is taken only by
// choosing it. Nothing is written, nothing is recorded, and an unmatched
// message is NOT a basics miss — a half-typed sentence has not failed at
// anything.
// AI-REACH: exempt — a POST that writes nothing; it answers "would this match",
// which the assistant has no use for since it can invoke the action directly
basicsRouter.post(
  "/commands/match",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const body = z
      .object({
        message: z.string().min(1).max(2000),
        // What the user is pointing at, so "delete duplicates" can mean the
        // ones in THIS rack rather than every one in the workspace.
        selection_ids: z.array(z.string().max(64)).max(200).optional(),
      })
      .safeParse(req.body);
    if (!body.success) return badBody(res, body.error);
    const hit = await matchCommand(tenantDb(req), body.data.message, tenantContext(req).org.id, {
      wsApi: chatWorkspaceApi(ctxOf(req)),
      ...(body.data.selection_ids?.length ? { selectionIds: body.data.selection_ids } : {}),
    });
    res.json({
      command: hit
        ? {
            id: hit.id,
            template: hit.template,
            operations: hit.operations.length,
            // A computed command says what it FOUND ("delete 2 duplicate
            // places, keeping the original of each"); a bound one is described
            // from its operations as before.
            summary: hit.summary ?? describeOps(hit.operations),
          }
        : null,
    });
  }),
);

// GET /basics/commands — what this workspace has taught itself to do.
basicsRouter.get(
  "/commands",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const own = await loadCommands(tenantDb(req));
    const shipped = await loadShippedCommands(tenantContext(req).org.id);
    // Shipped ones the workspace has ALSO taught itself are the same command;
    // its own copy wins, and showing both would read as a duplicate.
    const taught = new Set(own.map((c) => c.template));
    res.json({
      items: [
        ...own.map((c) => ({ ...c, shipped: false, module_name: null as string | null, description: null as string | null })),
        ...shipped
          .filter((c) => !taught.has(c.template))
          .map((c) => ({
            id: `shipped:${c.id}`,
            template: c.template,
            pattern: c.pattern,
            slots: c.slots,
            plan: c.plan,
            repeat_field: c.repeat_field,
            repeat_shape: c.repeat_shape,
            enabled: true,
            times_used: 0,
            last_used_at: null,
            created_at: null,
            shipped: true,
            module_name: c.module_name,
            description: c.description,
          })),
      ],
    });
  }),
);

// POST /basics/commands — adopt a candidate.
// AI-REACH: exempt — teaching the workspace a new way to write to itself is the
// owner's call, and an assistant that could adopt its own commands could widen
// its own reach
basicsRouter.post(
  "/commands",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = CommandCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const d = parsed.data;
    // The pattern must compile HERE, not at run time in front of a user.
    try {
      new RegExp(d.pattern, "i");
    } catch {
      res.status(400).json({ error: { code: "bad_pattern", message: "That command's pattern is not a valid expression." } });
      return;
    }
    const row = await tenantDb(req)
      .insertInto("core_ai_commands")
      .values({
        template: d.template,
        pattern: d.pattern,
        slots: sql`${JSON.stringify(d.slots)}::jsonb`,
        plan: sql`${JSON.stringify(d.plan)}::jsonb`,
        repeat_field: d.repeat_field ?? null,
        repeat_shape: d.repeat_shape ?? null,
      } as never)
      .onConflict((c) => c.column("template").doUpdateSet({
        pattern: d.pattern,
        slots: sql`${JSON.stringify(d.slots)}::jsonb`,
        plan: sql`${JSON.stringify(d.plan)}::jsonb`,
        repeat_field: d.repeat_field ?? null,
        repeat_shape: d.repeat_shape ?? null,
        enabled: true,
      } as never))
      .returningAll()
      .executeTakeFirstOrThrow();
    res.status(201).json(row);
  }),
);

// PATCH /basics/commands/:id — turn one off without forgetting it.
// AI-REACH: exempt — see POST above
basicsRouter.patch(
  "/commands/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const enabled = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (!enabled.success) return badBody(res, enabled.error);
    await tenantDb(req)
      .updateTable("core_ai_commands")
      .set({ enabled: enabled.data.enabled } as never)
      .where("id", "=", req.params.id!)
      .execute();
    res.status(204).end();
  }),
);

// DELETE /basics/commands/:id — forget it.
// AI-REACH: exempt — see POST above
basicsRouter.delete(
  "/commands/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    await tenantDb(req).deleteFrom("core_ai_commands").where("id", "=", req.params.id!).execute();
    res.status(204).end();
  }),
);

// GET /basics/commands/:id/export — the manifest snippet for a command.
//
// The way one workspace's command becomes everyone's. A command that turns out
// to be common should ship in the module, not be re-taught by every workspace
// that wants it — but the sentence somebody typed is THEIR data, so this hands
// it back as text for a person to read, edit and contribute, rather than
// uploading anything anywhere. What comes out is the manifest form, so
// contributing it is a paste into the module and a PR.
// AI-REACH: exempt — reads one command and formats it; nothing to invoke
basicsRouter.get(
  "/commands/:id/export",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const row = await tenantDb(req)
      .selectFrom("core_ai_commands")
      .select(["id", "template", "plan", "repeat_field", "repeat_shape"])
      .where("id", "=", req.params.id!)
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "No such command." } });
      return;
    }
    const plan = (row.plan as Operation[]) ?? [];
    const moduleName = String(plan[0]?.entity_kind ?? "").split(":")[0] || "your-module";
    const slug = row.template.replace(/\{[a-z0-9_]+\}/gi, "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "command";
    // The manifest shape, not the stored shape: no pattern (it is compiled from
    // the template) and camelCase keys, so it can be pasted straight in.
    const snippet = {
      id: `${moduleName}:${slug}`,
      template: row.template,
      description: "",
      plan: plan.map((op) => ({
        tool: op.tool,
        entityKind: op.entity_kind,
        ...(op.action_id ? { actionId: op.action_id } : {}),
        payload: op.payload,
      })),
      ...(row.repeat_field ? { repeatField: row.repeat_field } : {}),
      ...(row.repeat_shape ? { repeatShape: row.repeat_shape } : {}),
    };
    res.json({
      module: moduleName,
      where: `modules/${moduleName}/src/module.ts → exposes.commands`,
      snippet: JSON.stringify(snippet, null, 2),
    });
  }),
);

// POST /basics/commands/:id/run — do it.
//
// The message is re-bound against the STORED pattern here; the client sends
// what the user typed, never the operations. Each write goes through
// performWrite, so a command a workspace taught itself is ledgered and undoable
// exactly like one an AI performed.
// AI-REACH: exempt — this module IS the assistant; running its own learned
// commands is a person confirming, not a tool the assistant reaches for
basicsRouter.post(
  "/commands/:id/run",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const body = z
      .object({
        message: z.string().min(1).max(2000),
        selection_ids: z.array(z.string().max(64)).max(200).optional(),
      })
      .safeParse(req.body);
    if (!body.success) return badBody(res, body.error);
    const db = tenantDb(req);
    const wanted = req.params.id!;
    // A shipped command has no row in the tenant: it belongs to a module, and
    // the workspace never adopted it. Resolve it from the registry instead,
    // still checking the module is enabled HERE, so an id from another
    // workspace's module cannot be replayed into this one.
    let row: {
      id: string;
      template: string;
      pattern: string;
      slots: unknown;
      plan: unknown;
      repeat_field: string | null;
      repeat_shape: string | null;
      enabled: boolean;
    } | undefined;
    // Re-computed, not replayed. Between the offer and the confirm somebody may
    // have deleted one of these themselves, and running a stale list would
    // delete whatever now sits at those ids.
    if (wanted.startsWith("computed:")) {
      const computed = COMPUTED_COMMANDS.find((c) => c.id === wanted.slice("computed:".length));
      if (!computed) {
        res.status(404).json({ error: { code: "unknown_command", message: "No such command." } });
        return;
      }
      const wsApiC = chatWorkspaceApi(ctxOf(req));
      const plan = await computed.plan({
        wsApi: wsApiC,
        ...(body.data.selection_ids?.length ? { selectionIds: body.data.selection_ids } : {}),
      });
      if (!plan?.operations.length) {
        res.json({ ok: true, done: 0, failed: 0, message: "Nothing to do: there are no duplicates now." });
        return;
      }
      const uid = sessionUserId(req) ?? "";
      const outs = await performWrites(wsApiC, db, uid, plan.operations.map((op) => ({
        tool: op.tool,
        entity_kind: op.entity_kind,
        ...(op.entity_id ? { entity_id: op.entity_id } : {}),
        ...(op.tool === "action" ? { args: op.payload } : { fields: op.payload }),
      })), { auto: false, orgId: tenantContext(req).org.id, prompt: body.data.message });
      res.json({
        ok: outs.ok,
        done: outs.count,
        failed: outs.failed.length,
        message: outs.message,
        ledger_ids: outs.ledger_ids,
      });
      return;
    }
    if (wanted.startsWith("shipped:")) {
      const id = wanted.slice("shipped:".length);
      const found = (await loadShippedCommands(tenantContext(req).org.id)).find((c) => c.id === id);
      row = found ? { ...found, enabled: true } : undefined;
    } else {
      row = await db
        .selectFrom("core_ai_commands")
        .select(["id", "template", "pattern", "slots", "plan", "repeat_field", "repeat_shape", "enabled"])
        .where("id", "=", wanted)
        .executeTakeFirst();
    }
    if (!row || !row.enabled) {
      res.status(404).json({ error: { code: "not_found", message: "No such command." } });
      return;
    }
    const ops = bindCommand(asLearned(row), body.data.message);
    if (!ops?.length) {
      res.status(400).json({
        error: { code: "no_match", message: `That does not fit "${row.template}", so I have not done anything.` },
      });
      return;
    }
    const wsApi = chatWorkspaceApi(ctxOf(req));
    const userId = sessionUserId(req) ?? "";
    const done: string[] = [];
    const failed: string[] = [];
    for (const op of ops) {
      const out = await performWrite(
        wsApi,
        db,
        userId,
        {
          tool: op.tool,
          entity_kind: op.entity_kind,
          ...(op.entity_id ? { entity_id: op.entity_id } : {}),
          ...(op.action_id ? { action_id: op.action_id } : {}),
          ...(op.tool === "action" ? { args: op.payload } : { fields: op.payload }),
        },
        { auto: false, prompt: body.data.message, orgId: tenantContext(req).org.id },
      );
      (out.ok ? done : failed).push(out.message);
    }
    res.json({
      ok: failed.length === 0,
      done: done.length,
      failed: failed.length,
      message:
        failed.length === 0
          ? `Done: ${done.length} change${done.length === 1 ? "" : "s"}.`
          : `${done.length} done, ${failed.length} could not be applied: ${failed[0]}`,
    });
    if (done.length && !wanted.startsWith("shipped:")) {
      await db
        .updateTable("core_ai_commands")
        .set({ times_used: sql`times_used + ${done.length}`, last_used_at: new Date() } as never)
        .where("id", "=", row.id)
        .execute()
        .catch(() => {});
    }
  }),
);

// POST /basics/peek — answer a question that is still being typed.
//
// A READ is safe to just do: nothing is written, nothing needs confirming, and
// the answer to "how many parts do I have?" is a number this workspace already
// knows. Making somebody press enter, wait for a model and spend a token to be
// told 47 is three costs for a fact that was sitting right there.
//
// Narrow on purpose. Anything readQuestionOf does not recognise returns null
// and goes to the AI exactly as before, and an ambiguous noun declines rather
// than guessing: a confident wrong number is worse than no number.
// AI-REACH: exempt — reads on the caller's own behalf and writes nothing; the
// assistant has the same reads as tools already
basicsRouter.post(
  "/peek",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const body = z
      .object({
        message: z.string().min(1).max(2000),
        // Which of Cobb's two worlds to answer in. The client already holds
        // this (it renders the whole panel differently either way), and all
        // that rides on it is WHICH true sentence gets shown — not worth an
        // availability check per keystroke to re-derive.
        ai_on: z.boolean().optional(),
      })
      .safeParse(req.body);
    if (!body.success) return badBody(res, body.error);
    // Guarded here as well as in the client: a half-typed word matches nothing
    // useful, and the server should not be doing workspace reads per keystroke
    // for whoever calls it directly.
    if (body.data.message.trim().length < MIN_PEEK_LENGTH) {
      res.json({ answer: null });
      return;
    }

    const db = tenantDb(req);
    const wsApi = chatWorkspaceApi(ctxOf(req));
    const kindsRes = await wsApi.request("GET", "/entity-kinds");
    const kindRows =
      (kindsRes.body.items as Array<{ id: string; display_name?: string; display_name_plural?: string }> | undefined) ??
      [];
    const kinds: KindWords[] = kindRows.map((k) => {
      const singular = (k.display_name ?? k.id.split(":")[1] ?? k.id).toLowerCase();
      return { id: k.id, singular, plural: (k.display_name_plural ?? `${singular}s`).toLowerCase() };
    });

    const q = readQuestionOf(body.data.message, kinds);
    if (!q) {
      // Not a question about their records — but it may be one Cobb can answer
      // from the guide ("what can you do?", "where do I scan?"). Those answers
      // are lexical and already written down, so showing one before the message
      // is sent costs nothing and saves a whole model call.
      const guide = await guideAnswerFor(db, body.data.message, !!body.data.ai_on).catch(() => null);
      res.json(guide ? { answer: guide, from: "guide" } : { answer: null });
      return;
    }

    try {
      if (q.kind === "count") {
        const label = kinds.find((k) => k.id === q.entityKind);
        // /entities returns rows, not a count, so ask for one more than the
        // cap and count them. Past the cap the honest answer is "more than",
        // never a number that is quietly the page size.
        const CAP = 500;
        const r = await wsApi.request("GET", `/entities/${encodeURIComponent(q.entityKind)}?limit=${CAP + 1}`);
        const items = (r.body as { items?: unknown[] }).items;
        if (!Array.isArray(items)) {
          res.json({ answer: null });
          return;
        }
        const over = items.length > CAP;
        const n = over ? CAP : items.length;
        // No word for the thing, no answer. readQuestionOf only matches a noun
        // it found in this workspace's own kinds, so this cannot normally
        // happen — and inventing a generic noun to fill the gap would put a
        // number next to a word the user never used.
        const noun = n === 1 && !over ? label?.singular : label?.plural;
        if (!noun) {
          res.json({ answer: null });
          return;
        }
        res.json({
          answer: `${over ? "more than " : ""}${n} ${noun}`,
          detail: over ? "too many to count from here" : "in this workspace",
        });
        return;
      }
      if (q.kind === "attention") {
        const r = await wsApi.request("GET", "/attention");
        const items = ((r.body as { items?: unknown[] }).items ?? []) as unknown[];
        res.json({
          answer: items.length === 0 ? "Nothing needs you" : `${items.length} thing${items.length === 1 ? "" : "s"} need you`,
          detail: items.length ? "open the dashboard to see them" : "nothing waiting",
        });
        return;
      }
      if (q.kind === "where") {
        const r = await wsApi.request(
          "GET",
          `/modules/core-search/search?q=${encodeURIComponent(q.name)}`,
        );
        const hits = ((r.body as { items?: Array<{ title?: string; subtitle?: string }> }).items ?? []).slice(0, 3);
        if (hits.length === 0) {
          res.json({ answer: null });
          return;
        }
        // One hit answers; several is a list, not an answer, so it says how
        // many rather than picking one.
        res.json(
          hits.length === 1
            ? { answer: hits[0]!.title ?? q.name, detail: hits[0]!.subtitle ?? "found in your workspace" }
            : { answer: `${hits.length} things match "${q.name}"`, detail: hits.map((h) => h.title).filter(Boolean).join(", ") },
        );
        return;
      }
      // low-stock: the module owns the definition of "low", so ask it — and a
      // workspace without inventory has no answer here rather than a zero,
      // which would read as "nothing is low" when nothing is even tracked.
      const r = await wsApi.request("GET", "/modules/inventory/parts?low=true&limit=50");
      const items = (r.body as { items?: Array<{ name?: string }> }).items;
      if (!Array.isArray(items)) {
        res.json({ answer: null });
        return;
      }
      res.json({
        answer: items.length === 0 ? "Nothing is low" : `${items.length} low on stock`,
        detail: items.slice(0, 3).map((i) => i.name).filter(Boolean).join(", ") || "nothing to reorder",
      });
    } catch {
      // A read that fails is not an answer. Say nothing and let the AI have it.
      res.json({ answer: null });
    }
  }),
);
