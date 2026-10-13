// A saved wire in words (#6110): which record it watches, what it does, and
// to what, so the wires list and a wire's detail name the coffee and the
// shopping list instead of "inventory:part → lists:add-item, one record".
//
// The record comes from the wire's narrowing (filter.in.record), named by the
// kind's own resolver; the action by its declared label; each argument by the
// first clause of its declared label ("Which list, by name; created if…" is
// "Which list"), a person by their name on the People list. The ids stay on
// the wire for diagnosis; this only adds the words beside them.

import { readWireRecords } from "@cobblr/platform-contract/wire-narrowing";
import { meta } from "../db/meta.js";
import { lookupMany } from "./entities.js";
import { personNamesFor } from "./people.js";

export interface WireSaid {
  /** The one record the wire is narrowed to: its title, or null when it is gone. */
  record: { id: string; title: string | null } | null;
  /** The action's own label ("Add to a list"). */
  action: string | null;
  /** The arguments it was given, in the action's words ("Which list": "Shopping"). */
  args: Array<{ label: string; value: string }>;
}

interface ArgSpec { label?: string; type?: string; choicesFrom?: string }

/** "Which list, by name; created if it does not exist yet" is "Which list". */
export function shortArgLabel(label: string, name: string): string {
  const head = label.split(/[,;(]/)[0]!.trim();
  return head || name;
}

/** An argument's value as a person reads it, or null when there is nothing to say. */
export function argValueSaid(value: unknown, spec: ArgSpec, people: ReadonlyMap<string, string>): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean" || value === "true" || value === "false") return value === true || value === "true" ? "yes" : null;
  if (typeof value === "number") return String(value);
  if (typeof value !== "string" || !value.trim()) return null;
  const v = value.trim();
  if (spec.choicesFrom === "people") return people.get(v) ?? v;
  return v.length > 80 ? `${v.slice(0, 79)}…` : v;
}

type WireRow = { source_kind: string; action_id: string; filter: unknown; args: unknown };

/** Every wire in words, with one read of the actions and one of the People
 *  list for the whole page, and a lookup only for a wire narrowed to one record. */
export async function wiresSaid(orgId: string, wires: readonly WireRow[]): Promise<WireSaid[]> {
  const ids = [...new Set(wires.map((w) => w.action_id))];
  const actions = ids.length ? await meta.selectFrom("entity_actions").select(["id", "label", "args_schema"]).where("id", "in", ids).execute() : [];
  const byId = new Map(actions.map((a) => [a.id, a]));
  const needsPeople = wires.some((w) => {
    const schema = (byId.get(w.action_id)?.args_schema ?? {}) as Record<string, ArgSpec>;
    return Object.entries(schema).some(([k, sp]) => sp.choicesFrom === "people" && (w.args as Record<string, unknown> | null)?.[k] !== undefined);
  });
  const people = needsPeople ? await personNamesFor(orgId) : new Map<string, string>();
  const narrowed = wires.map((w) => readWireRecords((w.filter as { in?: unknown } | null)?.in)?.record ?? null);
  const refs = wires.flatMap((w, n) => (narrowed[n] ? [{ kind: w.source_kind, id: narrowed[n]! }] : []));
  const titles = new Map((await lookupMany(orgId, refs)).map((r) => [r.id, r.title ?? null]));
  const out: WireSaid[] = [];
  for (const [n, w] of wires.entries()) {
    const id = narrowed[n];
    const record: WireSaid["record"] = id ? { id, title: titles.get(id) ?? null } : null;
    const a = byId.get(w.action_id);
    const schema = (a?.args_schema ?? {}) as Record<string, ArgSpec>;
    const given = (w.args ?? {}) as Record<string, unknown>;
    const args: WireSaid["args"] = [];
    for (const [name, spec] of Object.entries(schema)) {
      const said = argValueSaid(given[name], spec, people);
      if (said !== null) args.push({ label: shortArgLabel(spec.label ?? name, name), value: said });
    }
    out.push({ record, action: a?.label?.trim() || null, args });
  }
  return out;
}
