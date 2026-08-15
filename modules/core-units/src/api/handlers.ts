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

export function registerUnitsHandlers(): void {
  platform().actions.registerHandler("core-units.add-unit", async (ctx) => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    // A model will happily send "Fathom" or "fathoms" for a code the route
    // requires to be lowercase and hyphenated; normalising here is kinder than
    // bouncing the proposal back to the user with a regex.
    const raw = {
      code: typeof args.code === "string" ? args.code.trim().toLowerCase().replace(/\s+/g, "-") : "",
      symbol: typeof args.symbol === "string" ? args.symbol.trim() : "",
      name: typeof args.name === "string" ? args.name.trim() : "",
      ...(typeof args.plural === "string" && args.plural.trim() ? { plural: args.plural.trim() } : {}),
      ...(typeof args.category === "string" && args.category.trim()
        ? { category: args.category.trim().toLowerCase() }
        : {}),
    };
    const parsed = CustomUnit.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
    }
    const builtin = BUILTIN_UNITS.find((u) => u.code === parsed.data.code);
    if (builtin) {
      // Not a failure worth alarming anyone about — they asked for something
      // they already have, so say what they have.
      return {
        ok: false,
        error: `"${parsed.data.code}" is already a built-in unit (${builtin.name}) — it can be used as-is.`,
      };
    }

    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<CoreUnitsDB>;
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
      data: { code: row.code, symbol: row.symbol, name: row.name, category: row.category },
    };
  });
}
