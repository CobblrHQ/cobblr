// What a sync of an outside system's records does to a record the person has
// edited in Cobblr, and which of their records a source record is. One rule
// for the live run, the poll, the import and the dry run, so what the dry run
// says is what the run does.
//
// The owner treats Cobblr as the source of truth, and the source (his Workshop
// OS) as a mirror kept in step by hand. His MACHINES section imported rows that
// already existed as duplicates and wrote over edits made in Cobblr, so he
// paused it (#6336). Two rules close that:
//
//  1. A field is merged three ways. The base is what the sync remembers of its
//     last run (what the source said, and what the record held once it wrote),
//     `theirs` is what the source says now, `ours` what the record holds. A
//     field the person changed since the last sync (the record no longer holds
//     what the sync left) is theirs to keep: under "Cobblr wins" (the default) it is never
//     written over, under "source wins" it is, under "ask" it is kept and
//     listed until it is settled. A field the person did not change takes the
//     source's new value.
//  2. A source record is the Cobblr record it already is: its stored id, then
//     its source id on the record, then one record of the same name and kind.
//     A name that is only nearly the same, or two of the same name, is asked
//     about; never linked on a guess and never duplicated.

export type ConflictPolicy = "cobblr" | "source" | "ask";
export const CONFLICT_POLICIES: readonly ConflictPolicy[] = ["cobblr", "source", "ask"];
export const DEFAULT_CONFLICT_POLICY: ConflictPolicy = "cobblr";

/** The words a person reads for each rule, in the order they are offered. */
export const CONFLICT_POLICY_LABELS: Record<ConflictPolicy, string> = {
  cobblr: "Cobblr wins",
  source: "The source wins",
  ask: "Ask me",
};

export function conflictPolicyOf(v: unknown): ConflictPolicy {
  return v === "source" || v === "ask" || v === "cobblr" ? v : DEFAULT_CONFLICT_POLICY;
}

/** Fields as one flat map: a metadata key is the field `metadata.<key>`. */
export type FieldMap = Record<string, unknown>;

export function flattenFields(fields: Record<string, unknown>): FieldMap {
  const out: FieldMap = {};
  for (const [k, v] of Object.entries(fields)) {
    if (k === "metadata" && v && typeof v === "object" && !Array.isArray(v)) {
      for (const [mk, mv] of Object.entries(v as Record<string, unknown>)) out[`metadata.${mk}`] = mv;
    } else out[k] = v;
  }
  return out;
}

/** The inverse, for the writer: the flat keys to write as a fields object,
 *  with the metadata keys laid over the record's CURRENT metadata, so a key
 *  the sync does not manage (a field the person added) is never dropped by a
 *  writer that stores metadata whole. No metadata key written, none sent. */
export function nestWrite(write: FieldMap, currentMetadata: Record<string, unknown> | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const meta: Record<string, unknown> = {};
  let touched = false;
  for (const [k, v] of Object.entries(write)) {
    if (k.startsWith("metadata.")) {
      meta[k.slice("metadata.".length)] = v;
      touched = true;
    } else out[k] = v;
  }
  if (touched) out.metadata = { ...(currentMetadata ?? {}), ...meta };
  return out;
}

const isEmpty = (v: unknown): boolean => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

/** Two values that mean the same: null, undefined and "" are one; 5 and "5"
 *  are one; objects compare by content. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (isEmpty(a) && isEmpty(b)) return true;
  if (isEmpty(a) || isEmpty(b)) return false;
  if (typeof a === "object" || typeof b === "object") return JSON.stringify(a) === JSON.stringify(b);
  const na = Number(a);
  const nb = Number(b);
  if (typeof a !== "boolean" && typeof b !== "boolean" && String(a).trim() !== "" && String(b).trim() !== "" && Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  return String(a) === String(b);
}

export interface FieldChange {
  field: string;
  /** What the record holds. */
  ours: unknown;
  /** What the source says. */
  theirs: unknown;
  /** write: the source's value is written. keep: Cobblr's is kept and the
   *  run moves on. ask: Cobblr's is kept and the person is asked. */
  decision: "write" | "keep" | "ask";
}

/** What the sync remembers about a record from its last run, per field:
 *  `source` is what the source last said, `left` what the record held right
 *  after the sync wrote it (as the writer reads it back, so a value stored in
 *  another shape is no false edit). A field is "changed in Cobblr" when the
 *  record no longer holds what the sync left; "changed at the source" when
 *  the source no longer says what it said. */
