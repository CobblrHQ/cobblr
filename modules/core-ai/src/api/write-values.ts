// Every value a write will set, on the card that asks for it (#3658).
//
// "Add a spare desk fan to my bedroom. I paid $24" became a card that said
// only `Create a Home Inventory: “Desk fan”`. Confirming it saved a quantity,
// a room, Paid 24 and a Replacement value of 24 that nobody had said. A
// person is asked to approve what they cannot see, and the one value Cobb
// invented is exactly the one they would have wanted to catch.
//
// So a create or an update carries its values: each field it will set, by
// the label the record's form uses, what it will be (and, for an update,
// what it was), and whether the person's own words gave it. A value they did
// not give is marked as Cobb's suggestion and can be taken off before
// Confirm. The values come from the call's own fields, never from the
// model's sentence about them.

import type { KindRec } from "@cobblr/workspace-tools";

export interface WriteValue {
  /** The field key, top-level or inside metadata (where custom fields live). */
  field: string;
  /** The field as its form names it. */
  label: string;
  /** The value it will be, in words. */
  value: string;
  /** For an update: what it is now. */
  from?: string;
  /** Not in the person's words: Cobb chose it. */
  suggested?: boolean;
  /** Can be taken off the write before Confirm. */
  removable?: boolean;
}

/** Records a write names by id (`location_id`), in words: `<x>_id` read as a
 *  record of the kind whose id ends in `:<x>`. */
export type TitleOf = (kind: string, id: string) => Promise<string | null>;

const TITLE_KEYS = new Set(["name", "title"]);
const SKIP = new Set(["id", "metadata"]);
const STOP = new Set(["the", "and", "for", "with", "from", "your", "this", "that", "what", "value", "date", "name"]);

const humanize = (key: string): string => {
  const words = key.replace(/_id$/, "").replace(/[_-]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : key;
};

function labelOf(kind: KindRec | undefined, key: string): string {
  const custom = kind?.custom_fields?.find((f) => f.name === key);
  if (custom?.label) return custom.label;
  const native = kind?.fields?.find((f) => f.name === key);
  if (native?.label) return native.label;
  return humanize(key);
}

function words(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(words).filter(Boolean).join(", ") || null;
  return JSON.stringify(v).slice(0, 80);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Did the person's words give this value? A number by its digits, a word by
 *  its text; "a"/"an"/"one" gives a count of 1. */
function valueSaid(said: string, value: string): boolean {
  const s = said.toLowerCase();
  const v = value.toLowerCase();
  if (/^-?\d+(\.\d+)?$/.test(v)) {
    const n = Number(v);
    if (n === 1 && /\b(a|an|one|1)\b/.test(s)) return true;
    const plain = String(n);
    return new RegExp(`(^|[^\\d.])${escapeRe(plain)}(\\.0+)?(?![\\d])`).test(s);
  }
  return v.length > 0 && s.includes(v);
}

/** Do the person's words name this field ("paid" for Paid)? */
function labelSaid(said: string, label: string): boolean {
  const s = said.toLowerCase();
  return label
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !STOP.has(w))
    .some((w) => new RegExp(`\\b${escapeRe(w)}`).test(s));
}

/**
 * The values a create or an update will write, in the words its form uses.
 * `current` is the record's fields now (an update's "from"). The title is
 * left to the card's own line, which already names it.
 */
export async function writeValues(opts: {
  kind: string;
  kinds: readonly KindRec[];
  fields: Record<string, unknown>;
  said: string;
  titleOf?: TitleOf;
  current?: Record<string, unknown> | null;
  update?: boolean;
}): Promise<WriteValue[]> {
  const kind = opts.kinds.find((k) => k.id === opts.kind);
  const required = new Set([
    ...(kind?.fields ?? []).filter((f) => f.required || f.role === "title").map((f) => f.name),
    ...(kind?.custom_fields ?? []).filter((f) => f.required).map((f) => f.name),
  ]);
  const entries: Array<[string, unknown]> = [];
  for (const [k, v] of Object.entries(opts.fields)) {
    if (k === "metadata" && v && typeof v === "object" && !Array.isArray(v)) entries.push(...Object.entries(v as Record<string, unknown>));
    else if (!SKIP.has(k)) entries.push([k, v]);
  }
  const cur = (key: string): unknown => {
    const c = opts.current ?? {};
    return key in c ? c[key] : ((c.metadata as Record<string, unknown> | undefined) ?? {})[key];
  };
  const out: WriteValue[] = [];
  for (const [field, raw] of entries) {
    if (TITLE_KEYS.has(field) && !opts.update) continue;
    let value = words(raw);
    if (value === null) continue;
    let from = opts.update ? words(cur(field)) : null;
    // A record named by id reads as the record's own name.
    const ref = field.match(/^(.+)_id$/)?.[1];
    if (ref && opts.titleOf) {
      const refKind = opts.kinds.find((k) => k.id.endsWith(`:${ref}`))?.id;
      if (refKind) {
        value = (await opts.titleOf(refKind, value)) ?? value;
        if (from) from = (await opts.titleOf(refKind, from)) ?? from;
      }
    }
    out.push({ field, label: labelOf(kind, field), value, ...(opts.update ? { from: from ?? "nothing" } : {}) });
  }
  // Said, or Cobb's: the value is in the words, and when one number the
  // person gave fills two fields, only the field their words name has it.
  for (const v of out) {
    const same = out.filter((o) => o.value.toLowerCase() === v.value.toLowerCase()).length;
    const stated = valueSaid(opts.said, v.value) && (same === 1 || labelSaid(opts.said, v.label));
    if (!stated) v.suggested = true;
    if (!required.has(v.field)) v.removable = true;
  }
  return out;
}

/**
 * An action's arguments as a card shows them, for an action whose module
 * gave it no planner: each by the label its own schema declares, a record
 * named by id (`container_id` beside `container_kind`) as the record's name,
 * the `_kind` half left out. The fallback that keeps any new action from
 * reaching a person as its label alone.
 */
export async function actionArgValues(opts: {
  args: Record<string, unknown>;
  schema?: Record<string, { label?: string }> | null;
  said: string;
  titleOf?: TitleOf;
}): Promise<WriteValue[]> {
  const out: WriteValue[] = [];
  for (const [field, raw] of Object.entries(opts.args)) {
    if (/_kind$/.test(field)) continue;
    let value = words(raw);
    if (value === null) continue;
    const ref = field.match(/^(.+)_id$/)?.[1];
    const refKind = ref ? words(opts.args[`${ref}_kind`]) : null;
    if (refKind && opts.titleOf) value = (await opts.titleOf(refKind, value)) ?? value;
    const declared = opts.schema?.[field]?.label?.replace(/\s*\((optional)\)\s*$/i, "").replace(/\s+id$/i, "");
    out.push({ field, label: declared || humanize(field), value });
  }
  for (const v of out) if (!valueSaid(opts.said, v.value)) v.suggested = true;
  return out;
}
