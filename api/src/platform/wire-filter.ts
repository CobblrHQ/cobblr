// Wire conditions (backlog B7 — the schema's `filter` column, finally real).
//
// A wire may carry a CONDITION: a small structured predicate evaluated per
// firing against the SAME data the wire's template sees (the target entity's
// fields at the top level + the `event.*` block). All conditions must hold
// (AND); a wire with no filter always fires — full backward compatibility.
//
// Deliberately structured, not an expression language: `{ all: [{path, op,
// value}] }` is validatable at write time, composable in the /bindings UI,
// safe against injection, and AI-emittable. If real use outgrows AND-of-
// comparisons, add `any:[...]` — don't reach for a parser.
//
//   { "all": [ { "path": "event.newQty", "op": "lte", "value": 5 },
//              { "path": "material",     "op": "eq",  "value": "PLA" } ] }
//
// Ops: eq neq lt lte gt gte contains not_contains empty not_empty.
// Comparison is numeric when BOTH sides parse as numbers, else string
// (case-insensitive for eq/neq/contains). A missing path is `empty`.

import { z } from "zod";

export const WireConditionSchema = z.object({
  path: z.string().min(1).max(200),
  op: z.enum(["eq", "neq", "lt", "lte", "gt", "gte", "contains", "not_contains", "empty", "not_empty"]),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
});
export const WireFilterSchema = z.object({
  all: z.array(WireConditionSchema).min(1).max(10),
});
export type WireFilter = z.infer<typeof WireFilterSchema>;

/** Parse an unknown `filter` payload. null/undefined/{} → null (no filter);
 *  a malformed shape → an Error message the caller can 400 with. */
export function parseWireFilter(raw: unknown): { filter: WireFilter | null; error?: string } {
  if (raw == null) return { filter: null };
  if (typeof raw === "object" && Object.keys(raw as object).length === 0) return { filter: null };
  const parsed = WireFilterSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      filter: null,
      error: `Bad wire filter: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    };
  }
  return { filter: parsed.data };
}

function resolvePath(data: Record<string, unknown>, key: string): unknown {
  const parts = key.split(".");
  let cur: unknown = data;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function norm(v: unknown): string {
  return String(v ?? "").trim().toLowerCase();
}

function checkOne(actual: unknown, op: WireFilter["all"][number]["op"], expected: unknown): boolean {
  switch (op) {
    case "empty":
      return isEmpty(actual);
    case "not_empty":
      return !isEmpty(actual);
    case "contains":
      return norm(actual).includes(norm(expected));
    case "not_contains":
      return !norm(actual).includes(norm(expected));
    default: {
      const an = asNumber(actual);
      const en = asNumber(expected);
      if (an !== null && en !== null) {
        switch (op) {
          case "eq": return an === en;
          case "neq": return an !== en;
          case "lt": return an < en;
          case "lte": return an <= en;
          case "gt": return an > en;
          case "gte": return an >= en;
        }
      }
      const as = norm(actual);
      const es = norm(expected);
      switch (op) {
        case "eq": return as === es;
        case "neq": return as !== es;
        // Ordering on non-numeric strings: lexicographic — rarely what a
        // user means, but deterministic and never a crash.
        case "lt": return as < es;
        case "lte": return as <= es;
        case "gt": return as > es;
        case "gte": return as >= es;
      }
    }
  }
}

/** Evaluate a (pre-parsed) filter against the wire's template data.
 *  No filter → fire. Any failed condition → skip. */
export function passesWireFilter(filter: WireFilter | null, data: Record<string, unknown>): boolean {
  if (!filter) return true;
  return filter.all.every((c) => checkOne(resolvePath(data, c.path), c.op, c.value));
}
