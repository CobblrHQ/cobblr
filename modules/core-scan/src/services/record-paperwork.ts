// Paperwork put on a record: what it says, filled onto the record's EMPTY
// fields by meaning, and every disagreement handed back to be decided.
//
// A bill of sale pasted on a car (#4523) says what was paid, when and to whom,
// and for a vehicle its VIN, year, make, model and odometer. Each fact lands
// on the field that declares it: a field ROLE (acquired-for is Paid,
// acquired-on is Purchased at, acquired-from is Bought from, usage is the
// odometer) or a DECODE role (identifier:vin, decode:make), the same doors a
// receipt line and a scanned VIN fill through, never a field's name. A field
// that already holds a value is never written: when the paper says something
// else it is returned as a conflict ("Bill of sale says $14,300, you have
// $14,000"), for the person to take or leave. What was written is returned
// so it can be undone, and only while it still reads what was written.

import {
  mapRoledFacts,
  planDecodeFill,
  platform,
  type DecodeFillTarget,
  type RoledFacts,
} from "@cobblr/platform-contract";
import {
  FIELD_PROVENANCE_KEY,
  fieldProvenanceOf,
  type FieldProvenance,
  type FieldProvenanceMap,
} from "@cobblr/platform-contract/acquisition-source";
import { checkWordFor, doubtedChecks, splitDoubtedFacts } from "./receipt-facts.js";
import { formatStoredMoney, MONEY_ROLES } from "@cobblr/platform-contract/money";
import type { ParsedReceipt, ReceiptLine } from "./receipt-shared.js";

/** A field of the record this pass may fill. */
export interface PaperworkField {
  name: string;
  label: string;
  native: boolean;
  money?: "cents" | "amount" | null;
  field_role?: string | null;
  decode_role?: string | null;
}

/** One value written, with what was there (always empty: only empty fields
 *  are written), so it can be taken back. */
export interface PaperworkFill {
  field: string;
  label: string;
  native: boolean;
  value: string | number;
  /** The value as a person reads it ("$14,300.00"). */
  shown: string;
}

/** The paper and the record disagree; nothing was written. */
export interface PaperworkConflict {
  field: string;
  label: string;
  native: boolean;
  /** What the paper says, in the field's own unit (cents for a cents column). */
  document: string | number;
  current: unknown;
  /** Both as a person reads them. */
  shown_document: string;
  shown_current: string;
}

/** A value as a person reads it: money as money in the field's own unit,
 *  anything else as written. */
export function shownValue(v: unknown, field: Pick<PaperworkField, "money" | "field_role">): string {
  if (v === null || v === undefined || v === "") return "nothing";
  if (field.money || (field.field_role && MONEY_ROLES.has(field.field_role))) {
    return formatStoredMoney(v, field.money ?? "amount") ?? String(v);
  }
  return String(v);
}

const isEmpty = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

/** Do two values say the same thing? Numbers by value, dates by day, words
 *  without regard to case or spacing. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (isEmpty(a) || isEmpty(b)) return isEmpty(a) && isEmpty(b);
  const na = typeof a === "number" ? a : Number(a);
  const nb = typeof b === "number" ? b : Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && String(a).trim() !== "" && String(b).trim() !== "") return Math.abs(na - nb) < 0.005;
  const sa = String(a).trim();
  const sb = String(b).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(sa) && /^\d{4}-\d{2}-\d{2}/.test(sb)) return sa.slice(0, 10) === sb.slice(0, 10);
  return sa.toLowerCase().replace(/\s+/g, " ") === sb.toLowerCase().replace(/\s+/g, " ");
}

/** The checks a document failed: its own (receipt.checks) and any the inbox
 *  row carries, so a value doubted on the card is doubted here too. */
export function paperworkDoubts(receipt: ParsedReceipt, more: Iterable<string> = []): Set<string> {
  return new Set([...doubtedChecks({ check_fields: receipt.checks }), ...more]);
}

function paperworkSplit(receipt: ParsedReceipt, line: ReceiptLine, doubted: ReadonlySet<string>): { facts: RoledFacts; held: RoledFacts } {
  return splitDoubtedFacts({
    receipt_vendor: receipt.vendor,
    receipt_seller: receipt.seller,
    receipt_date: receipt.date,
    line_total: line.line_total,
    receipt_line_count: 1,
    line_facts: line.facts,
    check_fields: { fields: [...doubted] },
  });
}

/** The facts one line of a document gives the thing it is about, less any
 *  whose check failed. */
export function paperworkFacts(receipt: ParsedReceipt, line: ReceiptLine, doubted: ReadonlySet<string> = paperworkDoubts(receipt)): RoledFacts {
  return paperworkSplit(receipt, line, doubted).facts;
}

/** A name the page read badly does not name the thing: its make and model
 *  are not written from it (#4633: "MODEL CTVIC HATCH" as the make). */
const nameDoubted = (d: ReadonlySet<string>) => d.has("name") || d.has("make") || d.has("model");

/** What the paper would write, per field, before anything is compared. A
 *  value whose check failed is never in it (heldPaperwork says what was). */
