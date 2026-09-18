// Which of an action's arguments a call must carry.
//
// An action's args_schema names its arguments; `required: true` on one says
// the handler cannot do without it. This is the one reading of that flag:
// the invoke door refuses a call missing one before the handler runs, the
// assistant's guard hands the call back to the model with the names in it,
// and the bench judges the same way. Before this, the schema carried no such
// flag, the door let an argument-less call through, and the model's call
// became a card that read right and died on press ("on must be true or
// false", "target and name are required"), six times in one corpus pass and
// as often for a person (#3123).
//
// A blank string is not a value: "" for a unit code is no code. `false` and
// `0` are values.

export interface ActionArgSpec {
  label?: string;
  type?: string;
  required?: boolean;
  /** Required as a group: every argument naming the same group is one way
   *  to satisfy it, and the call must carry at least one of them
   *  ("fields or rename_to" on group-fields). What `required` cannot say. */
  oneOf?: string;
}

/** Absent, null, or a blank string. */
export function argAbsent(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

/** The required arguments the call does not carry, in schema order. */
export function requiredArgsMissing(
  schema: Record<string, ActionArgSpec> | null | undefined,
  given: unknown,
): string[] {
  const src = given && typeof given === "object" && !Array.isArray(given) ? (given as Record<string, unknown>) : {};
  return Object.entries(schema ?? {})
    .filter(([name, spec]) => spec?.required === true && argAbsent(src[name]))
    .map(([name]) => name);
}

/** The groups (see `oneOf`) of which the call carries no member, each as
 *  its members in schema order. */
export function requiredGroupsMissing(
  schema: Record<string, ActionArgSpec> | null | undefined,
  given: unknown,
): string[][] {
  const src = given && typeof given === "object" && !Array.isArray(given) ? (given as Record<string, unknown>) : {};
  const groups = new Map<string, string[]>();
  for (const [name, spec] of Object.entries(schema ?? {})) {
    if (!spec?.oneOf) continue;
    groups.set(spec.oneOf, [...(groups.get(spec.oneOf) ?? []), name]);
  }
  return [...groups.values()].filter((members) => members.every((n) => argAbsent(src[n])));
}

/** `name (label)` for each, the way a refusal names them. */
export function describeArgs(schema: Record<string, ActionArgSpec> | null | undefined, names: readonly string[]): string {
  return names.map((n) => `${n}${schema?.[n]?.label ? ` (${schema[n]!.label})` : ""}`).join(", ");
}

/** The door's refusal, or null when every required argument is there. */
export function requiredArgsRefusal(
  actionId: string,
  schema: Record<string, ActionArgSpec> | null | undefined,
  given: unknown,
): string | null {
  const missing = requiredArgsMissing(schema, given);
  const groups = requiredGroupsMissing(schema, given);
  if (missing.length === 0 && groups.length === 0) return null;
  const parts: string[] = [];
  if (missing.length) parts.push(describeArgs(schema, missing));
  for (const g of groups) parts.push(`one of ${describeArgs(schema, g)}`);
  return `${actionId} requires ${parts.join(", and ")}, and the call does not carry ${missing.length + groups.length === 1 ? "it" : "them"}.`;
}
