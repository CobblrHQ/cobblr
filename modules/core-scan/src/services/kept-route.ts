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
import { scanBetterTable, type ScanResolverTable } from "@cobblr/platform-contract/scan-triage";
import type { FitItem } from "@cobblr/platform-contract/table-fit";

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
  return liftTo(candidates, target, "kept") ? target : null;
}

/** Put `target` at the top of `candidates`, in place: the model's own
 *  candidate for it whole, or a new one carrying the top route's values for
 *  the fields it has. False when it was already on top. */
function liftTo<C extends RouteCandidate>(candidates: C[], target: ScanMenuEntry, basis: string): boolean {
  const same = (c: C) => c.module === target.module && (c.instance ?? null) === (target.instance ?? null);
  const at = candidates.findIndex(same);
  if (at === 0) return false;
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
          basis,
        } as C);
  const rest = candidates.filter((_, i) => i !== at);
  candidates.splice(0, candidates.length, lifted, ...rest);
  return true;
}

// ── The values given with it say which list it belongs in (#4591) ─────────
//
// An agent added two Bambu Lab P1Ps with a bed size, and they went one to the
// Inventory catch-all and one to Machines, each refusing the bed size: the
// route was picked first and the values were placed after, so a field only
// 3D Printers has was thrown away instead of saying "this is a 3D printer".
// A value somebody gave is evidence the model's guess is not: when the routed
// table has no field for one of them and another table has them all, the
// thing goes there. Which one, when several have them all:
//
//   1. the model's own next choice among them (it named that table too);
//   2. else the only one;
//   3. else the module's catch-all, when that is one of them: the values say
//      "a machine", nothing more specific;
//   4. else no move: the values do not say which.
//
// Below a tracked match (the record this thing already is decides) and a
// person's chosen list, which is read before any route. Pure.

/** A table's field names, for the given-values rule. */
export type TableFieldNames = ReadonlyMap<string, ReadonlySet<string>>;

/** The field a value is for: a `<field>_note` rides beside its field. */
const fieldOfValue = (k: string) => (k.endsWith("_note") ? k.slice(0, -"_note".length) : k);

/** The tables that have a field for every one of `given`. */
export function tablesForGiven(given: readonly string[], menu: readonly ScanMenuEntry[], names: TableFieldNames): ScanMenuEntry[] {
  const wanted = [...new Set(given.map(fieldOfValue))];
  if (!wanted.length) return [];
  return menu.filter((e) => {
    const has = names.get(e.kind);
    return !!has && wanted.every((f) => has.has(f));
  });
}

/** Move the route to the table the given values belong to, in place.
 *  Returns that table, or null when the route already has them all or the
 *  values do not say. */
export function routeByGivenFields<C extends RouteCandidate>(
  candidates: C[],
  menu: readonly ScanMenuEntry[],
  given: readonly string[],
  names: TableFieldNames,
): ScanMenuEntry | null {
  const fitting = tablesForGiven(given, menu, names);
  if (!fitting.length) return null;
  const sameTable = (e: ScanMenuEntry, c: RouteCandidate) => c.module === e.module && (c.instance ?? null) === (e.instance ?? null);
  const top = candidates[0];
  if (top && fitting.some((e) => sameTable(e, top))) return null;
  const target =
    candidates.map((c) => fitting.find((e) => sameTable(e, c))).find((e): e is ScanMenuEntry => !!e) ??
    (fitting.length === 1 ? fitting[0] : null) ??
    (() => {
      const modules = new Set(fitting.map((e) => e.module));
      if (modules.size !== 1) return null;
      return fitting.find((e) => !e.instance) ?? null;
    })();
  if (!target) return null;
  return liftTo(candidates, target, "fields") ? target : null;
}

/** The values a route held, for the fields another table also has. */
export function carriedFields(fields: Record<string, unknown>, to: Pick<ScanMenuEntry, "fields">): Record<string, unknown> {
  const names = new Set(to.fields.map((f) => f.name));
  return Object.fromEntries(Object.entries(fields).filter(([k]) => names.has(k)));
}

// ── Where the workspace keeps things by the same maker (#4591) ────────────
//
// The owner's workspace kept two Bambu printers in 3D Printers when an agent
// added a Bambu Lab P1P, and it went to Machines (the model's guess) or the
// Inventory catch-all (the keyword fallback when the AI timed out). A catch-all
// route yields to the one list that already holds the same maker's things:
//
//   - a catch-all the model chose yields only to a list of its own module
//     (Machines to 3D Printers, never to the filament in Spools);
//   - a keyword fallback (no identification at all) yields to any list,
//     when exactly one holds that maker;
//   - two lists holding that maker say nothing; nor does a specific route.
//
// Below a tracked match, a person's choice and the given values. Pure: the
// caller says which lists hold a record by the maker.
/** Whether the route stands on a module's catch-all, the only route the
 *  same-maker rule may move (the caller checks before paying for the reads). */
export function onCatchAll(candidates: readonly RouteCandidate[]): boolean {
  const [top] = candidates;
  return !!top && !top.instance;
}

export function routeBySameMaker<C extends RouteCandidate>(
  candidates: C[],
  menu: readonly ScanMenuEntry[],
  listsWithMaker: ReadonlySet<string>,
): ScanMenuEntry | null {
  const top = candidates[0];
  if (!top || !onCatchAll(candidates)) return null;
  const guessed = top.basis !== "fallback";
  const lists = menu.filter((e) => !!e.instance && listsWithMaker.has(e.kind) && (!guessed || e.module === top.module));
  if (lists.length !== 1) return null;
  return liftTo(candidates, lists[0]!, "same-maker") ? lists[0]! : null;
}

// ── What the thing IS decides before who made it (#5065) ──────────────────
//
// A Bambu Lab P1P typed with only its maker, in a workspace with Bambu
// printers in 3D Printers and Bambu filament in Spools: the same maker says
// nothing, and the catch-all kept it. What the thing is (its catalog
// category, or what the matchmaker said it IS) names the list made for it, by
// the one fit rule (the contract's scanBetterTable, which the card reads
// too). So a catch-all route yields to the list the identity fits, before the
// same-maker rule is asked. Pure: the caller hands in the table the fit rule
// chose.
export function routeByIdentity<C extends RouteCandidate>(
  candidates: C[],
  menu: readonly ScanMenuEntry[],
  item: FitItem,
  tables: readonly ScanResolverTable[],
): ScanMenuEntry | null {
  const [top] = candidates;
  if (!top || !onCatchAll(candidates)) return null;
  const fits = scanBetterTable(item, top.kind ?? null, tables, top.module ?? null);
  if (!fits?.instance_name) return null;
  const target = menu.find((e) => e.instance === fits.instance_name && (!fits.module_name || e.module === fits.module_name));
  if (!target) return null;
  return liftTo(candidates, target, "identity") ? target : null;
}
