// Where the workspace already keeps the same thing is where this one goes
// (#4591).
//
// Two used MakerGear M2s added one after the other went one to 3D Printers
// and one to generic Machines, and a replay kept Machines: the matchmaker was
// asked afresh each time, and a model asked twice does not always answer the
// same. The workspace had already said where its M2s live: 58 printers sat
// in 3D Printers, one of them an M2. So the route is decided by what is known
// before what is guessed:
//
//   1. the table holding the record this thing already IS (the tracked match);
//   2. else the table its twins in the inbox (the same name) are headed to;
//   3. else the model's route.
//
// Of the tables 1 and 2 offer, the most specific wins: a list made for this
// kind of thing (an instance) over its module's catch-all. A person's choice
// is never touched here: it is stored apart and read first by every door
// (scanDestination). Pure.

import type { ScanMenuEntry } from "./matchmaker.js";

export interface RouteCandidate {
  module?: string;
  instance?: string | null;
  kind?: string;
  label?: string;
  fields?: Record<string, unknown>;
  category?: string | null;
  basis?: string;
}

/** A table something is already kept in or headed to. */
export interface KeptTable {
  module?: string | null;
  instance: string | null;
  kind?: string | null;
}

/** The menu entry a kept table names, or null when the workspace has no such
 *  table any more. */
function entryOf(t: KeptTable, menu: readonly ScanMenuEntry[]): ScanMenuEntry | null {
  if (t.instance) return menu.find((e) => e.instance === t.instance) ?? null;
  return (
    menu.find((e) => !e.instance && t.kind && e.kind === t.kind) ??
    menu.find((e) => !e.instance && t.module && e.module === t.module) ??
    null
  );
}

/** The most specific of the tables offered: an instance over a catch-all,
 *  then the order they were offered in. */
export function mostSpecific(tables: readonly KeptTable[], menu: readonly ScanMenuEntry[]): ScanMenuEntry | null {
  const entries = tables.map((t) => entryOf(t, menu)).filter((e): e is ScanMenuEntry => !!e);
  return entries.find((e) => !!e.instance) ?? entries[0] ?? null;
}

/**
 * Put the table the thing is kept in at the top of `candidates`, in place.
 * The model's candidate for that table moves up whole; a table it did not
 * offer gets a candidate of its own, carrying the top route's values for the
 * fields that table has, so the values follow the route. Returns the table
 * it routed to, or null when nothing known outranks the model.
 */
export function routeWhereKept<C extends RouteCandidate>(
  candidates: C[],
  menu: readonly ScanMenuEntry[],
  known: { tracked?: KeptTable | null; twins?: readonly KeptTable[] },
): ScanMenuEntry | null {
  const offered = [...(known.tracked ? [known.tracked] : []), ...(known.twins ?? [])];
  if (!offered.length) return null;
  // The record it already is decides on its own; twins only when there is none.
  const target = known.tracked ? (mostSpecific([known.tracked], menu) ?? mostSpecific(known.twins ?? [], menu)) : mostSpecific(offered, menu);
  if (!target) return null;
  const same = (c: C) => c.module === target.module && (c.instance ?? null) === (target.instance ?? null);
  const at = candidates.findIndex(same);
  if (at === 0) return null;
  const top = candidates[0];
  const lifted: C =
    at > 0
      ? candidates[at]!
      : ({
          module: target.module,
          instance: target.instance,
          kind: target.kind,
          label: target.label,
          fields: carriedFields(top?.fields ?? {}, target),
          basis: "kept",
        } as C);
  const rest = candidates.filter((_, i) => i !== at);
  candidates.splice(0, candidates.length, lifted, ...rest);
  return target;
}

/** The values a route held, for the fields another table also has. */
export function carriedFields(fields: Record<string, unknown>, to: Pick<ScanMenuEntry, "fields">): Record<string, unknown> {
  const names = new Set(to.fields.map((f) => f.name));
  return Object.fromEntries(Object.entries(fields).filter(([k]) => names.has(k)));
}
