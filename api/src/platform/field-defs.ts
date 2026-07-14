// The ONE place that answers "which custom field defs apply to this entity kind?"
//
// Two kinds of row live in module_field_defs:
//
//   • per-kind      entity_kind = "inventory:part", applies_to = null
//                   — the default, and what every row was before P1.
//   • trait-scoped  entity_kind = a scope SENTINEL ("@physical"), applies_to = an
//                   ActionAppliesTo predicate. ONE row that lands on every kind
//                   whose TRAITS satisfy it ("Origin", on everything physical the
//                   workspace tracks). A new physical kind — a module installed
//                   next month, a bundle's instance — inherits it with no
//                   migration and no re-creation. That's the point.
//
// A scope is a predicate over an entity kind, which is exactly what an action's
// `appliesTo` is — so scoped defs are matched with the SAME matcher the action
// registry uses (matchAction). One matcher, one vocabulary, not two.
//
// NORMALIZATION (the load-bearing trick): a scoped def is returned with its
// `entity_kind` rewritten to the kind it resolved FOR. Downstream — the
// native_field_overrides join, write validation, the form renderer, the CSV
// importer — it is then indistinguishable from a per-kind def, so all of that
// keeps working untouched AND per-kind relabel/hide/reorder of a scoped field
// comes for free (the override layer keys on entity_kind + name). The sentinel
// rides along as `scope` so a UI can badge it "workspace-wide" and warn that an
// edit reaches every kind.
//
// See docs/design-decisions/trait-scoped-fields.md.

import type { Selectable } from "kysely";
import {
  fieldScopeLabel,
  isFieldScope,
  parseFieldScope,
  type ActionAppliesToDecl,
} from "@cobblr/platform-contract";
import { meta } from "../db/meta.js";
import type { ModuleFieldDefsTable } from "../db/schema.js";
import { matchAction } from "./actions.js";
import { getKind, listKindsForOrg } from "./entities.js";

export type FieldDefRow = Selectable<ModuleFieldDefsTable>;

/** A def as it applies to ONE kind. `scope` is the sentinel it came from (null for
 *  an ordinary per-kind def) and `scope_label` is that sentinel in words — the UI
 *  must never render a raw `@physical+unique` at a user. */
export type ResolvedFieldDef = FieldDefRow & {
  scope: string | null;
  scope_label: string | null;
};

/** The kind's shape, as the matcher needs it. Instance kinds (`vehicles:item`)
 *  aren't rows in entity_kinds — they're synthesized from their module's primary
 *  kind and INHERIT its traits — so we fall back to the org-aware listing for
 *  them. Base kinds take the single indexed row lookup and never pay for it. */
async function kindShape(
  orgId: string,
  kind: string,
): Promise<{ fields: { role?: string }[]; traits: Record<string, unknown> | null } | null> {
  const direct = await getKind(kind);
  if (direct) return { fields: direct.fields, traits: direct.traits };
  const all = await listKindsForOrg(orgId);
  const found = all.find((k) => k.id === kind);
  return found ? { fields: found.fields, traits: found.traits } : null;
}

/**
 * Every field def that applies to `kind` in this org: its own per-kind defs,
 * plus every trait-scoped def whose predicate the kind satisfies.
 *
 * Precedence — MOST SPECIFIC WINS. A per-kind def named `origin` beats a
 * trait-scoped `origin`; the scoped one is dropped, not merged. That makes
 * "override the workspace-wide field on just this kind" a supported move rather
 * than a duplicate-field bug.
 *
 * Ordering: scoped defs sort AFTER the kind's own defs by default (their stored
 * position is offset past the last per-kind one), so a workspace-wide field
 * doesn't shove itself above a kind's core fields. A per-kind override position
 * still moves it anywhere — the override layer is applied by the caller and wins.
 */
export async function resolveFieldDefsForKind(
  orgId: string,
  kind: string,
): Promise<ResolvedFieldDef[]> {
  // One query for both classes of row — a workspace has tens of defs, not
  // thousands, and this keeps the resolver a single round-trip.
  const rows = await meta
    .selectFrom("module_field_defs")
    .selectAll()
    .where("org_id", "=", orgId)
    .where((eb) =>
      eb.or([eb("entity_kind", "=", kind), eb("applies_to", "is not", null)]),
    )
    .orderBy("position")
    .execute();

  // Anything keyed directly to this kind is its own, full stop — that's the most
  // specific a def can be. Everything else in the result set is a scope.
  const own = rows.filter((r) => r.entity_kind === kind);
  const scopedRows = rows.filter((r) => r.entity_kind !== kind && r.applies_to != null);
  const bare = (r: FieldDefRow): ResolvedFieldDef => ({ ...r, scope: null, scope_label: null });
  if (scopedRows.length === 0) return own.map(bare);

  // Only now do we need the kind's traits — a workspace with no scoped defs
  // (i.e. every workspace today) never pays for the lookup.
  const shape = await kindShape(orgId, kind);
  if (!shape) return own.map(bare);

  const taken = new Set(own.map((r) => r.name));
  const offset = own.reduce((max, r) => Math.max(max, r.position), -1) + 1;

  const scoped: ResolvedFieldDef[] = [];
  for (const r of scopedRows) {
    // A per-kind def of the same name already won.
    if (taken.has(r.name)) continue;
    if (!matchAction(r.applies_to as ActionAppliesToDecl, shape.fields, kind, shape.traits).via) {
      continue;
    }
    scoped.push({
      ...r,
      // Normalize onto the kind it resolved for (see the header) — but remember
      // where it came from.
      entity_kind: kind,
      position: offset + r.position,
      scope: r.entity_kind,
      scope_label: fieldScopeLabel(parseFieldScope(r.entity_kind)),
    });
  }
  return [...own.map(bare), ...scoped];
}

/**
 * The config-surface read: every def in the org, unexpanded. Trait-scoped defs
 * appear ONCE, as themselves, still carrying their `@physical` sentinel — the
 * Fields page manages the scope, it doesn't want N copies of it. This is the
 * `?kind=` -less read.
 */
export async function listAllFieldDefs(orgId: string): Promise<ResolvedFieldDef[]> {
  const rows = await meta
    .selectFrom("module_field_defs")
    .selectAll()
    .where("org_id", "=", orgId)
    .orderBy("entity_kind")
    .orderBy("position")
    .execute();
  return rows.map((r) => {
    const scoped = r.applies_to != null && isFieldScope(r.entity_kind);
    return {
      ...r,
      scope: scoped ? r.entity_kind : null,
      scope_label: scoped ? fieldScopeLabel(parseFieldScope(r.entity_kind)) : null,
    };
  });
}
