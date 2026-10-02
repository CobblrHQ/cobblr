// Fill what a record already says about itself (#4518).
//
// A vehicle came in as "Yamaha YZF-R3, Blue" with its VIN; Make was filled and
// Model stayed empty, though both the name and the VIN answer it. This reads a
// record's identifier (a VIN, through the decoder registry and its cache) and
// its own name, and fills the fields that are EMPTY with what they answer:
// never a value somebody typed, never a field that already holds anything.
//
// Generic: it reads the fields' declared decode roles (a bundle tags Model
// `decode:model` and the VIN `identifier:vin`), falls back to the planner's
// name matching, and never names a vehicle. A bundle wires it to its table's
// created and updated events; filling a field fires `updated` once more, and
// that run finds nothing empty it can answer, so it stops.
//
// Order: the decoder's answer wins over the name's (it is the maker's own
// record), and the name answers what the decoder left (a model vPIC did not
// know, a year the offline VIN read could not be sure of).

import type { Kysely } from "kysely";
import { planDecodeFill, platform, type DecodeFillTarget } from "@cobblr/platform-contract";
import { castFieldValue } from "@cobblr/platform-contract/field-values";
import type { CoreScanDB } from "../db.js";
import { findDecoder } from "./identifier-registry.js";
import { registerBuiltinDecoders, vinModelYear } from "./vin-decode.js";
import { readDecodeCache, writeDecodeCache, decodeCacheKey } from "./decode-cache.js";
import { factsFromName, fieldsFromName, type NameField } from "./known-facts.js";

registerBuiltinDecoders();

export interface KnownFill {
  name: string;
  label: string;
  /** A column of the record's own (manufacturer, model), not a custom field. */
  native: boolean;
  value: string | number;
  /** Where it came from, said to a person: "the VIN", "the name". */
  from: string;
  /** The field's declared type and unit, so the value is kept as that type
   *  ("3/8 in" in a measure field is { value: 0.375, unit: "inch" }). */
  fieldType?: string;
  unit?: string | null;
}

interface FieldRow {
  name: string;
  label: string;
  role: string | null;
  fieldRole: string | null;
}

type MetaDb = Kysely<{
  module_field_defs: { org_id: string; entity_kind: string; name: string; display_label: string | null; type: string; field_role: string | null; decode_role: string | null; unit: string | null; choices: string[] | null };
  native_field_overrides: { org_id: string; entity_kind: string; name: string; display_label: string | null; overrides: unknown };
}>;

/** The kind's fields with their decode roles: its own defs and the native
 *  columns a bundle gave a role to (Make, Model, the VIN). */
async function fieldsWithRoles(orgId: string, kind: string): Promise<FieldRow[]> {
  const meta = platform().db.meta as unknown as MetaDb;
  const defs = await meta
    .selectFrom("module_field_defs")
    .select(["name", "display_label", "type", "field_role", "decode_role"])
    .where("org_id", "=", orgId)
    .where("entity_kind", "=", kind)
    .execute();
  const natives = await meta
    .selectFrom("native_field_overrides")
    .select(["name", "display_label", "overrides"])
    .where("org_id", "=", orgId)
    .where("entity_kind", "=", kind)
    .execute();
  const out: FieldRow[] = defs
    .filter((d) => d.type === "text" || d.type === "number")
    .map((d) => ({ name: d.name, label: d.display_label || d.name, role: d.decode_role, fieldRole: d.field_role }));
  for (const n of natives) {
    const o = (n.overrides ?? {}) as { decode_role?: string; field_role?: string };
    if (out.some((f) => f.name === n.name)) continue;
    out.push({ name: n.name, label: n.display_label || n.name, role: o.decode_role ?? null, fieldRole: o.field_role ?? null });
  }
  return out;
}

/** The kind's fields a name can answer by their own words: measures and
 *  text fields with choices (Size, Drive, Type on a socket). */
async function nameFields(orgId: string, kind: string): Promise<NameField[]> {
  const meta = platform().db.meta as unknown as MetaDb;
  const defs = await meta
    .selectFrom("module_field_defs")
    .select(["name", "display_label", "type", "unit", "choices"])
    .where("org_id", "=", orgId)
    .where("entity_kind", "=", kind)
    .where((eb) => eb.or([eb("type", "=", "measure"), eb.and([eb("type", "=", "text"), eb("choices", "is not", null)])]))
    .execute();
  return defs.map((d) => ({ name: d.name, label: d.display_label || d.name, type: d.type, unit: d.unit, choices: d.choices }));
}

const blank = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

async function decodeCached(db: Kysely<CoreScanDB>, code: string): Promise<Record<string, string | number> | null> {
  const decoder = findDecoder(code);
  if (!decoder) return null;
  const key = decodeCacheKey(code);
  const cached = await readDecodeCache(db, decoder.id, key);
  if (cached) return cached.outcome === "hit" || cached.outcome === "partial" ? cached.fields : null;
  const result = await decoder.decode(code.trim());
  if (result.outcome !== "unavailable") await writeDecodeCache(db, decoder.id, key, result).catch(() => {});
  return result.outcome === "hit" || result.outcome === "partial" ? result.fields : null;
}

