// A fact about a model is filled into every row of that model (#6013).
//
// Two Bambu Lab P1Ps waited in the owner's inbox, bought from different
// sellers. Each was read by its own model call, and each call chose which
// facts it knew about a P1P: one said the bed is 250 × 250, the other did not
// mention it. A fact about the model is not a matter of which call a row got.
//
// So the workspace keeps what it has learned about each model, in one place
// (core_scan_model_facts, keyed by the table and the model's name), and every
// row of that model reads it: a new row fills its empty model fields from it,
// and a fact learned from one row is filled into the rows already waiting.
// What a person typed is never replaced, and a fact about the unit (its
// seller, serial, price, the day it was bought, what was upgraded on it)
// never leaves its own row: only a field whose scope is "model" moves
// (contract fact-scope.ts, the rule the barcode network reads too).
//
// Which values are learned: a field that DECLARES itself a model fact, from
// any source, a person's value over any other; a field that only reads as
// one (no declaration) only when the model reader said it knew the value from
// the model ("Filled from catalog knowledge"), never a guess from a photo.

import type { ColumnType, Kysely } from "kysely";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { declaredFactScope, factScopeOf, modelKeyOf, type ScopedFieldDef } from "@cobblr/platform-contract/fact-scope";

export type FactValue = string | number | boolean;

export interface ModelFactCandidate {
  kind?: unknown;
  fields?: Record<string, unknown>;
  inferred?: unknown;
}

export interface KnownFact {
  value: FactValue;
  /** "person" outranks every other source; the rest keep the first value. */
  source: "person" | "declared" | "inferred";
}

const empty = (v: unknown) => v === undefined || v === null || (typeof v === "string" && !v.trim());
const asFact = (v: unknown): FactValue | null =>
  typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) ? v : typeof v === "string" && v.trim() && v.length <= 120 ? v.trim() : null;

/** The facts about the model a row teaches: its top candidate's model-scope
 *  values, and what a person typed into a declared model field. Pure. */
export function factsTaughtBy(opts: {
  defs: readonly ScopedFieldDef[];
  candidate: ModelFactCandidate | undefined;
  provenance: Record<string, { by?: string; from?: string } | undefined> | null;
  personValues: Record<string, unknown> | null;
}): Map<string, KnownFact> {
  const out = new Map<string, KnownFact>();
  const inferred = new Set(Array.isArray(opts.candidate?.inferred) ? (opts.candidate!.inferred as unknown[]).filter((x): x is string => typeof x === "string") : []);
  for (const def of opts.defs) {
    if (factScopeOf(def) !== "model") continue;
    const declared = declaredFactScope(def) === "model";
    const typed = declared ? asFact(opts.personValues?.[def.name]) : null;
    if (typed !== null) {
      out.set(def.name, { value: typed, source: "person" });
      continue;
    }
    const v = asFact(opts.candidate?.fields?.[def.name]);
    if (v === null) continue;
    const stamp = opts.provenance?.[def.name];
    const fromModel = inferred.has(def.name) || (stamp?.by === "inference" && stamp.from === "model");
    if (declared && stamp?.by !== "person") out.set(def.name, { value: v, source: "declared" });
    else if (fromModel) out.set(def.name, { value: v, source: "inferred" });
  }
  return out;
}

/** Fill a candidate's EMPTY model fields from what is known about its model,
 *  never a field a person gave a value. Returns the names it filled. Pure;
 *  mutates the candidate. */
export function fillFromModelFacts(
  candidate: ModelFactCandidate,
  defs: readonly ScopedFieldDef[],
  known: ReadonlyMap<string, KnownFact>,
  personValues: Record<string, unknown> | null,
): string[] {
  const filled: string[] = [];
  const fields = (candidate.fields ??= {});
  for (const def of defs) {
    if (factScopeOf(def) !== "model") continue;
    const fact = known.get(def.name);
    if (!fact || !empty(fields[def.name]) || !empty(personValues?.[def.name])) continue;
    fields[def.name] = fact.value;
    filled.push(def.name);
  }
  return filled;
}

// ── the workspace's store ────────────────────────────────────────────────

interface ModelFactsDB {
  core_scan_model_facts: {
    kind: string;
    model_key: string;
    field: string;
    value: ColumnType<unknown, string, string>;
    source: string;
    from_item_id: string | null;
    updated_at: ColumnType<Date, Date | undefined, Date | undefined>;
  };
  core_scan_inbox_items: { id: string; status: string; suggested_name: string | null; suggested_candidates: unknown; suggested_metadata: unknown };
}

type MetaDb = Kysely<{
  module_field_defs: { org_id: string; entity_kind: string; name: string; type: string; field_role: string | null; fact_scope: string | null };
}>;

/** A table's own fields with their declared scope. */
export async function scopedFieldsOf(orgId: string, kind: string): Promise<ScopedFieldDef[]> {
  const meta = platform().db.meta as unknown as MetaDb;
  return meta
    .selectFrom("module_field_defs")
    .select(["name", "type", "field_role", "fact_scope"])
    .where("org_id", "=", orgId)
    .where("entity_kind", "=", kind)
    .execute();
}

export async function readModelFacts(db: Kysely<ModelFactsDB>, kind: string, key: string): Promise<Map<string, KnownFact>> {
  const rows = await db.selectFrom("core_scan_model_facts").select(["field", "value", "source"]).where("kind", "=", kind).where("model_key", "=", key).execute();
  const out = new Map<string, KnownFact>();
  for (const r of rows) {
    const v = asFact(r.value);
    if (v !== null) out.set(r.field, { value: v, source: r.source as KnownFact["source"] });
  }
  return out;
}

