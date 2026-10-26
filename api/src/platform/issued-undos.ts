// An undo is its requester's to run, whatever their role (#5193).
//
// A run hands back the steps that put it back (actions.ts undoFor). The step
// can name an action the person holds no grant for: a member taps Use one,
// which they hold by default, and is handed inventory:restore-part, which
// restores name, place and metadata too, so it is grantedAs update-part. The
// member's Undo of their own tap was refused. Each step is kept here as it was
// issued, to the person who ran the run; that person running exactly that
// step is admitted as its requester, once. A step a person writes themselves
// matches nothing here and asks for the grant as before. A run that failed
// before it wrote anything gives the step back for a retry (#7140).

import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { meta } from "../db/meta.js";
import { changeSince, newestChangeOn } from "./activity.js";

/** How long an issued undo stays the requester's. The Undo on a card is
 *  pressed in the minutes after; a week covers a card read late. */
export const ISSUED_UNDO_DAYS = 7;

export interface IssuedStep {
  action_id: string;
  args?: Record<string, unknown> | null;
  entity_kind?: string | null;
  entity_id?: string | null;
  /** The records a run-level step puts back (ActionUndoStep.puts_back). */
  puts_back?: readonly string[] | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAMES_A_RECORD = /^(id|ids|.+_ids?|.+Ids?)$/;

/** The records a step would put back: the record it names, every record
 *  it was handed by id (`id`, `partId`, `build_id`, `ids`), whatever its
 *  action calls them, and the records it says it puts back, for a step that
 *  names a run rather than them (#8533). */
export function watchedIdsOf(step: IssuedStep): string[] {
  const ids: unknown[] = [step.entity_id, ...(step.puts_back ?? [])];
  for (const [k, v] of Object.entries(step.args ?? {})) {
    if (!NAMES_A_RECORD.test(k)) continue;
    ids.push(...(Array.isArray(v) ? v : [v]));
  }
  return [...new Set(ids.filter((v): v is string => typeof v === "string" && UUID.test(v)))];
}

/** Keep each step for the person who ran its run, with the records it puts
 *  back and the newest change it saw on them. Answers each step's id, in
 *  order: the Undo presents it, so a second press is known as one.
 *  `aiDoor`: the run came through an assistant's door, so the assistant may
 *  run the step it was handed (#7831). A step issued for a person's own run
 *  is never one their assistant presses (#7157). */
export async function issueUndos(orgId: string, userId: string, steps: readonly IssuedStep[], aiDoor = false): Promise<string[]> {
  if (!steps.length) return [];
  const rows = await Promise.all(steps.map(async (s) => {
    const watch = watchedIdsOf(s);
    return {
      org_id: orgId,
      user_id: userId,
      action_id: s.action_id,
      args: sql`${JSON.stringify(s.args ?? {})}::jsonb` as never,
      entity_kind: s.entity_kind ?? null,
      entity_id: s.entity_id ?? null,
      ai_door: aiDoor,
      watch_ids: watch,
      seen_activity_id: await newestChangeOn(orgId, watch),
    };
  }));
  const made = await meta.insertInto("issued_undos").values(rows).returning("id").execute();
  return made.map((r) => r.id);
}

export type UndoJudgement = { id: string | null } | { refusal: { status: 409; code: "undo_already_pressed" | "undo_stale"; message: string } };

const ALREADY = "This Undo was already pressed. It runs once; look at the record to see where it stands.";

/** Is this press an Undo the person was handed, and may it run? The id the
 *  Undo presents, or the unused step that is exactly this run. A step
 *  already spent is refused (an Undo runs once, #7813); one whose records
 *  someone else changed since it was issued is refused with what changed, so
 *  it never takes away their later change. Null id: not an Undo of theirs,
 *  judged as any run. Asked through an assistant's door, only a step handed
 *  through one is its Undo (#7831, #7157). */
export async function judgeUndo(orgId: string, userId: string, step: IssuedStep, presented?: string | null, aiDoor = false): Promise<UndoJudgement> {
  const row = presented
    ? await meta.selectFrom("issued_undos").selectAll().where("id", "=", presented).where("org_id", "=", orgId).where("user_id", "=", userId).where("action_id", "=", step.action_id).executeTakeFirst()
    : await matching(orgId, userId, step, aiDoor);
  if (!row || (aiDoor && !row.ai_door)) return { id: null };
  if (row.used_at) return { refusal: { status: 409, code: "undo_already_pressed", message: ALREADY } };
  const since = row.seen_activity_id == null ? null : await changeSince(orgId, { ids: row.watch_ids ?? [], after: Number(row.seen_activity_id), userId });
  if (since) return { refusal: { status: 409, code: "undo_stale", message: since } };
  return { id: row.id };
}

async function matching(orgId: string, userId: string, step: IssuedStep, aiDoor: boolean) {
  let q = meta
    .selectFrom("issued_undos")
    .selectAll()
    .where("org_id", "=", orgId)
    .where("user_id", "=", userId)
    .where("action_id", "=", step.action_id)
    .where("used_at", "is", null)
    .where("created_at", ">", new Date(Date.now() - ISSUED_UNDO_DAYS * 86_400_000))
    .where(sql<boolean>`args = ${JSON.stringify(step.args ?? {})}::jsonb`)
    .where(sql<boolean>`entity_kind is not distinct from ${step.entity_kind ?? null}`)
    .where(sql<boolean>`entity_id is not distinct from ${step.entity_id ?? null}`);
  if (aiDoor) q = q.where("ai_door", "=", true);
  return q.orderBy("created_at", "desc").limit(1).executeTakeFirst();
}

/** Spend it before it runs: an undo is run once, and a second press while
 *  the first runs finds it spent. False when another press spent it first. */
export async function spendIssuedUndo(id: string): Promise<boolean> {
  const r = await meta.updateTable("issued_undos").set({ used_at: new Date() }).where("id", "=", id).where("used_at", "is", null).executeTakeFirst();
  return Number(r.numUpdatedRows) > 0;
}

/** Give it back: its run failed before it wrote anything, so it is still the
 *  requester's to retry (#7140). Never called for a run that may have written,
 *  since running that step again could apply it twice. */
export async function returnIssuedUndo(id: string): Promise<void> {
  await meta.updateTable("issued_undos").set({ used_at: null }).where("id", "=", id).execute();
}

export function registerIssuedUndosSweep(): void {
  platform().sweeps.register({
    name: "platform.issued-undos",
    everyMs: 6 * 60 * 60 * 1000,
    drainMs: 60_000,
    visit: async ({ orgId, now }) => {
      await meta
        .deleteFrom("issued_undos")
        .where("org_id", "=", orgId)
        .where((eb) => eb.or([eb("used_at", "is not", null), eb("created_at", "<", new Date(now.getTime() - ISSUED_UNDO_DAYS * 86_400_000))]))
        .execute();
    },
  });
}
