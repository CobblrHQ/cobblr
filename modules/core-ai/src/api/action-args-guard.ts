// An action invoked with none of the arguments it declares, or with one it
// does not take.
//
// The model picks the right action and drops what it takes: record-usage with
// no hours, remove-field with no field, place with no container. It got more
// common once the rail stopped listing argument names, and the answer is not a
// longer prompt - it is to hand the call back with the names in it.
//
// Pure, and shared: the app's chat loop uses it through validateWrite, and the
// bench's own loop uses it too. Without that sharing the bench measures a path
// the app no longer has, and reports as a model miss something the app would
// have corrected (which is exactly what the 2026-09-04 nightly did).

import { describeArgs, requiredArgsRefusal, type ActionArgSpec } from "@cobblr/platform-contract/action-args";

/** The schema's per-argument shape; `required` is the contract's flag
 *  (@cobblr/platform-contract/action-args), read here, by the invoke door
 *  and by the bench alike, so a call missing one is refused before it
 *  becomes a card that dies on press (#3123). */
export type ArgSpec = ActionArgSpec;

const NEXT = "Call invoke_action again with args filled from what the user said, or ask the user for the value you are missing.";

/** An argument the action does not declare is handed back, never carried to
 *  a card that shows it. "make Purchase Date required" became add-field with
 *  `required: true`; the card said Required: true, the action does not take
 *  it, and the field was saved optional (#7954). Every argument a handler
 *  reads is declared (lint:action-args-declared), so an undeclared one is a
 *  value that would be dropped after the person said yes to it. */
export function undeclaredActionArgs(
  actionId: string,
  schema: Record<string, ArgSpec> | null | undefined,
  given: unknown,
): string | null {
  const names = Object.keys(schema ?? {});
  if (names.length === 0 || !given || typeof given !== "object" || Array.isArray(given)) return null;
  const extra = Object.keys(given as Record<string, unknown>).filter((k) => !names.includes(k));
  if (!extra.length) return null;
  return `${actionId} does not take ${extra.join(", ")}, so ${extra.length === 1 ? "it" : "they"} would be dropped after the person confirms. It takes: ${describeArgs(schema, names)}. Call it again without ${extra.length === 1 ? "it" : "them"}, and do what ${extra.length === 1 ? "it" : "they"} asked with the action that takes ${extra.length === 1 ? "it" : "them"}, or tell the user it cannot be done this way.`;
}

/** The message to hand back, or null when the call is fine as written. */
export function missingActionArgs(
  actionId: string,
  schema: Record<string, ArgSpec> | null | undefined,
  given: unknown,
): string | null {
  if (Object.keys(schema ?? {}).length === 0) return null;
  const refused = requiredArgsRefusal(actionId, schema, given);
  if (refused) return `${refused} ${NEXT}`;
  const passed = given && typeof given === "object" ? Object.keys(given as Record<string, unknown>) : [];
  if (passed.length > 0) return null;
  // `required: false` says the action runs without it (core-placement:remove
  // runs on its record alone; `expected` is for its own Undo). An argument
  // that says nothing is still asked for: older declarations leave
  // `required` off arguments the handler cannot do without.
  const names = Object.entries(schema ?? {}).filter(([, spec]) => spec?.required !== false).map(([name]) => name);
  if (names.length === 0) return null;
  return `${actionId} takes arguments and none were given: ${describeArgs(schema, names)}. ${NEXT}`;
}

// The other half of the same miss: the model picks the right action, supplies
// the right VALUE, and spells the parameter its own way.
//
//   "turn off shipments"  ->  platform:disable-module  args {name: "shipments"}
//
// Everything about that call is correct except the key: the schema calls it
// `module`. The check above cannot see it - arguments WERE given - so the call
// went through with no module and the user was shown a proposal to turn off
// nothing. (Nightly bench, every run to 2026-09-08.)
//
// This is the same class the action-id resolver already handles one level up,
// where `platform:group_fields` is corrected to `platform:group-fields` in
// place: the model chose right and typed the separator its own way. Refusing
// the turn over a spelling teaches nobody anything.
//
// Two corrections, in order, both conservative:
//   1. NAME - a given key that matches a schema key once punctuation and case
//      are removed (moduleName/Module -> module), or that CONTAINS it as a
//      whole word (module_name -> module), when exactly one argument matches.
//   2. POSITION - when exactly ONE schema argument is still unfilled and
//      exactly ONE given value is still unclaimed, and that value is the type
//      the argument declares, bind it. One value for one argument is not
//      ambiguous; dropping it on the floor is just a worse guess.
// Anything else is left alone for the check above (or the user) to catch.
// Actions always keep the confirm gate, so a corrected call is still a card
// the person reads before anything happens.

// ascii-only: an argument or field KEY (module_name, fieldId), never a value somebody typed
const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** module_name -> ["module","name"]; fieldId -> ["field","id"]. */
const words = (s: string): string[] =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/) // ascii-only: the words of a key, as above
    .map((w) => w.toLowerCase())
    .filter(Boolean);

export interface ReconciledArgs {
  args: Record<string, unknown>;
  /** [givenKey, schemaKey] for each correction, for logging/tests. */
  renamed: Array<[string, string]>;
}

