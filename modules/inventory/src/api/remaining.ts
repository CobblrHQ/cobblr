// What is left of each record, attached where every reader gets it: the
// entity resolver, which views, search and the assistant all read through.
// Worked out once, by consumption-gauge.ts, from the running balance (the
// unopened count and each open unit's remainder), never from a "full" figure.
// The assistant said 200 m remaining of a yarn the page showed at 160 m,
// because the record it was handed carried the capacity of one skein and no
// balance at all (#3651).

import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { remainingOf, type Remaining, type UnitLens } from "@cobblr/platform-contract/consumption-gauge";
import type { InventoryDB } from "../db.js";
import { capacitySourceField, consumptionUnitOf } from "../consumption-unit.js";
import { openUnitsFor } from "../on-hand.js";

interface Row {
  id: string;
  qty: string;
  unit: string;
  instance: string;
  metadata: unknown;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** A vocabulary lens for the units these rows name, asked of core-units once
 *  through the platform (never a table here, never a factor). */
async function lensFor(orgId: string, raws: Iterable<string | null>): Promise<UnitLens> {
  const infos = new Map<string, { code: string; measure: boolean }>();
  for (const raw of new Set([...raws].filter((r): r is string => !!r && !!r.trim()))) {
    const info = await platform().units.resolve(orgId, raw);
    if (info) infos.set(raw, { code: info.code, measure: info.category !== "count" && info.factor != null });
  }
  return {
    code: (raw) => (raw ? infos.get(raw)?.code ?? null : null),
    isMeasure: (raw) => (raw ? infos.get(raw)?.measure ?? false : false),
    // Open units are reported in the kind's own consumption unit, so the
    // remainder never needs converting here; a pair that would is not totalled.
    convert: () => null,
  };
}

/** Each row's remaining, keyed by id. Best-effort: a failure leaves the map
 *  empty and the record carries no `remaining`, never a guessed one. */
export async function remainingFor(orgId: string, db: Kysely<InventoryDB>, rows: readonly Row[]): Promise<Map<string, Remaining>> {
  const out = new Map<string, Remaining>();
  if (rows.length === 0) return out;
  try {
    const open = await openUnitsFor(db, rows.map((r) => r.id));
    const byKind = new Map<string, Row[]>();
    for (const r of rows) {
      const kind = r.instance && r.instance !== "inventory" ? `${r.instance}:item` : "inventory:part";
      byKind.set(kind, [...(byKind.get(kind) ?? []), r]);
    }
    for (const [kind, kindRows] of byKind) {
      const defs = await platform().entities.fieldsFor(orgId, kind).catch(() => []);
      const capUnit = consumptionUnitOf(defs as Parameters<typeof consumptionUnitOf>[0]);
      const capDef = (defs as Array<{ name: string; template?: string | null }>).find((d) => d.name === "capacity");
      const source = capacitySourceField(capDef?.template ?? null);
      const lens = await lensFor(orgId, [capUnit, ...kindRows.map((r) => r.unit)]);
      for (const r of kindRows) {
        const meta = (r.metadata ?? {}) as Record<string, unknown>;
        const capacity = (source ? num(meta[source]) : null) ?? num(meta.capacity);
        const units = (open.get(r.id) ?? []).map((u) => ({ value: u.qty, unit: capUnit ?? u.unit }));
        out.set(r.id, remainingOf({ qty: Number(r.qty), unit: r.unit, capacity, capacityUnit: capUnit, open: units }, lens));
      }
    }
  } catch (err) {
    console.warn("[inventory] remaining unavailable:", (err as Error).message);
  }
  return out;
}