/** Keep what a row taught: a person's value replaces any other, every other
 *  source keeps the value the model already has. Returns the facts that are
 *  new or changed. */
export async function recordModelFacts(db: Kysely<ModelFactsDB>, kind: string, key: string, taught: ReadonlyMap<string, KnownFact>, itemId: string): Promise<string[]> {
  const changed: string[] = [];
  for (const [field, fact] of taught) {
    const written = await db
      .insertInto("core_scan_model_facts")
      .values({ kind, model_key: key, field, value: JSON.stringify(fact.value), source: fact.source, from_item_id: itemId, updated_at: new Date() })
      .onConflict((oc) =>
        oc
          .columns(["kind", "model_key", "field"])
          .doUpdateSet((eb) => ({
            value: eb.ref("excluded.value"),
            source: eb.ref("excluded.source"),
            from_item_id: eb.ref("excluded.from_item_id"),
            updated_at: eb.ref("excluded.updated_at"),
          }))
          .where(sql<boolean>`${fact.source === "person"} and core_scan_model_facts.value is distinct from excluded.value`),
      )
      .returning("field")
      .executeTakeFirst();
    if (written) changed.push(field);
  }
  return changed;
}

const FILLED_STAMP = { by: "inference", from: "model" } as const;

/** Fill what is known about a model into every OTHER pending row of it,
 *  empty fields only, on the candidates routed to that table. Returns how
 *  many rows it changed. */
export async function spreadModelFacts(
  db: Kysely<ModelFactsDB>,
  opts: { kind: string; key: string; defs: readonly ScopedFieldDef[]; known: ReadonlyMap<string, KnownFact>; exceptId?: string },
): Promise<number> {
  if (!opts.known.size) return 0;
  const rows = await db
    .selectFrom("core_scan_inbox_items")
    .select(["id", "suggested_name", "suggested_candidates", "suggested_metadata"])
    .where("status", "=", "pending")
    .where("suggested_name", "is not", null)
    .execute();
  let changed = 0;
  for (const r of rows) {
    if (r.id === opts.exceptId || modelKeyOf(r.suggested_name) !== opts.key) continue;
    const candidates = Array.isArray(r.suggested_candidates) ? (r.suggested_candidates as ModelFactCandidate[]) : [];
    const person = personValuesOf(r.suggested_metadata);
    const filled = new Set<string>();
    for (const c of candidates) if (c && typeof c === "object" && c.kind === opts.kind) for (const f of fillFromModelFacts(c, opts.defs, opts.known, person)) filled.add(f);
    if (!filled.size) continue;
    const stamps = Object.fromEntries([...filled].map((f) => [f, FILLED_STAMP]));
    await db
      .updateTable("core_scan_inbox_items")
      .set({
        // jsonb-replace-ok: the row's own candidate list, re-read just above and changed only in empty fields
        suggested_candidates: JSON.stringify(candidates) as never,
        suggested_metadata: sql`coalesce(suggested_metadata, '{}'::jsonb) || jsonb_build_object('field_provenance', coalesce(suggested_metadata->'field_provenance', '{}'::jsonb) || ${JSON.stringify(stamps)}::jsonb)` as never,
      })
      .where("id", "=", r.id)
      .where("status", "=", "pending")
      .execute();
    changed++;
  }
  return changed;
}

/** What a person typed for the row, by field name. */
export function personValuesOf(meta: unknown): Record<string, unknown> | null {
  const uf = (meta as { user_fields?: { values?: unknown } } | null)?.user_fields?.values;
  return uf && typeof uf === "object" && !Array.isArray(uf) ? (uf as Record<string, unknown>) : null;
}

/** The match's pass: fill this row's empty model facts from what the
 *  workspace knows, learn what this row teaches, and fill that into the
 *  model's other waiting rows. Stamps what it filled into `provenance`. */
export async function applyModelFacts(
  orgId: string,
  db: Kysely<ModelFactsDB>,
  opts: {
    itemId: string;
    name: string | null;
    candidates: ModelFactCandidate[];
    provenance: Record<string, unknown>;
    meta: unknown;
  },
): Promise<{ filled: string[]; learned: string[]; spread: number }> {
  const key = modelKeyOf(opts.name);
  const top = opts.candidates[0];
  const kind = typeof top?.kind === "string" ? top.kind : null;
  if (!key || !kind) return { filled: [], learned: [], spread: 0 };
  const defs = await scopedFieldsOf(orgId, kind);
  if (!defs.some((d) => factScopeOf(d) === "model")) return { filled: [], learned: [], spread: 0 };
  const person = personValuesOf(opts.meta);
  const taught = factsTaughtBy({ defs, candidate: top, provenance: opts.provenance as never, personValues: person });
  const learned = await recordModelFacts(db, kind, key, taught, opts.itemId);
  const known = await readModelFacts(db, kind, key);
  const filled = fillFromModelFacts(top!, defs, known, person);
  for (const f of filled) opts.provenance[f] = FILLED_STAMP;
  const spread = learned.length ? await spreadModelFacts(db, { kind, key, defs, known, exceptId: opts.itemId }) : 0;
  return { filled, learned, spread };
}