/** Work out the fills for one record, without writing. */
export async function planKnownFill(orgId: string, kind: string, id: string): Promise<KnownFill[]> {
  const rec = await platform().entities.lookup(orgId, kind, id);
  if (!rec) return [];
  const f = (rec.fields ?? {}) as Record<string, unknown>;
  const meta = (f.metadata && typeof f.metadata === "object" ? f.metadata : {}) as Record<string, unknown>;
  const isNative = (name: string) => name !== "metadata" && name in f;
  const read = (name: string) => (isNative(name) ? f[name] : meta[name]);

  const fields = await fieldsWithRoles(orgId, kind);
  // Native make/model take part even with no role: the planner matches them
  // by name, as the record page's VIN box does.
  for (const name of ["manufacturer", "model"]) {
    if (isNative(name) && !fields.some((x) => x.name === name)) fields.push({ name, label: name, role: null, fieldRole: null });
  }
  const targets: DecodeFillTarget[] = fields.map((x) => ({ id: x.name, name: x.name, label: x.label, empty: blank(read(x.name)), role: x.role }));
  if (!targets.some((t) => t.empty)) return [];

  const fills: KnownFill[] = [];
  const claim = (planned: ReturnType<typeof planDecodeFill>, from: string) => {
    for (const p of planned) {
      if (fills.some((x) => x.name === p.target.name)) continue;
      const t = targets.find((x) => x.id === p.target.id);
      if (t) t.empty = false;
      fills.push({ name: p.target.name, label: p.target.label, native: isNative(p.target.name), value: p.value, from });
    }
  };

  // The identifier: a field that declares it holds one, else a field whose
  // meaning is an identifier, holding a code some decoder claims.
  const holder =
    fields.find((x) => x.role?.startsWith("identifier:") && !blank(read(x.name))) ??
    fields.find((x) => x.fieldRole === "identifier" && !blank(read(x.name)) && findDecoder(String(read(x.name))));
  if (holder) {
    const code = String(read(holder.name)).trim();
    const db = (await platform().tenants.getDb(orgId)) as Kysely<CoreScanDB>;
    const decoded = await decodeCached(db, code).catch(() => null);
    const bag: Record<string, string | number> = { ...(decoded ?? {}) };
    // The model year is in the VIN itself: certain years are read offline.
    if (bag.year === undefined) {
      const y = findDecoder(code)?.id === "vin" ? vinModelYear(code) : null;
      if (y) bag.year = y;
    }
    delete bag.vin;
    claim(planDecodeFill(bag, targets), holder.label);
  }

  const make = String(read("manufacturer") ?? fills.find((x) => x.name === "manufacturer")?.value ?? "");
  const named = factsFromName(String(f.name ?? ""), make);
  claim(planDecodeFill(named as Record<string, string | number>, targets), "the name");

  // What the name says for fields by their own words: "10 mm deep socket,
  // 3/8 in drive" fills an empty Size, Drive and Type.
  const open = (await nameFields(orgId, kind)).filter((x) => blank(read(x.name)) && !fills.some((y) => y.name === x.name));
  if (open.length) {
    const said = fieldsFromName(String(f.name ?? ""), open);
    for (const x of open) {
      const value = said[x.name];
      if (value !== undefined) fills.push({ name: x.name, label: x.label, native: isNative(x.name), value, from: "the name", fieldType: x.type, unit: x.unit ?? null });
    }
  }
  return fills;
}

/** Write the fills: native columns through the kind's writer, custom fields
 *  merged into metadata so no other key is touched. */
export async function writeKnownFill(orgId: string, kind: string, id: string, fills: readonly KnownFill[], clear = false): Promise<boolean> {
  if (fills.length === 0) return true;
  const writer = await platform().entities.getWriter(orgId, kind);
  if (!writer) return false;
  const native: Record<string, unknown> = {};
  const custom: Record<string, unknown> = {};
  for (const x of fills) (x.native ? native : custom)[x.name] = clear ? null : x.fieldType ? castFieldValue(x.fieldType, x.value, x.unit) : x.value;
  if (Object.keys(native).length) await writer.update(orgId, id, native);
  if (Object.keys(custom).length) {
    if (writer.mergeMetadata) await writer.mergeMetadata(orgId, id, custom);
    else await platform().entities.mergeMetadata(orgId, kind, id, custom);
  }
  return true;
}

/** The fills the record now holds. A kind's writer takes the columns it
 *  knows and drops the rest without a word, so what landed is read back, never
 *  assumed: a fill that says "Filled Model" and left Model empty is the one
 *  thing this must not do. */
export async function landedFills(orgId: string, kind: string, id: string, fills: readonly KnownFill[]): Promise<KnownFill[]> {
  const rec = await platform().entities.lookup(orgId, kind, id);
  const f = (rec?.fields ?? {}) as Record<string, unknown>;
  const meta = (f.metadata && typeof f.metadata === "object" ? f.metadata : {}) as Record<string, unknown>;
  // A measure is kept as { value, unit, text }: what landed is its text.
  const said = (v: unknown) => (v && typeof v === "object" && typeof (v as { text?: unknown }).text === "string" ? (v as { text: string }).text : String(v ?? ""));
  const landed = fills.filter((x) => said(x.native ? f[x.name] : meta[x.name]) === String(x.value));
  if (landed.length < fills.length) {
    const lost = fills.filter((x) => !landed.includes(x)).map((x) => x.name);
    console.warn(`[core-scan] fill-known on ${kind} ${id}: the record's writer did not keep ${lost.join(", ")}`);
  }
  return landed;
}

/** "Filled Model and Year from the VIN": what changed, in the record's words. */
export function sayFilled(fills: readonly KnownFill[]): string {
  const byFrom = new Map<string, string[]>();
  for (const x of fills) byFrom.set(x.from, [...(byFrom.get(x.from) ?? []), x.label]);
  const and = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
  return "Filled " + [...byFrom].map(([from, labels]) => `${and(labels)} from ${from}`).join("; ");
}
