// What a collection wears - the one place that resolves it.
//
// A kind DECLARES traits; a collection WEARS them. The two differ, and the
// substrate doc says why: the same twenty laptops are a count in a shop and
// twenty individuals in an IT department. Nothing about the laptops changed;
// the collection resolves identity differently. This resolver produces that
// per-collection map, on the six declared axes and the two trial axes, and
// the faces a person sees are read off it (facesOf, in the contract).
//
// Three layers, in order:
//   1. the kind's declared traits, as listKindsForOrg already synthesises them
//      per instance (a lean instance is catalog-record here already);
//   2. the trial axes from their signals: an `expiry` field role makes the
//      collection perishable, an `assignee` role makes it lendable;
//   3. the collection's explicit choices under config `faces`, one face at a
//      time, written by a bundle, the Presentation page, or a tap on a record.
//
// Meta-side only (traits, field roles, the override blob), so it runs on the
// paths that list actions and kinds without opening a tenant pool.

import {
  axisOfTrait,
  resolveFaces,
  FACE_NAMES,
  type CollectionTraits,
  type FaceConfig,
  type FaceName,
  type FaceVerdict,
} from "@cobblr/platform-contract";
import { meta } from "../db/meta.js";
import { getKind, listKindsForOrg, baseKindOf } from "./entities.js";

/** The stored explicit choices for a kind: an instance's own config, or the
 *  entity-kind override for a module's base kind. */
async function explicitFaces(orgId: string, kind: string): Promise<FaceConfig> {
  const [head, tail] = kind.split(":");
  // `<instance>:item` is an instance kind; its config row is keyed by the
  // owning module, which the instance table knows. Anything else, and an
  // instance the table does not know, reads the entity-kind override.
  const owner = tail === "item" && head ? await moduleOfInstance(orgId, head) : null;
  const target = owner
    ? { target_kind: "instance", target_id: `${owner}:${head}` }
    : { target_kind: "entity_kind", target_id: kind };
  const row = await meta
    .selectFrom("entity_kind_overrides")
    .select("config")
    .where("org_id", "=", orgId)
    .where("target_kind", "=", target.target_kind)
    .where("target_id", "=", target.target_id)
    .executeTakeFirst();
  const cfg = (row?.config as { faces?: FaceConfig } | null)?.faces;
  return cfg && typeof cfg === "object" ? cfg : {};
}

async function moduleOfInstance(orgId: string, instanceName: string): Promise<string | null> {
  const row = await meta
    .selectFrom("workspace_module_instances")
    .select("module_name")
    .where("org_id", "=", orgId)
    .where("instance_name", "=", instanceName)
    .executeTakeFirst();
  return row?.module_name ?? null;
}

/** The workspace's own field roles on this kind (and its base). */
async function fieldRoles(orgId: string, kinds: string[]): Promise<Set<string>> {
  try {
    const rows = await meta
      .selectFrom("module_field_defs")
      .select("field_role")
      .where("org_id", "=", orgId)
      .where("entity_kind", "in", [...new Set(kinds)])
      .where("field_role", "is not", null)
      .execute();
    return new Set(rows.map((r) => r.field_role).filter((r): r is string => typeof r === "string"));
  } catch {
    return new Set();
  }
}

/** A kind's declared trait map, flattened to one value per axis.
 *
 *  An `{ trait, uncertain }` value is kept for MATCHING (a label prints on a
 *  book the catalog is not sure is physical, as it always has) and dropped
 *  for what a record SHOWS (`forFaces`): "physical, uncertain" plus unique
 *  must not put a service log on a film. Bias lean, the substrate doc's
 *  first guardrail. */
export function flattenTraits(traits: Record<string, unknown> | null | undefined, opts: { forFaces?: boolean } = {}): CollectionTraits {
  const out: CollectionTraits = {};
  for (const v of Object.values(traits ?? {})) {
    const uncertain = !!(v && typeof v === "object" && (v as { uncertain?: unknown }).uncertain === true);
    if (uncertain && opts.forFaces) continue;
    const name = typeof v === "string" ? v : v && typeof v === "object" && typeof (v as { trait?: unknown }).trait === "string" ? (v as { trait: string }).trait : null;
    const axis = name ? axisOfTrait(name) : undefined;
    if (name && axis) (out as Record<string, string>)[axis] = name;
  }
  return out;
}

/** Layers 1 and 2: the declared traits plus the trial axes from their
 *  signals. Pure, so the decisions are testable without a database. */
export function derivedCollectionTraits(input: {
  traits: Record<string, unknown> | null;
  roles: ReadonlySet<string>;
  /** Drop uncertain declared values: the view a record shows, not the map
   *  an action matches against. */
  forFaces?: boolean;
}): CollectionTraits {
  const out = flattenTraits(input.traits, { forFaces: input.forFaces });
  // A "Best before" field is the whole signal that something goes off; an
  // "assignee" field is the one honest signal that it gets lent.
  out.spoilage = input.roles.has("expiry") ? "perishable" : "keeps";
  out.custody = input.roles.has("assignee") ? "lendable" : "kept";
  return out;
}

/** The verdict for one kind in one workspace. */
export async function facesForKind(orgId: string, kind: string): Promise<FaceVerdict> {
  let rec = await getKind(kind);
  if (!rec) rec = (await listKindsForOrg(orgId)).find((k) => k.id === kind) ?? null;
  const base = await baseKindOf(orgId, kind);
  const [explicit, roles] = await Promise.all([explicitFaces(orgId, kind), fieldRoles(orgId, [kind, base])]);
  const declared = (rec?.traits as Record<string, unknown> | null) ?? null;
  // "Serialized" is unique on a kind DECLARED fungible: the declaration comes
  // from the module's base kind, not from what this collection resolved.
  const baseRec = base === kind ? rec : await getKind(base);
  const declaredIdentity = flattenTraits((baseRec?.traits as Record<string, unknown> | null) ?? null).identity ?? null;
  // Two maps from one declaration: what an action matches against (uncertain
  // values kept) and what a record shows (uncertain values dropped). The
  // person's choices apply to both the same way: an On asserts, an Off hides.
  const { traits } = resolveFaces(derivedCollectionTraits({ traits: declared, roles }), explicit, declaredIdentity);
  const { faces } = resolveFaces(derivedCollectionTraits({ traits: declared, roles, forFaces: true }), explicit, declaredIdentity);
  return {
    kind,
    traits,
    faces,
    explicit: FACE_NAMES.filter((f: FaceName) => typeof explicit[f] === "boolean"),
  };
}
