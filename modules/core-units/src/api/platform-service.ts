// core-units registers the platform().units service — the ONE place unit
// resolution + conversion run server-side (scripts/lint-unit-conversion.ts
// forbids the math anywhere else). Resolution folds in the org's custom
// units, same as the HTTP surface; conversion is the catalog's own
// convertQuantity. Consumers reach this ONLY through the platform contract —
// no module ever imports core-units.

import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { CoreUnitsDB } from "../db.js";
import { BUILTIN_UNITS, convertQuantity, resolveUnit, type UnitDef } from "../units-catalog.js";

let registered = false;

async function orgUnits(orgId: string): Promise<UnitDef[]> {
  try {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<CoreUnitsDB>;
    const custom = await db.selectFrom("core_units_custom").selectAll().execute();
    return custom.map((c) => ({
      code: c.code,
      symbol: c.symbol,
      name: c.name,
      plural: c.plural ?? c.name,
      category: (c.category ?? "count") as UnitDef["category"],
    }));
  } catch {
    return [];
  }
}

export function registerUnitsService(): void {
  if (registered) return;
  registered = true;
  platform().units.registerService({
    async resolve(orgId, raw) {
      const def = resolveUnit(raw, await orgUnits(orgId));
      if (!def) return null;
      return {
        code: def.code,
        symbol: def.symbol,
        name: def.name,
        plural: def.plural,
        category: def.category,
        ...(def.factor != null ? { factor: def.factor } : {}),
      };
    },
    async convert(orgId, value, fromRaw, toRaw) {
      if (!Number.isFinite(value)) return null;
      const extra = await orgUnits(orgId);
      const from = resolveUnit(fromRaw, extra);
      const to = resolveUnit(toRaw, extra);
      const out = convertQuantity(value, from, to);
      // convertQuantity returns null for same-code (nothing to do) — for the
      // service that's a valid identity conversion, not a failure.
      if (out == null && from && to && from.code === to.code) return value;
      return out;
    },
  });
}
