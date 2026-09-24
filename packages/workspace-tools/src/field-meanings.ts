// What each value on a record MEANS, handed to the model beside the value.
//
// "Show me the toaster" was answered "purchased from Review test shop for
// $39.95". The toaster had no price paid: 39.95 was its replacement value,
// which its form explains as "what it'd cost to buy new today ... (not what
// you paid)". The model saw `replacement_value: 39.95` beside `cost: null`,
// a bare key and an empty one, and joined them into a purchase. The form a
// person reads says "Replacement value" and "Paid" and what each means; the
// tool said neither.
//
// So a record reaches the model as it reaches a person: an empty field is
// left out (a value that is not there is not there, rather than a null the
// model may fill from the next field), and every field the record does hold
// comes with its label and meaning, in the words its form uses. One line
// says the rule outright. The code decides what each value is; the model
// only narrates it.

import type { KindRec } from "./kinds.js";

export const UNRECORDED_NOTE =
  "Each record lists only the fields that hold a value. A field that is not listed has nothing recorded: say it is not recorded, and never state it from another field (a replacement value is not a price paid).";

const empty = (v: unknown): boolean =>
  v === null || v === undefined || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);

/** The record's fields with the empty ones left out, one level into metadata. */
function withoutEmpty(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (k === "metadata" && v && typeof v === "object" && !Array.isArray(v)) {
      const meta = withoutEmpty(v as Record<string, unknown>);
      if (Object.keys(meta).length) out[k] = meta;
      continue;
    }
    if (!empty(v)) out[k] = v;
  }
  return out;
}

/** "Label: meaning" for one field of one kind, or null when the kind says
 *  nothing more about it than its key. */
function meaningOf(kind: KindRec | undefined, name: string): string | null {
  const custom = kind?.custom_fields?.find((f) => f.name === name);
  const native = kind?.fields?.find((f) => f.name === name);
  const label = custom?.label ?? native?.label;
  const help = custom?.help;
  if (help) return `${label ?? name}: ${help}`;
  return label && label !== name ? label : null;
}

type Rec = { kind?: unknown; id?: unknown; fields?: unknown };
const isRecord = (v: unknown): v is Rec & { fields: Record<string, unknown> } =>
  !!v && typeof v === "object" && typeof (v as Rec).kind === "string" && !!(v as Rec).fields && typeof (v as Rec).fields === "object";

/**
 * A read tool's result with each record's empty fields left out and, beside
 * the records, what every field they hold means (`fields_explained`, by kind
 * then field) and the rule for what is not there (`unrecorded`). A result
 * with no records passes through untouched.
 */
export function explainRecords(body: unknown, kinds: readonly KindRec[]): unknown {
  if (!body || typeof body !== "object") return body;
  const explained: Record<string, Record<string, string>> = {};
  let saw = false;
  const note = (rec: Rec & { fields: Record<string, unknown> }, fields: Record<string, unknown>): void => {
    const kindId = String(rec.kind);
    const kind = kinds.find((k) => k.id === kindId);
    const keys = [...Object.keys(fields).filter((k) => k !== "metadata"), ...Object.keys((fields.metadata as Record<string, unknown>) ?? {})];
    for (const key of keys) {
      const m = meaningOf(kind, key);
      if (!m) continue;
      (explained[kindId] ??= {})[key] = m;
    }
  };
  const shape = (v: unknown): unknown => {
    if (!isRecord(v)) return v;
    saw = true;
    const fields = withoutEmpty(v.fields);
    note(v, fields);
    return { ...v, fields };
  };
  const b = body as Record<string, unknown>;
  let out: Record<string, unknown>;
  if (Array.isArray(b.items)) out = { ...b, items: b.items.map(shape) };
  else if (isRecord(b)) out = shape(b) as Record<string, unknown>;
  else return body;
  if (!saw) return body;
  return { ...out, ...(Object.keys(explained).length ? { fields_explained: explained } : {}), unrecorded: UNRECORDED_NOTE };
}