export function planPaperwork(receipt: ParsedReceipt, line: ReceiptLine, fields: PaperworkField[], doubted: ReadonlySet<string> = paperworkDoubts(receipt)): Array<{ field: PaperworkField; value: string | number; role: string }> {
  const out: Array<{ field: PaperworkField; value: string | number; role: string }> = [];
  const taken = new Set<string>();
  // By field role first: the meaning a field declared.
  const mapped = mapRoledFacts(
    paperworkFacts(receipt, line, doubted),
    fields.filter((f) => f.field_role).map((f) => ({ name: f.name, field_role: f.field_role, native: f.native, money: f.money ?? null })),
  );
  for (const m of mapped) {
    if (m.isNote || m.unlistedChoice) continue;
    const f = fields.find((x) => x.name === m.key);
    if (!f || taken.has(f.name)) continue;
    taken.add(f.name);
    out.push({ field: f, value: m.value, role: m.role });
  }
  // Then what the document printed about the thing's identity, as an
  // identifier decode fills it: the code into the field that holds it, the
  // rest by decode role.
  if (line.decoded && !doubted.has("vin")) {
    const targets: DecodeFillTarget[] = fields
      .filter((f) => !taken.has(f.name))
      .map((f) => ({ id: f.name, name: f.name, label: f.label, empty: true, role: f.decode_role ?? null }));
    for (const fill of planDecodeFill(line.decoded.fields, targets, { decoderId: line.decoded.decoder_id, code: line.decoded.code })) {
      const f = fields.find((x) => x.name === fill.target.name);
      if (!f || taken.has(f.name)) continue;
      taken.add(f.name);
      out.push({ field: f, value: fill.value, role: `decode:${fill.decodedKey}` });
    }
  }
  // The make and model a document names reach the kind's own columns of those
  // names when no role claimed them (a receipt's `model` reaches a record the
  // same way, native-identity.ts).
  const byName = (name: string, value: string | null | undefined) => {
    if (!value) return;
    const f = fields.find((x) => x.name === name && x.native);
    if (!f || taken.has(f.name)) return;
    taken.add(f.name);
    out.push({ field: f, value, role: `native:${name}` });
  };
  if (!nameDoubted(doubted)) {
    byName("manufacturer", line.manufacturer ?? null);
    byName("model", line.model ?? null);
  }
  if (!doubted.has("vin")) byName("serial_number", line.decoded?.code ?? null);
  return out;
}

/** A value the paper read that failed its check: shown under "Please check"
 *  with what was read, never written. */
export interface PaperworkHeld {
  field: string | null;
  label: string;
  native: boolean;
  /** The check it failed, in the card's words ("seller", "price"). */
  check: string;
  document: string | number;
  shown_document: string;
}

/** What a fill held back because its check failed, on the fields it would
 *  have gone to. */
export function heldPaperwork(receipt: ParsedReceipt, line: ReceiptLine, fields: PaperworkField[], doubted: ReadonlySet<string> = paperworkDoubts(receipt)): PaperworkHeld[] {
  const out: PaperworkHeld[] = [];
  const { held } = paperworkSplit(receipt, line, doubted);
  const checkOf = (role: string) => checkWordFor(role, doubted);
  const mapped = mapRoledFacts(held, fields.filter((f) => f.field_role).map((f) => ({ name: f.name, field_role: f.field_role, native: f.native, money: f.money ?? null })));
  const said = new Set<string>();
  for (const m of mapped) {
    if (m.isNote) continue;
    const f = fields.find((x) => x.name === m.key);
    if (!f || said.has(f.name)) continue;
    said.add(f.name);
    out.push({ field: f.name, label: f.label, native: f.native, check: checkOf(m.role), document: m.value, shown_document: shownValue(m.value, f) });
  }
  // A held fact no field takes is still said, so the person sees what was read.
  for (const [role, v] of Object.entries(held)) {
    if (mapped.some((m) => m.role === role)) continue;
    out.push({ field: null, label: role.replace(/-/g, " "), native: false, check: checkOf(role), document: v as string | number, shown_document: String(v) });
  }
  if (nameDoubted(doubted)) {
    for (const [name, value] of [["manufacturer", line.manufacturer], ["model", line.model]] as const) {
      const f = fields.find((x) => x.name === name && x.native);
      if (value) out.push({ field: f?.name ?? null, label: f?.label ?? name, native: !!f, check: name === "manufacturer" ? "make" : "model", document: value, shown_document: value });
    }
  }
  return out;
}

/**
 * Fill one record from one line of a document. Empty fields only; a field
 * whose value differs is a conflict. Returns what was written and what was
 * not.
 */
