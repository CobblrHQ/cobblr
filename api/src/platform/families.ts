// A workspace's families, read where every platform reader can use them.
//
// A bundle can declare one collection as the TYPES of another's things (the
// Filament bundle: spools under filament types), as `parent` in the child
// collection's instance config. The inventory module works the pair; this is
// the kernel's read of the same declaration, for the readers that decide
// what a record shows and says without knowing any module:
//   - a type collection wears no faces and offers none (facesForKind): a type
//     describes things, its things are what is stocked, lent or serviced, so
//     a type's page offering "+ Stock" or listing serial numbers reads as a
//     spool's page (#3990);
//   - the link between a thing and its type reads in words ("type", "spool"),
//     never as its stored key ("instance of this"), and is not removed from a
//     record's Links: the thing's type is changed where types are kept.
//
// Meta-side only: the declaration lives in the instance override rows.

import { listOverrides } from "./entity-kind-overrides.js";
import { perReadRequest } from "../lib/request-context.js";

export interface FamilyLink {
  /** The type collection's instance name ("filament-types"). */
  parent: string;
  /** The things' instance name ("filament"). */
  child: string;
  /** The pairing's relationship kind, thing → type. */
  rel: string;
  /** What a thing calls its type ("type"). */
  parentWord: string;
  /** What a type calls one of its things ("spool"). */
  childWord: string;
}

type ParentConfig = { instance?: unknown; label?: unknown; relationship_kind?: unknown };

/** The families declared in a set of override rows. Pure. */
export function familiesFromOverrides(rows: ReadonlyArray<{ target_kind: string; target_id: string; config: unknown }>): FamilyLink[] {
  const nounOf = new Map<string, string>();
  for (const r of rows) {
    if (r.target_kind !== "instance") continue;
    const name = String(r.target_id).split(":")[1];
    const noun = (r.config as { item_noun?: unknown } | null)?.item_noun;
    if (name && typeof noun === "string" && noun.trim()) nounOf.set(name, noun.trim());
  }
  const out: FamilyLink[] = [];
  for (const r of rows) {
    if (r.target_kind !== "instance") continue;
    const child = String(r.target_id).split(":")[1];
    const parent = (r.config as { parent?: ParentConfig | null } | null)?.parent;
    if (!child || !parent || typeof parent.instance !== "string" || !parent.instance) continue;
    const label = typeof parent.label === "string" && parent.label.trim() ? parent.label.trim() : (nounOf.get(parent.instance) ?? "type");
    out.push({
      parent: parent.instance,
      child,
      rel: typeof parent.relationship_kind === "string" && parent.relationship_kind ? parent.relationship_kind : "instance-of",
      parentWord: label.toLowerCase(),
      childWord: nounOf.get(child) ?? "item",
    });
  }
  return out;
}

export async function familiesOf(orgId: string): Promise<FamilyLink[]> {
  return familiesFromOverrides(await perReadRequest(`families:${orgId}`, () => listOverrides(orgId)));
}

/** Is this kind (`<instance>:item`) a family's type collection? */
export function isTypeCollection(families: readonly FamilyLink[], kind: string): boolean {
  const [instance, tail] = kind.split(":");
  return tail === "item" && families.some((f) => f.parent === instance);
}
