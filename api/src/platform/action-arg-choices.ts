// What an action's arguments pick from, filled for one kind: a `choicesFrom`
// argument ("counters": the usage counters the kind keeps; "people": the
// workspace's People) gains the `choices` a form offers. One implementation
// for every door that shows an action's form: the actions list (GET
// /actions?kind=) and a Station's own door (core-scan), so a kiosk's Lend
// offers the same names a record page does (#4640).
import { platform } from "@cobblr/platform-contract";
import { listPeople } from "./people.js";

/** The kind's own choices put into its actions' argument schemas: an
 *  argument whose choices depend on the kind (`choicesFrom: "counters"`)
 *  gets the counters this kind keeps, so the form offers "Print hours" and
 *  never asks for a field name (#3991). A kind that keeps none gets an empty
 *  list, and the form leaves that pair unasked. */
export async function argChoicesFor(orgId: string, kind: string, schemas: readonly unknown[]): Promise<(schema: unknown) => unknown> {
  type Spec = { choicesFrom?: string } & Record<string, unknown>;
  const specsOf = (schema: unknown): [string, Spec][] =>
    schema && typeof schema === "object" ? Object.entries(schema as Record<string, Spec>) : [];
  const wants = (from: string) => schemas.some((schema) => specsOf(schema).some(([, spec]) => spec?.choicesFrom === from));
  let counters: { value: string; label: string }[] = [];
  if (wants("counters")) {
    counters = (await platform().entities.countersFor(orgId, kind).catch(() => [])).map((d) => ({ value: d.key, label: d.label }));
  }
  // The workspace's People (members and anyone listed by name): what a
  // "who" argument picks from, so "lend it to" is a list of names, never an id.
  let people: { value: string; label: string }[] = [];
  if (wants("people")) {
    people = (await listPeople(orgId).catch(() => [])).map((p) => ({ value: p.id, label: p.name }));
  }
  const choicesOf = (from: unknown) => (from === "counters" ? counters : from === "people" ? people : null);
  return (schema) => {
    const entries = specsOf(schema);
    if (!entries.some(([, spec]) => spec?.choicesFrom)) return schema;
    return Object.fromEntries(entries.map(([name, spec]) => [name, choicesOf(spec?.choicesFrom) ? { ...spec, choices: choicesOf(spec?.choicesFrom) } : spec]));
  };
}