export async function fillRecordFromPaperwork(args: {
  orgId: string;
  kind: string;
  id: string;
  receipt: ParsedReceipt;
  line: ReceiptLine;
  fields: PaperworkField[];
  /** The evidence a person can open: the file the facts came from. */
  ref: { kind: string; id: string };
  /** Checks the inbox row failed, beyond the document's own. */
  doubted?: Iterable<string>;
}): Promise<{ filled: PaperworkFill[]; conflicts: PaperworkConflict[]; held: PaperworkHeld[] }> {
  const doubted = paperworkDoubts(args.receipt, args.doubted ?? []);
  const held = heldPaperwork(args.receipt, args.line, args.fields, doubted);
  const row = await platform().entities.snapshot(args.orgId, args.kind, args.id).catch(() => null);
  if (!row) return { filled: [], conflicts: [], held };
  const rawMeta = (row as { metadata?: unknown }).metadata;
  const meta = (typeof rawMeta === "string" ? JSON.parse(rawMeta) : (rawMeta ?? {})) as Record<string, unknown>;
  const prov: FieldProvenanceMap = { ...fieldProvenanceOf(meta) };
  const at = new Date().toISOString();

  const filled: PaperworkFill[] = [];
  const conflicts: PaperworkConflict[] = [];
  const nativeWrites: Record<string, string | number> = {};
  const metaWrites: Record<string, string | number> = {};
  for (const { field, value, role } of planPaperwork(args.receipt, args.line, args.fields, doubted)) {
    const current = field.native ? (row as Record<string, unknown>)[field.name] : meta[field.name];
    if (!isEmpty(current)) {
      if (!sameValue(current, value)) conflicts.push({ field: field.name, label: field.label, native: field.native, document: value, current, shown_document: shownValue(value, field), shown_current: shownValue(current, field) });
      continue;
    }
    (field.native ? nativeWrites : metaWrites)[field.name] = value;
    const stamp: FieldProvenance = { by: "evidence", from: "receipt", ref: args.ref, at, ...(role.startsWith("native:") || role.startsWith("decode:") ? {} : { role }) };
    prov[field.name] = stamp;
    filled.push({ field: field.name, label: field.label, native: field.native, value, shown: shownValue(value, field) });
  }
  if (Object.keys(nativeWrites).length) {
    const writer = await platform().entities.getWriter(args.orgId, args.kind);
    if (writer) await writer.update(args.orgId, args.id, nativeWrites);
    else {
      for (const k of Object.keys(nativeWrites)) delete prov[k];
      for (let i = filled.length - 1; i >= 0; i--) if (filled[i]!.native) filled.splice(i, 1);
    }
  }
  if (filled.length) {
    await platform().entities.mergeMetadata(args.orgId, args.kind, args.id, { ...metaWrites, [FIELD_PROVENANCE_KEY]: prov });
  }
  return { filled, conflicts, held };
}

/** Take back what a fill wrote: each field only while it still holds what was
 *  written, so a later edit by a person is never undone. Returns the fields
 *  emptied. */
export async function undoPaperworkFill(orgId: string, kind: string, id: string, fills: PaperworkFill[]): Promise<string[]> {
  const row = await platform().entities.snapshot(orgId, kind, id).catch(() => null);
  if (!row) return [];
  const rawMeta = (row as { metadata?: unknown }).metadata;
  const meta = (typeof rawMeta === "string" ? JSON.parse(rawMeta) : (rawMeta ?? {})) as Record<string, unknown>;
  const prov: FieldProvenanceMap = { ...fieldProvenanceOf(meta) };
  const nativeClear: Record<string, null> = {};
  const metaClear: Record<string, null> = {};
  const undone: string[] = [];
  for (const f of fills) {
    const current = f.native ? (row as Record<string, unknown>)[f.field] : meta[f.field];
    if (!sameValue(current, f.value)) continue;
    (f.native ? nativeClear : metaClear)[f.field] = null;
    delete prov[f.field];
    undone.push(f.field);
  }
  if (Object.keys(nativeClear).length) {
    const writer = await platform().entities.getWriter(orgId, kind);
    if (writer) await writer.update(orgId, id, nativeClear);
  }
  if (undone.length) await platform().entities.mergeMetadata(orgId, kind, id, { ...metaClear, [FIELD_PROVENANCE_KEY]: prov });
  return undone;
}

/** A person chose the paper's value over the record's: written, and theirs. */
export async function takePaperworkValue(orgId: string, kind: string, id: string, c: { field: string; native: boolean; value: string | number }): Promise<boolean> {
  const row = await platform().entities.snapshot(orgId, kind, id).catch(() => null);
  if (!row) return false;
  const rawMeta = (row as { metadata?: unknown }).metadata;
  const meta = (typeof rawMeta === "string" ? JSON.parse(rawMeta) : (rawMeta ?? {})) as Record<string, unknown>;
  const prov: FieldProvenanceMap = { ...fieldProvenanceOf(meta), [c.field]: { by: "person", at: new Date().toISOString() } };
  if (c.native) {
    const writer = await platform().entities.getWriter(orgId, kind);
    if (!writer) return false;
    await writer.update(orgId, id, { [c.field]: c.value });
    return platform().entities.mergeMetadata(orgId, kind, id, { [FIELD_PROVENANCE_KEY]: prov });
  }
  return platform().entities.mergeMetadata(orgId, kind, id, { [c.field]: c.value, [FIELD_PROVENANCE_KEY]: prov });
}
