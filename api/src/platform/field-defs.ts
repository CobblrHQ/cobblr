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
import { sql } from "kysely";
import { z } from "zod";
import {
  FieldRoleSchema,
  FieldTypeSchema,
  TRAIT_NAMES,
  fieldScopeLabel,
  fieldScopeSentinel,
  isFieldScope,
  parseFieldScope,
  type ActionAppliesToDecl,
} from "@cobblr/platform-contract";
import { meta } from "../db/meta.js";
import type { FieldOverrideBlob, ModuleFieldDefsTable } from "../db/schema.js";
import { matchAction } from "./actions.js";
import * as activity from "./activity.js";
import { clearComputedDefsCache } from "./computed-fields.js";
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

// ─────────────────────────── creating a def ────────────────────────
//
// Extracted from the POST /field-defs route body so the platform:add-field
// action handler and the route share ONE implementation — the trait-scope
// resolution, the relation/ref_kind rule and the `_note` reservation must not
// mean one thing when a person builds a field and another when the assistant
// does (the CustomUnit / ViewCreate precedent).

/** The renderer ids the field builder offers. Lives here (not the route) so the
 *  create schema and its consumers stay in one file. */
export const FieldRenderer = z.enum([
  "text",
  "color-hex",
  "image-url",
  "url-link",
  "year",
  "boolean",
  "code",
  "markdown",
  "qr",
]);

export const FieldDefCreate = z.object({
  entity_kind: z.string(),
  // `_note` is reserved: a choice field's one-off clarifier lives at
  // `<name>_note` in metadata (see packages/platform-web/src/field-note.ts), so
  // a real field with that name would fight the clarifier of the field it
  // shadows for one key, and whichever wrote last would win.
  name: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .refine((n) => !n.endsWith("_note"), {
      message: "field names cannot end in _note (reserved for a choice field's clarifier)",
    }),
  display_label: z.string().min(1),
  type: FieldTypeSchema,
  required: z.boolean().optional(),
  position: z.number().int().optional(),
  /** When type='text', renders as a dropdown of these choices. */
  choices: z.array(z.string().max(120)).optional(),
  /** Built-in renderer id for how the value should be drawn on
   *  detail pages + list rows. Null/omit = plain text. */
  renderer: FieldRenderer.nullable().optional(),
  /** When type='computed': the {{ }} template rendered read-only at
   *  resolve time. Required for computed; ignored otherwise. */
  template: z.string().max(2000).optional(),
  /** When type='relation': the entity-kind id this field points at
   *  ("core-locations:location"). Without it the field stores an id nothing
   *  can resolve, so the value renders as a raw uuid forever — which is what
   *  happened when `relation` became selectable in the field builder before
   *  this was accepted here. Enforced in createFieldDef, not merely optional. */
  ref_kind: z.string().min(1).optional(),
  /** The unit a type='number' value is measured in ("mm", "g", "in").
   *  Free text by design — the units vocabulary (core-units) resolves it
   *  at render/consume time and an unmatched string renders as-is. A unit
   *  resolving to a catalog category gives the field declared physical
   *  semantics (this is what size-aware features consume — never the
   *  field's name). */
  unit: z.string().trim().min(1).max(40).nullable().optional(),
  /** TRAIT SCOPE: attach this def to a CLASS of entity kinds instead of one kind
   *  ("origin", on everything physical). ANY combination of the 12 traits is
   *  valid — OR within an axis, AND across axes — matched by the same matcher the
   *  action registry uses. When present, `entity_kind` is DERIVED (the canonical
   *  sentinel) and whatever the client sent for it is ignored, so the sentinel can
   *  never disagree with the predicate it encodes. */
  applies_to: z
    .object({ traits: z.array(z.enum(TRAIT_NAMES)).min(1) })
    .optional(),
  /** What this field MEANS, from the closed vocabulary a bundle already uses.
   *  The name is a local label and storage key; the role is the identity that
   *  lets two workspaces (or two packs) recognise the same concept under
   *  different names. Validated with the SAME schema the manifest uses so the
   *  two can't drift. */
  field_role: FieldRoleSchema.nullable().optional(),
}).refine(
  (d) => !d.choices || d.type === "text",
  { message: "choices is only valid for type='text'", path: ["choices"] },
).refine(
  (d) => d.type !== "computed" || (d.template && d.template.trim().length > 0),
  { message: "template is required for type='computed'", path: ["template"] },
).refine(
  (d) => !d.unit || d.type === "number",
  { message: "unit is only valid for type='number'", path: ["unit"] },
);

export type FieldDefCreateInput = z.infer<typeof FieldDefCreate>;

export type CreateFieldDefResult =
  | { ok: true; def: FieldDefRow }
  | { ok: false; code: "missing_ref_kind" | "unknown_scope" | "duplicate_name"; message: string };

