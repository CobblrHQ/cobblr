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

/** How long an issued undo stays the requester's. The Undo on a card is
 *  pressed in the minutes after; a week covers a card read late. */
export const ISSUED_UNDO_DAYS = 7;

export interface IssuedStep {
  action_id: string;
  args?: Record<string, unknown> | null;
  entity_kind?: string | null;
  entity_id?: string | null;
}

export async function issueUndos(orgId: string, userId: string, steps: readonly IssuedStep[]): Promise<void> {
  if (!steps.length) return;
  await meta
    .insertInto("issued_undos")
    .values(steps.map((s) => ({
      org_id: orgId,
      user_id: userId,
      action_id: s.action_id,
      args: sql`${JSON.stringify(s.args ?? {})}::jsonb` as never,
      entity_kind: s.entity_kind ?? null,
      entity_id: s.entity_id ?? null,
    })))
    .execute();
}

/** The unused step this person was issued that is exactly this run, if any. */
export async function issuedUndoFor(orgId: string, userId: string, step: IssuedStep): Promise<string | null> {
  const row = await meta
    .selectFrom("issued_undos")
    .select("id")
    .where("org_id", "=", orgId)
    .where("user_id", "=", userId)
    .where("action_id", "=", step.action_id)
    .where("used_at", "is", null)
    .where("created_at", ">", new Date(Date.now() - ISSUED_UNDO_DAYS * 86_400_000))
    .where(sql<boolean>`args = ${JSON.stringify(step.args ?? {})}::jsonb`)
    .where(sql<boolean>`entity_kind is not distinct from ${step.entity_kind ?? null}`)
    .where(sql<boolean>`entity_id is not distinct from ${step.entity_id ?? null}`)
    .orderBy("created_at", "desc")
    .limit(1)
    .executeTakeFirst();
  return row?.id ?? null;
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
