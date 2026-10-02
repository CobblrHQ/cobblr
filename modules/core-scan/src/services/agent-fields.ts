// What an agent's values become on the table a thing was routed to: kept, or
// refused with the reason, never dropped without a word (#4537).
//
// An assistant sent `aquired_from: "eBay"` with a printer. The name was a
// guess, the write failed into a log line, and the reply said the printer was
// added. Its person was told where it came from was kept; it was not.
//
// So every value the agent sends is placed against the ROUTED table's own
// fields (#4591: the values follow the route, never pick it):
//
//   - by the field's name, or its label said as a name ("Acquired from");
//   - by ROLE, for what a value IS rather than what a workspace calls it:
//     where it was bought, who sold it, when and for how much
//     (arrivals.md §2). The seller goes to the table's seller field when it
//     has one, else beside where it was bought as that field's note;
//   - a number for a number field, a yes or no for a yes/no field, a date
//     for a date field, and on a closed list one of its choices (spelled the
//     list's way). A list that learns takes a new value; that is how it
//     learns.
//
// Anything else is refused by name, with the reason and, for a near miss, the
// field it probably meant. Pure.

import { FIELD_NOTE_SUFFIX } from "@cobblr/platform-contract";
import { isAcquiredFromField, isAcquiredOnField, isSellerField } from "@cobblr/platform-contract/acquisition-source";

export type AgentValue = string | number | boolean;

export interface AgentField {
  name: string;
  label?: string;
  type?: string;
  choices?: string[];
  field_role?: string;
  learns?: boolean;
}

/** The roles an agent may say a value by (arrivals.md §2). */
// VOCAB-ENUMERATION OK: the roles an agent may say a value by are the door's own vocabulary, each with a home rule below
export const AGENT_ROLES = ["acquired-from", "seller", "acquired-on", "acquired-for"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export interface PlacedFields {
  /** Values keyed by the table's own field names. */
  values: Record<string, AgentValue>;
  /** The names (or roles) the agent sent that were kept, as it sent them. */
  kept: string[];
  refused: Array<{ name: string; reason: string }>;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}

function fieldNamed(said: string, fields: readonly AgentField[]): AgentField | null {
  const n = norm(said);
  return fields.find((f) => f.name === said) ?? fields.find((f) => norm(f.name) === n || (f.label && norm(f.label) === n)) ?? null;
}

function nearMiss(said: string, fields: readonly AgentField[]): AgentField | null {
  const n = norm(said);
  let best: { f: AgentField; d: number } | null = null;
  for (const f of fields) {
    const d = Math.min(distance(n, norm(f.name)), f.label ? distance(n, norm(f.label)) : Infinity);
    if (d <= 2 && (!best || d < best.d)) best = { f, d };
  }
  return best?.f ?? null;
}

function fieldForRole(role: AgentRole, fields: readonly AgentField[]): AgentField | null {
  const plays = (f: AgentField) => {
    const like = { name: f.name, field_role: f.field_role ?? null };
    if (role === "acquired-from") return isAcquiredFromField(like);
    if (role === "seller") return isSellerField(like);
    if (role === "acquired-on") return isAcquiredOnField(like);
    return f.field_role === "acquired-for" || /^(acquired_for|purchase_price|price_paid|paid)$/i.test(f.name);
  };
  return fields.find((f) => f.field_role === role) ?? fields.find(plays) ?? null;
}

/** The value as the field takes it, or the reason it cannot. */
function fit(f: AgentField, v: AgentValue): { value: AgentValue } | { refused: string } {
  const type = (f.type ?? "text").toLowerCase();
  if (type === "number" || type === "integer" || type === "currency" || type === "money") {
    const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.\-]/g, ""));
    if (typeof v === "boolean" || !Number.isFinite(n) || String(v).trim() === "") return { refused: `${label(f)} takes a number` };
    return { value: n };
  }
  if (type === "boolean") {
    if (typeof v === "boolean") return { value: v };
    const s = String(v).trim().toLowerCase();
    if (["yes", "true", "1"].includes(s)) return { value: true };
    if (["no", "false", "0"].includes(s)) return { value: false };
    return { refused: `${label(f)} takes yes or no` };
  }
  if (type === "date") {
    const s = String(v).trim();
    if (!/^\d{4}-\d{2}-\d{2}/.test(s) || Number.isNaN(Date.parse(s))) return { refused: `${label(f)} takes a date (YYYY-MM-DD)` };
    return { value: s.slice(0, 10) };
  }
  if (f.choices?.length) {
    const said = String(v).trim();
    const listed = f.choices.find((c) => c.toLowerCase() === said.toLowerCase());
    if (listed) return { value: listed };
    if (!f.learns) return { refused: `${label(f)} is one of: ${f.choices.slice(0, 12).join(", ")}${f.choices.length > 12 ? ", …" : ""}` };
    return { value: said };
  }
  return { value: typeof v === "string" ? v.trim() : v };
}

