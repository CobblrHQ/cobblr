// An action invoked with none of the arguments it declares.
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

export interface ArgSpec {
  label?: string;
  type?: string;
}

/** The message to hand back, or null when the call is fine as written. */
export function missingActionArgs(
  actionId: string,
  schema: Record<string, ArgSpec> | null | undefined,
  given: unknown,
): string | null {
  const names = Object.keys(schema ?? {});
  if (names.length === 0) return null;
  const passed = given && typeof given === "object" ? Object.keys(given as Record<string, unknown>) : [];
  if (passed.length > 0) return null;
  const described = names.map((n) => `${n}${schema?.[n]?.label ? ` (${schema[n]!.label})` : ""}`).join(", ");
  return `${actionId} takes arguments and none were given: ${described}. Call invoke_action again with args filled from what the user said, or ask the user for the value you are missing.`;
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

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** module_name -> ["module","name"]; fieldId -> ["field","id"]. */
const words = (s: string): string[] =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
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