export function reconcileActionArgs(
  schema: Record<string, ArgSpec> | null | undefined,
  given: unknown,
): ReconciledArgs | null {
  const names = Object.keys(schema ?? {});
  if (names.length === 0) return null;
  if (!given || typeof given !== "object" || Array.isArray(given)) return null;
  const src = given as Record<string, unknown>;
  const keys = Object.keys(src);
  if (keys.length === 0) return null;

  const out: Record<string, unknown> = {};
  const renamed: Array<[string, string]> = [];
  const leftoverKeys: string[] = [];
  const byNorm = new Map(names.map((n) => [norm(n), n]));

  for (const k of keys) {
    if (names.includes(k)) {
      out[k] = src[k];
      continue;
    }
    const hit = byNorm.get(norm(k));
    if (hit !== undefined && out[hit] === undefined) {
      out[hit] = src[k];
      renamed.push([k, hit]);
      continue;
    }
    const given = new Set(words(k));
    const contained = names.filter((n) => out[n] === undefined && words(n).every((w) => given.has(w)));
    if (contained.length === 1) {
      const target = contained[0]!;
      out[target] = src[k];
      renamed.push([k, target]);
      continue;
    }
    leftoverKeys.push(k);
  }

  const unfilled = names.filter((n) => out[n] === undefined);
  if (unfilled.length === 1 && leftoverKeys.length === 1) {
    const target = unfilled[0]!;
    const from = leftoverKeys[0]!;
    const value = src[from];
    const type = schema?.[target]?.type ?? "text";
    const fits =
      (type === "number" && typeof value === "number") ||
      (type !== "number" && typeof value === "string" && value.trim() !== "");
    if (fits) {
      out[target] = value;
      renamed.push([from, target]);
      leftoverKeys.length = 0;
    }
  }

  // Anything still unclaimed rides along untouched: the action's own handler
  // validates, and silently deleting what the model sent would hide a real
  // mistake behind a guess.
  for (const k of leftoverKeys) out[k] = src[k];
  return renamed.length > 0 ? { args: out, renamed } : null;
}

// The record an action runs on, given as one of its arguments.
//
//   "log 12 prints on the X1 Carbon"  ->  machines:record-usage
//     args {prints: 12, machineId: "<the X1's id>"}, and no record
//
// The model found the machine and named it: as the argument the action
// declares for wires (machineId), not as the record the call runs on. The
// door refused "entityKind and entityId are required for this action (it runs
// on a record)", and the bench read it as a miss on three asks of three
// (#8331, nightly 2026-10-27). The same class as reconcileActionArgs: the
// right record, said in the wrong place. It is lifted into the call's record
// when the argument is named for one of the kinds the action runs on
// (machineId -> machines:machine) and holds an id; the argument stays, since
// the action declares it. Anything less sure is left for the door to refuse.

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function recordTargetInArgs(
  kinds: readonly string[],
  given: unknown,
): { kind: string; id: string } | null {
  if (!kinds.length || !given || typeof given !== "object" || Array.isArray(given)) return null;
  const typeOf = (kind: string) => words(kind.split(":").pop() ?? "").join("");
  const found = new Map<string, string>();
  for (const [key, value] of Object.entries(given as Record<string, unknown>)) {
    if (typeof value !== "string" || !ID.test(value)) continue;
    const w = words(key);
    if (w.at(-1) !== "id" || w.length < 2) continue;
    const stem = w.slice(0, -1).join("");
    const kind = kinds.find((k) => typeOf(k) === stem);
    if (kind && !found.has(kind)) found.set(kind, value);
  }
  if (found.size !== 1) return null;
  const [kind, id] = [...found.entries()][0]!;
  return { kind, id };
}

// The other way round: the record named as the call's own, for an action that
// takes its records as arguments.
//
//   "lend the cordless drill to Sam until Friday"  ->  platform:lend
//     entity_kind: "inventory:part", entity_id: "<the drill>", args {holder: "Sam"}
//
// platform:lend runs on the workspace and takes the records it lends as
// entity_kind and ids. The model named the drill as the call's record, four
// rounds running, each refused "requires entity_kind ... the call does not
// carry it", and the turn ended with nothing lent (#8738 walk, 2026-10-28).
// The call's record is the record the action means: it fills entity_kind and
// ids when the arguments leave them out, and nothing it does not declare.

export function argsFromCallRecord(
  schema: Record<string, ArgSpec> | null | undefined,
  given: unknown,
  record: { kind?: unknown; id?: unknown },
): Record<string, unknown> | null {
  const names = Object.keys(schema ?? {});
  const kind = typeof record.kind === "string" && record.kind ? record.kind : null;
  const id = typeof record.id === "string" && record.id ? record.id : null;
  if (!kind || !names.length) return null;
  if (given !== undefined && given !== null && (typeof given !== "object" || Array.isArray(given))) return null;
  const out: Record<string, unknown> = { ...((given as Record<string, unknown> | undefined) ?? {}) };
  let filled = false;
  if (names.includes("entity_kind") && !out.entity_kind) {
    out.entity_kind = kind;
    filled = true;
  }
  if (id && names.includes("ids") && !(Array.isArray(out.ids) && out.ids.length)) {
    out.ids = [id];
    filled = true;
  }
  return filled ? out : null;
}