const label = (f: AgentField) => f.label || f.name;

/** Place the agent's values on the table's fields. `tableLabel` names the
 *  table in a refusal ("no field named aquired_from on 3D Printers"). */
export function placeAgentFields(
  fields: Readonly<Record<string, AgentValue>> | undefined,
  roles: Readonly<Partial<Record<string, AgentValue>>> | undefined,
  table: { label: string; fields: readonly AgentField[] },
): PlacedFields {
  const out: PlacedFields = { values: {}, kept: [], refused: [] };
  const put = (said: string, f: AgentField, v: AgentValue) => {
    const r = fit(f, v);
    if ("refused" in r) out.refused.push({ name: said, reason: r.refused });
    else {
      out.values[f.name] = r.value;
      out.kept.push(said);
    }
  };
  for (const [said, v] of Object.entries(fields ?? {})) {
    if (said.endsWith(FIELD_NOTE_SUFFIX)) {
      const base = fieldNamed(said.slice(0, -FIELD_NOTE_SUFFIX.length), table.fields);
      if (base) {
        out.values[`${base.name}${FIELD_NOTE_SUFFIX}`] = String(v).trim();
        out.kept.push(said);
        continue;
      }
    }
    const f = fieldNamed(said, table.fields);
    if (f) {
      put(said, f, v);
      continue;
    }
    const near = nearMiss(said, table.fields);
    out.refused.push({ name: said, reason: `no field named ${said} on ${table.label}${near ? ` (did you mean ${near.name}?)` : ""}` });
  }
  for (const [role, v] of Object.entries(roles ?? {})) {
    if (v === undefined || v === null || v === "") continue;
    if (!(AGENT_ROLES as readonly string[]).includes(role)) {
      out.refused.push({ name: role, reason: `not a role: say one of ${AGENT_ROLES.join(", ")}` });
      continue;
    }
    const f = fieldForRole(role as AgentRole, table.fields);
    if (f) {
      put(role, f, v);
      continue;
    }
    // Who sold it, on a table with no seller field: beside where it was bought.
    const from = role === "seller" ? fieldForRole("acquired-from", table.fields) : null;
    if (from) {
      out.values[`${from.name}${FIELD_NOTE_SUFFIX}`] = String(v).trim();
      out.kept.push(role);
      continue;
    }
    out.refused.push({ name: role, reason: `${table.label} has no field for ${role.replace(/-/g, " ")}` });
  }
  return out;
}

/** "MakerGear M2 (from RainMotorSports)" is the thing and who it came from:
 *  the name, and the seller. Null when the name says no one. */
export function sellerInName(name: string): { name: string; seller: string } | null {
  const m = /^(.*\S)\s*\((?:bought\s+)?(?:from|via)\s+([^()]+?)\)\s*$/i.exec(name.trim());
  if (!m || !m[1] || !m[2]) return null;
  return { name: m[1].trim(), seller: m[2].trim() };
}