/** Create one custom field def — the shared body of POST /field-defs and the
 *  platform:add-field action. Input is already FieldDefCreate-parsed; the
 *  semantic rules that need context (relation target, trait scopes, the
 *  unique-name collision) are decided here, ONCE, with typed refusals both
 *  surfaces phrase to their own callers. */
export async function createFieldDef(
  orgId: string,
  input: FieldDefCreateInput,
): Promise<CreateFieldDefResult> {
  // A relation with nowhere to point stores an id nothing can resolve, so
  // the value renders as a raw uuid forever. Reject it at creation rather
  // than let someone build a broken field and discover it in a table.
  if (input.type === "relation" && !input.ref_kind) {
    return {
      ok: false,
      code: "missing_ref_kind",
      message: "A relation field needs ref_kind: which kind of record it points at.",
    };
  }
  // A def is keyed either to ONE kind ("inventory:part") or to a TRAIT SCOPE.
  // The scope arrives either as an explicit predicate (the trait picker) or as
  // a sentinel shorthand ("@physical", "@physical+unique"); both collapse to
  // the same canonical trait list. The sentinel is then DERIVED from that list,
  // never taken from the client, so it can't disagree with the predicate it
  // encodes — and the same scope always lands on the same row.
  const scopeTraits = input.applies_to?.traits ?? parseFieldScope(input.entity_kind);
  if (isFieldScope(input.entity_kind) && scopeTraits.length === 0) {
    return {
      ok: false,
      code: "unknown_scope",
      message: `"${input.entity_kind}" isn't a trait scope. Use trait words, e.g. @physical or @physical+unique.`,
    };
  }
  const entityKind = scopeTraits.length ? fieldScopeSentinel(scopeTraits) : input.entity_kind;
  try {
    const inserted = await meta
      .insertInto("module_field_defs")
      .values({
        org_id: orgId,
        entity_kind: entityKind,
        name: input.name,
        display_label: input.display_label,
        type: input.type,
        required: input.required ?? false,
        position: input.position ?? 0,
        choices: input.choices
          ? (sql`${JSON.stringify(input.choices)}::jsonb` as unknown as string[])
          : null,
        renderer: input.renderer ?? null,
        template: input.type === "computed" ? input.template ?? null : null,
        unit: input.type === "number" ? input.unit ?? null : null,
        // Scoped to the type that uses it, like template and unit above, so a
        // stray ref_kind on a text field cannot confuse the label resolver.
        ref_kind: input.type === "relation" ? input.ref_kind ?? null : null,
        applies_to: scopeTraits.length
          ? sql`${JSON.stringify({ traits: scopeTraits })}::jsonb`
          : null,
        field_role: input.field_role ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    clearComputedDefsCache();
    await activity.log({
      orgId,
      action: "field_def_created",
      ref: { module: null, entityType: "field_def", entityId: inserted.id },
      diff: { entity_kind: entityKind, name: input.name, type: input.type },
    });
    return { ok: true, def: inserted };
  } catch (err) {
    // unique (org_id, entity_kind, name) — the same field twice is a refusal
    // with a name, not a 500.
    if ((err as { code?: string }).code === "23505") {
      return {
        ok: false,
        code: "duplicate_name",
        message: `"${input.name}" already exists on ${entityKind}.`,
      };
    }
    throw err;
  }
}

// ─────────────────────────── change one, remove one ─────────────────────────
//
// Both bodies used to live inline in the PATCH/DELETE routes. They moved here
// when the assistant got doors of its own (platform:edit-field /
// platform:remove-field): a rule that lives in a route handler is a rule the
// assistant does not obey, and the bundle-provenance routing below is exactly
// the kind nobody would think to copy.

export const FieldDefPatch = z.object({
  display_label: z.string().min(1).optional(),
  required: z.boolean().optional(),
  position: z.number().int().optional(),
  choices: z.array(z.string().max(120)).nullable().optional(),
  renderer: FieldRenderer.nullable().optional(),
  template: z.string().max(2000).nullable().optional(),
  /** Only meaningful on type='number' defs — validated against the row's
   *  type here (the patch body alone can't see it). */
  unit: z.string().trim().min(1).max(40).nullable().optional(),
  /** Settable after the fact, so a field made before roles existed can be told
   *  what it means without being recreated. Null clears it. */
  field_role: FieldRoleSchema.nullable().optional(),
});

export type FieldDefPatchInput = z.infer<typeof FieldDefPatch>;

export type UpdateFieldDefResult =
  | { ok: true; def: FieldDefRow; effectiveChoices?: string[] | null }
  | { ok: false; code: "not_found" | "unit_not_number" | "no_changes"; message: string };

/** Change one field def — the shared body of PATCH /field-defs/:id and the
 *  platform:edit-field action. */
export async function updateFieldDef(
  orgId: string,
  id: string,
  patch: FieldDefPatchInput,
): Promise<UpdateFieldDefResult> {
  const updates: Record<string, unknown> = {};
  if (patch.display_label !== undefined) updates.display_label = patch.display_label;
  if (patch.required !== undefined) updates.required = patch.required;
  if (patch.position !== undefined) updates.position = patch.position;
  if (patch.choices !== undefined) {
    updates.choices = patch.choices ? sql`${JSON.stringify(patch.choices)}::jsonb` : null;
  }
  if (patch.renderer !== undefined) updates.renderer = patch.renderer;
  if (patch.template !== undefined) updates.template = patch.template;
  if (patch.unit !== undefined) updates.unit = patch.unit;
  if (patch.field_role !== undefined) updates.field_role = patch.field_role;

  const def = await meta
    .selectFrom("module_field_defs")
    .selectAll()
    .where("id", "=", id)
    .where("org_id", "=", orgId)
    .executeTakeFirst();
  if (!def) return { ok: false, code: "not_found", message: "field def not found" };

  // A unit only makes sense on a number field — checked here because the
  // patch body alone can't see the row's type.
  if (patch.unit != null && def.type !== "number") {
    return { ok: false, code: "unit_not_number", message: "unit is only valid for type='number'" };
  }

  // Provenance: a `choices` change on a BUNDLE-owned field def routes to the
  // USER override layer (bundle_id null), never the bundle row — so the
  // "+ add option" can't be clobbered by the next bundle update. This is the
  // single chokepoint: every client PATCHes through here, so none of them can
  // clobber a bundle field.
  let routedChoices = false;
  if (def.bundle_id && patch.choices !== undefined) {
    const existing = await meta
      .selectFrom("native_field_overrides")
      .selectAll()
      .where("org_id", "=", orgId)
      .where("entity_kind", "=", def.entity_kind)
      .where("name", "=", def.name)
      .executeTakeFirst();
    const blob: FieldOverrideBlob = { ...(existing?.overrides ?? {}) };
    if (patch.choices === null) delete blob.choices;
    else blob.choices = patch.choices;
    const blobSql = sql`${JSON.stringify(blob)}::jsonb` as unknown as FieldOverrideBlob;
    await meta
      .insertInto("native_field_overrides")
      .values({
        org_id: orgId,
        entity_kind: def.entity_kind,
        name: def.name,
        display_label: existing?.display_label ?? null,
        hidden: existing?.hidden ?? false,
        position: existing?.position ?? 0,
        overrides: blobSql,
        bundle_id: null,
      })
      .onConflict((c) =>
        c.columns(["org_id", "entity_kind", "name"]).doUpdateSet({
          overrides: blobSql,
          bundle_id: null,
          updated_at: new Date(),
        }),
      )
      .execute();
    delete updates.choices;
    routedChoices = true;
  }

  if (Object.keys(updates).length === 0 && !routedChoices) {
    return { ok: false, code: "no_changes", message: "no fields to update" };
  }
  let updated = def;
  if (Object.keys(updates).length > 0) {
    const u = await meta
      .updateTable("module_field_defs")
      .set(updates as never)
      .where("id", "=", id)
      .where("org_id", "=", orgId)
      .returningAll()
      .executeTakeFirst();
    if (!u) return { ok: false, code: "not_found", message: "field def not found" };
    updated = u;
  }
  await activity.log({
    orgId,
    action: "field_def_updated",
    ref: { module: null, entityType: "field_def", entityId: updated.id },
    diff: patch,
  });
  clearComputedDefsCache();
  return routedChoices
    ? { ok: true, def: updated, effectiveChoices: patch.choices ?? def.choices }
    : { ok: true, def: updated };
}

export type DeleteFieldDefResult =
  | { ok: true; def: FieldDefRow }
  | { ok: false; code: "not_found"; message: string };

/** Remove one field def — the shared body of DELETE /field-defs/:id and the
 *  platform:remove-field action. Values already recorded stay on the records:
 *  the def is what goes, so re-adding the field under the same name brings them
 *  back into view. */
export async function deleteFieldDef(orgId: string, id: string): Promise<DeleteFieldDefResult> {
  const deleted = await meta
    .deleteFrom("module_field_defs")
    .where("id", "=", id)
    .where("org_id", "=", orgId)
    .returningAll()
    .executeTakeFirst();
  if (!deleted) return { ok: false, code: "not_found", message: "field def not found" };
  await activity.log({
    orgId,
    action: "field_def_deleted",
    ref: { module: null, entityType: "field_def", entityId: deleted.id },
  });
  clearComputedDefsCache();
  return { ok: true, def: deleted };
}
