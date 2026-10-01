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

import { amountOf, parseMoney } from "@cobblr/platform-contract/money";

export interface ArgChoice {
  value: string;
  label: string;
}

/** Where an argument's choices come from when they depend on the record's
 *  kind rather than the manifest: `counters` is the usage counters the kind
 *  keeps ("print hours"); `people` is the workspace's People list (a
 *  "who" argument). The server resolves it into `choices` when it
 *  lists a kind's actions, so a form never has to know. */
export type ArgChoicesFrom = "counters" | "people";

export interface ActionArgSpec {
  label?: string;
  type?: string;
  required?: boolean;
  /** Required as a group: every argument naming the same group is one way
   *  to satisfy it, and the call must carry at least one of them
   *  ("fields or rename_to" on group-fields). What `required` cannot say. */
  oneOf?: string;
  /** The values this argument may take, in the words a person picks from. */
  choices?: readonly ArgChoice[];
  choicesFrom?: ArgChoicesFrom;
  /** An amount of money as a person says it ("$45.50"); never cents. */
  money?: boolean;
  /** Offered on the button's sheet although the action runs without it.
   *  Only what `required` (or a `oneOf` group) names was ever asked, so an
   *  optional answer a person often has ("due back on", "last done on") had
   *  no box to go in from a press, only from the assistant. */
  ask?: boolean;
  /** Asked, and required, together with that argument: either both or
   *  neither. "Every 3" means nothing without "months", and the form let a
   *  person send it alone until the door refused it in a handler's words
   *  (#3991). */
  with?: string;
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

/** Arguments the call carries whose `with` partner it does not, as
 *  [carried, missing] pairs in schema order. */
export function pairedArgsMissing(
  schema: Record<string, ActionArgSpec> | null | undefined,
  given: unknown,
): [string, string][] {
  const src = given && typeof given === "object" && !Array.isArray(given) ? (given as Record<string, unknown>) : {};
  const out: [string, string][] = [];
  for (const [name, spec] of Object.entries(schema ?? {})) {
    const partner = spec?.with;
    if (!partner || !(partner in (schema ?? {}))) continue;
    if (!argAbsent(src[name]) && argAbsent(src[partner])) out.push([name, partner]);
  }
  return out;
}

/** The door's refusal, or null when every required argument is there. */
export function requiredArgsRefusal(
  actionId: string,
  schema: Record<string, ActionArgSpec> | null | undefined,
  given: unknown,
): string | null {
  const missing = requiredArgsMissing(schema, given);
  const groups = requiredGroupsMissing(schema, given);
  const pairs = pairedArgsMissing(schema, given);
  if (missing.length === 0 && groups.length === 0 && pairs.length === 0) return null;
  const parts: string[] = [];
  if (missing.length) parts.push(describeArgs(schema, missing));
  for (const g of groups) parts.push(`one of ${describeArgs(schema, g)}`);
  for (const [carried, partner] of pairs) parts.push(`${describeArgs(schema, [partner])} with ${carried}`);
  return `${actionId} requires ${parts.join(", and ")}, and the call does not carry ${missing.length + groups.length + pairs.length === 1 ? "it" : "them"}.`;
}

/** One question a button asks before it runs. `required`: the action cannot
 *  run without it (the door would refuse). `oneOf`: at least one of the
 *  questions naming the same group must be answered. */
export interface PressAsk {
  arg: string;
  label: string;
  kind: "text" | "number" | "boolean" | "choice" | "date" | "money";
  placeholder?: string;
  required?: boolean;
  oneOf?: string;
  /** For a choice: what may be picked. */
  choices?: readonly ArgChoice[];
  /** Answered together with this argument, or not at all. */
  with?: string;
}

function askKind(spec: ActionArgSpec | undefined): PressAsk["kind"] {
  if (spec?.choices) return "choice";
  if (spec?.money) return "money";
  return spec?.type === "number" ? "number" : spec?.type === "boolean" ? "boolean" : spec?.type === "date" ? "date" : "text";
}

function askOf(name: string, spec: ActionArgSpec | undefined): PressAsk {
  return {
    arg: name,
    label: spec?.label ?? name,
    kind: askKind(spec),
    ...(spec?.oneOf ? { oneOf: spec.oneOf } : {}),
    ...(spec?.choices ? { choices: spec.choices } : {}),
    ...(spec?.with ? { with: spec.with } : {}),
  };
}

/** A choice with nothing to pick cannot be answered: its pair is not asked
 *  (a record kind that keeps no counters is never asked "every how much
 *  use"). */
function unanswerable(schema: Record<string, ActionArgSpec> | null | undefined, name: string): boolean {
  const spec = schema?.[name];
  const partner = spec?.with ? schema?.[spec.with] : undefined;
  const empty = (s: ActionArgSpec | undefined) => !!s && (!!s.choicesFrom || !!s.choices) && (s.choices?.length ?? 0) === 0;
  return empty(spec) || empty(partner);
}

/** What a press must ask before it runs: the button's own questions (a
 *  binding's optional `ask`), then every argument the action requires that
 *  the button does not already carry. LOG SERVICE fired bare for ten days
 *  and every press met the door's refusal, because no button knew its
 *  action required "What was done" (#3865). Empty when the press can run
 *  as it is. */
export function askBeforePress(
  schema: Record<string, ActionArgSpec> | null | undefined,
  fixed: unknown,
  own: readonly { arg: string; label: string; kind?: "text" | "number"; placeholder?: string }[] = [],
): PressAsk[] {
  const missing = new Set(requiredArgsMissing(schema, fixed));
  const groups = requiredGroupsMissing(schema, fixed);
  const out: PressAsk[] = own.map((q) => ({
    arg: q.arg,
    label: q.label,
    kind: q.kind ?? "text",
    ...(q.placeholder ? { placeholder: q.placeholder } : {}),
    ...(missing.has(q.arg) ? { required: true } : {}),
  }));
  const asked = new Set(out.map((q) => q.arg));
  for (const name of missing) {
    if (asked.has(name)) continue;
    out.push({ ...askOf(name, schema?.[name]), required: true });
    asked.add(name);
  }
  for (const members of groups) {
    for (const name of members) {
      if (unanswerable(schema, name)) continue;
      const spec = schema?.[name];
      const existing = out.find((q) => q.arg === name);
      if (existing) existing.oneOf = spec?.oneOf;
      else out.push(askOf(name, spec));
      asked.add(name);
    }
  }
  // Then the optional ones the action offers on its sheet, in schema order.
  for (const [name, spec] of Object.entries(schema ?? {})) {
    if (!spec?.ask || asked.has(name) || unanswerable(schema, name)) continue;
    out.push(askOf(name, spec));
    asked.add(name);
  }
  // Every asked argument brings its partner, right after it.
  for (let i = 0; i < out.length; i++) {
    const partner = schema?.[out[i]!.arg]?.with;
    if (!partner || asked.has(partner) || !schema?.[partner]) continue;
    out.splice(i + 1, 0, askOf(partner, schema[partner]));
    asked.add(partner);
  }
  return out;
}

/** The answers, as the action's arguments: blanks left out, a number as a
 *  number, a yes/no as a boolean. */
export function pressAnswersToArgs(ask: readonly PressAsk[], answers: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const q of ask) {
    const v = (answers[q.arg] ?? "").trim();
    if (!v) continue;
    if (q.kind === "number") {
      const n = Number(v);
      if (Number.isFinite(n)) out[q.arg] = n;
    } else if (q.kind === "money") {
      // The amount, as the person meant it: "4,300" is 4300.
      const c = parseMoney(v);
      if (c !== null) out[q.arg] = amountOf(c);
    } else if (q.kind === "boolean") out[q.arg] = v === "true";
    else if (q.kind === "choice") {
      if (!q.choices || q.choices.some((c) => c.value === v)) out[q.arg] = v;
    }
    else out[q.arg] = v.slice(0, 1000);
  }
  return out;
}

/** The questions still unanswered that stop the press, by label; empty when
 *  it may run. The sheet's run button waits on this, so what it sends is
 *  never something the door refuses. */
export function pressStillNeeds(ask: readonly PressAsk[], answers: Record<string, string>): string[] {
  const blank = (q: PressAsk) => !(answers[q.arg] ?? "").trim();
  const byArg = new Map(ask.map((q) => [q.arg, q]));
  const out = ask.filter((q) => q.required && blank(q)).map((q) => q.label);
  const groups = new Map<string, PressAsk[]>();
  for (const q of ask) if (q.oneOf) groups.set(q.oneOf, [...(groups.get(q.oneOf) ?? []), q]);
  const unstarted = new Set<string>();
  for (const [group, members] of groups) {
    if (members.every(blank)) {
      out.push(members.map((q) => q.label).join(" or "));
      unstarted.add(group);
    }
  }
  // Half a pair is not an answer: "every 3" waits for "months".
  for (const q of ask) {
    const partner = q.with ? byArg.get(q.with) : undefined;
    if (!partner || blank(q) || !blank(partner)) continue;
    if (partner.oneOf && unstarted.has(partner.oneOf)) continue;
    if (!out.includes(partner.label)) out.push(partner.label);
  }
  return out;
}
