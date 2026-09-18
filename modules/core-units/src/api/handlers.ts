// core-units:add-unit — the AI-reachable form of POST /units.
//
// Configuration was the largest blind spot the 2026-08-14 reach audit found:
// a workspace's whole setup was unreachable because a config page is not a
// record, so "declare your entity kinds" never applied to it. A workspace-
// scoped ACTION is the repo's answer (labels:set-code is the precedent) — it
// rides the generic invoke_action rail, so it inherits the confirm gate, the
// permission check and the change ledger without a bespoke tool.
//
// It shares CustomUnit + BUILTIN_UNITS with the HTTP route, so the shadowing
// rule and the code format cannot mean one thing when a person adds a unit and
// another when the assistant does.

import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import { CustomUnit } from "./units.js";
import type { CoreUnitsDB } from "../db.js";
import { BUILTIN_UNITS } from "../units-catalog.js";

/** The unit the arguments describe, read the same way for the plan and the
 *  run. A model will happily send "Fathom" or "fathoms" for a code the route
 *  requires to be lowercase and hyphenated; normalising here is kinder than
 *  bouncing the proposal back to the user with a regex. */
function readUnitArgs(args: Record<string, unknown>): { unit: ReturnType<typeof CustomUnit.parse> } | { error: string } {
  const raw = {
    code: typeof args.code === "string" ? args.code.trim().toLowerCase().replace(/\s+/g, "-") : "",
    symbol: typeof args.symbol === "string" ? args.symbol.trim() : "",
    name: typeof args.name === "string" ? args.name.trim() : "",
    ...(typeof args.plural === "string" && args.plural.trim() ? { plural: args.plural.trim() } : {}),
    ...(typeof args.category === "string" && args.category.trim() ? { category: args.category.trim().toLowerCase() } : {}),
  };
  const parsed = CustomUnit.safeParse(raw);
  if (!parsed.success) {
    return { error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }
  const builtin = BUILTIN_UNITS.find((u) => u.code === parsed.data.code);
  if (builtin) {
    // Not a failure worth alarming anyone about — they asked for something
    // they already have, so say what they have.
    return { error: `"${parsed.data.code}" is already a built-in unit (${builtin.name}) — it can be used as-is.` };
  }
  return { unit: parsed.data };
}

export function registerUnitsHandlers(): void {
  registerUndos();
  // "we measure filament in spools", before the card: the unit as it would
  // be added, or why it cannot be (#3123).
  platform().actions.registerPlanner("core-units.add-unit", async (ctx) => {
    const read = readUnitArgs((ctx.args ?? {}) as Record<string, unknown>);
    if ("error" in read) return { error: read.error };
    const u = read.unit;
    return {
      title: `Add the unit ${u.name} (${u.symbol})`,
      lines: [`code: ${u.code}`, ...(u.plural ? [`several: ${u.plural}`] : []), ...(u.category ? [`measures: ${u.category}`] : [])],
    };
  });
  platform().actions.registerHandler("core-units.add-unit", async (ctx) => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const read = readUnitArgs(args);
    if ("error" in read) return { ok: false, error: read.error };
    const parsed = { data: read.unit };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<CoreUnitsDB>;
    const existedBefore = !!(await db.selectFrom("core_units_custom").select("code").where("code", "=", parsed.data.code).executeTakeFirst());

    const row = await db
      .insertInto("core_units_custom")
      .values({
        code: parsed.data.code,
        symbol: parsed.data.symbol,
        name: parsed.data.name,
        plural: parsed.data.plural ?? parsed.data.name,
        category: parsed.data.category ?? "count",
      })
      .onConflict((oc) =>
        oc.column("code").doUpdateSet({
          symbol: parsed.data.symbol,
          name: parsed.data.name,
          plural: parsed.data.plural ?? parsed.data.name,
          category: parsed.data.category ?? "count",
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();

    return {
      ok: true,
      summary: `${row.name} (${row.symbol}) can now be used as a unit`,
      data: { code: row.code, symbol: row.symbol, name: row.name, category: row.category, existed: existedBefore },
    };
  });
}

function registerUndos(): void {
  platform().actions.registerHandler("core-units.remove-unit", async (ctx) => {
    const code = String((ctx.args as { code?: unknown } | null)?.code ?? "").trim().toLowerCase();
    if (!code) return { ok: false, error: "missing code" };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<CoreUnitsDB>;
    const row = await db.deleteFrom("core_units_custom").where("code", "=", code).returning(["code", "name"]).executeTakeFirst();
    if (!row) return { ok: true, skipped: true, reason: "already gone" };
    return { ok: true, summary: `${row.name} is no longer a unit here.`, removed: row.code };
  });
  // A unit that already existed was updated in place, which this cannot put
  // back exactly, so it hands back nothing; one this run made is removed.
  platform().actions.registerUndo("core-units.add-unit", (result) => {
    const d = (result as { ok?: unknown; data?: { code?: unknown; existed?: unknown } } | null);
    if (d?.ok !== true || typeof d.data?.code !== "string" || d.data.existed) return null;
    return { action_id: "core-units:remove-unit", args: { code: d.data.code } };
  });
}