export interface MergeBase {
  source: FieldMap;
  left: FieldMap;
}

export interface MergeResult {
  /** The flat fields to write (the source's values that win). */
  write: FieldMap;
  /** Every field the two sides disagreed about, and what was decided. */
  changes: FieldChange[];
  /** What the source said, to remember for the next three-way. */
  nextSource: FieldMap;
  /** The fields whose `left` is to be refreshed from the record once the write
   *  is done (written, or already equal). A kept or asked field is not: it
   *  stays "changed in Cobblr" until the person settles it. */
  settled: string[];
}

export function mergeFields(args: { ours: FieldMap | null; theirs: FieldMap; base: MergeBase | null; policy: ConflictPolicy }): MergeResult {
  const { ours, theirs, base, policy } = args;
  const write: FieldMap = {};
  const changes: FieldChange[] = [];
  const nextSource: FieldMap = { ...(base?.source ?? {}) };
  const settled: string[] = [];
  for (const [field, t] of Object.entries(theirs)) {
    const o = ours?.[field];
    const hasSource = !!base && field in base.source;
    const hasLeft = !!base && field in base.left;
    if (sameValue(o, t)) {
      nextSource[field] = t;
      settled.push(field);
      continue;
    }
    if (hasSource && sameValue(t, base!.source[field])) continue; // the source did not change it; Cobblr's own change stands
    if (isEmpty(o) || (hasLeft && sameValue(o, base!.left[field]))) {
      write[field] = t; // nothing of the person's to protect
      nextSource[field] = t;
      settled.push(field);
      changes.push({ field, ours: o ?? null, theirs: t, decision: "write" });
      continue;
    }
    // Changed in Cobblr (or filled in before the sync ever looked) and the source says otherwise.
    if (policy === "source") {
      write[field] = t;
      nextSource[field] = t;
      settled.push(field);
      changes.push({ field, ours: o ?? null, theirs: t, decision: "write" });
    } else if (policy === "ask") {
      changes.push({ field, ours: o ?? null, theirs: t, decision: "ask" }); // nothing is remembered: asked again until settled
    } else {
      nextSource[field] = t;
      changes.push({ field, ours: o ?? null, theirs: t, decision: "keep" });
    }
  }
  return { write, changes, nextSource, settled };
}

// ── identity ──

export interface MatchCandidate {
  id: string;
  name: string;
  kind?: string | null;
  instance?: string | null;
  /** Where it sits (null: at the top). Absent: the writer does not say. */
  parentId?: string | null;
}

export interface MatchProbe {
  name: string;
  kind?: string | null;
  instance?: string | null;
  /** Where the source record would sit, when that is known (null: at the
   *  top). Absent: not known yet, so a place of any parent may be it. */
  parentId?: string | null;
}

/** A name compared exactly, apart from case and spacing. "Prusa MINI" and
 *  "Prusa MINI+" are two printers. */
export function exactName(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** A name compared loosely: punctuation and spacing ignored, so the two
 *  printers above read as the same. Only ever a reason to ask. */
export function nearName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

const sameKnown = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !a || !b || a.trim().toLowerCase() === b.trim().toLowerCase();

export type Identity = { link: string } | { ask: string[] } | { none: true };

/** Which existing record a source record is: exactly one of the same name,
 *  kind and instance (when both sides know theirs) links; a name only nearly
 *  the same, or several of the same, are asked about; else it is new. */
export function identityOf(probe: MatchProbe, candidates: readonly MatchCandidate[]): Identity {
  const fits = candidates.filter(
    (c) =>
      sameKnown(probe.kind, c.kind) &&
      sameKnown(probe.instance, c.instance) &&
      (probe.parentId === undefined || c.parentId === undefined || probe.parentId === c.parentId),
  );
  const want = exactName(probe.name);
  if (!want) return { none: true };
  const exact = fits.filter((c) => exactName(c.name) === want);
  if (exact.length === 1) return { link: exact[0]!.id };
  if (exact.length > 1) return { ask: exact.map((c) => c.id) };
  const loose = nearName(probe.name);
  const near = loose ? fits.filter((c) => nearName(c.name) === loose) : [];
  return near.length ? { ask: near.map((c) => c.id) } : { none: true };
}
