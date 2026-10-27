import { FieldAggregateSchema } from "@cobblr/platform-contract/field-aggregate";
import { CLARIFIER_SUFFIX, FIELD_KEY_PATTERN, isReservedFieldKey } from "@cobblr/platform-contract/field-key";
import { forgetPerRequest, perReadRequest } from "../lib/request-context.js";
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
  FIELD_ROLE_LABELS,
  FieldRoleSchema,
  type FieldRole,
  fieldRoleOwner,
  fieldRoleTypeRefusal,
  fieldRoleOwnedMessage,
  FieldTypeSchema,
  RETYPEABLE_FIELD_TYPES,
  TRAIT_NAMES,
  fieldScopeLabel,
  fieldScopeSentinel,
  isFieldScope,
  parseFieldScope,
  type ActionAppliesToDecl,
  fieldTypeTakesUnit,
} from "@cobblr/platform-contract";
import { meta } from "../db/meta.js";
import type { FieldOverrideBlob, ModuleFieldDefsTable } from "../db/schema.js";
import { matchAction } from "./actions.js";
import * as activity from "./activity.js";
import { clearComputedDefsCache } from "./computed-fields.js";
import { getKind, listAll, listKindsForOrg } from "./entities.js";
import { valueFitsField } from "@cobblr/platform-contract/entity-metadata";
import { fieldWithMeaning, meaningFromWords, type FieldWithMeaning } from "@cobblr/platform-contract/field-meaning";

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
/** The field roles a kind wears in a workspace, read off the same defs the
 *  record shows (`resolveFieldDefsForKind`: the kind's own, plus trait-scoped
 *  ones), so a face and the verbs that follow it never come from a field the
 *  record does not have. The faces and actions resolvers used to read raw rows
 *  for `[kind, base]`, and Groceries keeps a copy of its food fields on the
 *  base kind for plain-Inventory food: every inventory instance in that
 *  workspace inherited `expiry`, turned perishable, and a Home Inventory
 *  kettle offered Opened, Threw it out and Restock one (#2849). */
export async function fieldRolesForKind(orgId: string, kind: string): Promise<Set<string>> {
  try {
    const defs = await resolveFieldDefsForKind(orgId, kind);
    return new Set(defs.map((d) => d.field_role).filter((r): r is string => typeof r === "string" && r.length > 0));
  } catch (err) {
    // A workspace whose defs cannot be read still gets its native faces and
    // actions; it just does not get the role-scoped ones, the safe direction.
    console.error("[field-defs] roles for kind failed:", (err as Error).message);
    return new Set();
  }
}

export async function resolveFieldDefsForKind(orgId: string, kind: string): Promise<ResolvedFieldDef[]> {
  return perReadRequest(`field-defs:${orgId}:${kind}`, () => loadFieldDefsForKind(orgId, kind));
}

async function loadFieldDefsForKind(
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
    .regex(FIELD_KEY_PATTERN)
    .refine((n) => !isReservedFieldKey(n), {
      message: `field names cannot end in ${CLARIFIER_SUFFIX} (reserved for a choice field's clarifier)`,
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
  /** One sentence of purpose shown on the field's form ("A receipt fills this
   *  from the vendor it names"). A real column since day one; this schema
   *  never accepted it, so the presets passed it and the insert silently
   *  dropped it - TypeScript missed the mismatch because the value arrived
   *  via a spread (2026-08-25 audit). */
  /** Whether a person's typing grows the choices. Omitted: the default rule
   *  (@cobblr/platform-contract/field-choices). */
  learns: z.boolean().nullable().optional(),
  /** How it adds up in a group's summary (@cobblr/platform-contract/field-aggregate). */
  aggregate: FieldAggregateSchema.nullable().optional(),
  help: z.string().max(500).nullable().optional(),
  /** The person was shown that this kind already has a field with this
   *  meaning and chose to add this one anyway, as a field of its own: it is
   *  made WITHOUT the meaning, so the kind still holds one field per meaning. */
  without_meaning: z.boolean().optional(),
}).refine(
  (d) => !d.choices || d.type === "text",
  { message: "choices is only valid for type='text'", path: ["choices"] },
).refine(
  (d) => d.type !== "computed" || (d.template && d.template.trim().length > 0),
  { message: "template is required for type='computed'", path: ["template"] },
).refine(
  (d) => !d.unit || fieldTypeTakesUnit(d.type),
  { message: "unit is only valid on a number or measure field", path: ["unit"] },
);

export type FieldDefCreateInput = z.infer<typeof FieldDefCreate>;

export type CreateFieldDefResult =
  | { ok: true; def: FieldDefRow; warning?: string }
  | { ok: false; code: "missing_ref_kind" | "unknown_scope" | "duplicate_name" | "role_owned_by_platform" | "role_wrong_type" | "secret_name_used"; message: string }
  | { ok: false; code: "same_meaning"; message: string; existing: { name: string; label: string }; role: FieldRole; inferred: boolean };

/** Create one custom field def — the shared body of POST /field-defs and the
 *  platform:add-field action. Input is already FieldDefCreate-parsed; the
 *  semantic rules that need context (relation target, trait scopes, the
 *  unique-name collision) are decided here, ONCE, with typed refusals both
 *  surfaces phrase to their own callers. */
async function createFieldDefNow(
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
  // A role another capability already answers may not be claimed by a field.
  // The vocabulary itself says which those are (FIELD_ROLE_LABELS.ownedBy), so
  // this is one check for every such role rather than a rule about "location".
  if (input.field_role && fieldRoleOwner(input.field_role)) {
    return {
      ok: false,
      code: "role_owned_by_platform",
      message: fieldRoleOwnedMessage(input.field_role),
    };
  }
  const wrongType = fieldRoleTypeRefusal(input.field_role, input.type);
  if (wrongType) return { ok: false, code: "role_wrong_type", message: wrongType };
  const scopeTraits = input.applies_to?.traits ?? parseFieldScope(input.entity_kind);
  if (isFieldScope(input.entity_kind) && scopeTraits.length === 0) {
    return {
      ok: false,
      code: "unknown_scope",
      message: `"${input.entity_kind}" isn't a trait scope. Use trait words, e.g. @physical or @physical+unique.`,
    };
  }
  const entityKind = scopeTraits.length ? fieldScopeSentinel(scopeTraits) : input.entity_kind;
  if (input.type === "secret") {
    const kinds = scopeTraits.length
      ? (await listKindsForOrg(orgId)).filter((k) => matchAction({ traits: scopeTraits }, k.fields, k.id, k.traits).via).map((k) => k.id)
      : [entityKind];
    const { secretNameIsUnused } = await import("./secret-field-name.js");
    if (!(await secretNameIsUnused(orgId, kinds, input.name))) return { ok: false, code: "secret_name_used", message: "Choose an unused field key for a secret. Existing plain values cannot become secrets." };
  }

  // A per-kind def SHADOWS a trait-scoped def of the same name for that kind
  // (resolveFieldDefsForKind keeps the specific one), and when the scoped def
  // carried a field_role the role vanishes with it - a preset's landing pad
  // dies while the Fields page still reads "on", and parsed facts silently
  // stop landing (2026-08-25 audit). Not a refusal: shadowing is a legitimate
  // per-kind override. But it must not be a SILENT one.
  let warning: string | undefined;
  if (!scopeTraits.length) {
    const scoped = await meta
      .selectFrom("module_field_defs")
      .select(["entity_kind", "field_role"])
      .where("org_id", "=", orgId)
      .where("name", "=", input.name)
      .where("entity_kind", "like", "@%")
      .executeTakeFirst();
    if (scoped) {
      warning =
        `"${input.name}" also exists as a ${scoped.entity_kind} field` +
        (scoped.field_role ? ` carrying the "${scoped.field_role}" meaning` : "") +
        `. This kind now uses YOUR field instead - ` +
        (scoped.field_role && !input.field_role
          ? `and without that meaning set here, receipts and scans stop filling it for this kind. Set the same meaning on your field to keep that working.`
          : `values land on your field for this kind.`);
    }
  }
  // One field per meaning on a kind (#4518). The meaning is the one given, or
  // read from the label when none was (field-meaning.ts); a field that means
  // what one the kind already has is not made a second time. A class scope
  // spans kinds, so the check is per kind and the overlap notice covers it.
  let role: FieldRole | null = input.field_role ?? null;
  let inferred = false;
  if (input.field_role === undefined) {
    const guess = meaningFromWords(input.display_label, input.name);
    if (guess && FIELD_ROLE_LABELS[guess].pickable && !fieldRoleOwner(guess) && !fieldRoleTypeRefusal(guess, input.type)) {
      role = guess;
      inferred = true;
    }
  }
  if (role && !scopeTraits.length) {
    const same = fieldWithMeaning(await kindFieldsWithMeaning(orgId, entityKind), role, input.name);
    if (same && !input.without_meaning) {
      return {
        ok: false,
        code: "same_meaning",
        message: `This kind already has "${same.label}", which ${inferred ? "looks like it means" : "means"} ${FIELD_ROLE_LABELS[role].label.toLowerCase()}. Use that one, or add this one as a field of its own without that meaning.`,
        existing: { name: same.name, label: same.label },
        role,
        inferred,
      };
    }
    if (same) role = null;
  }
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
        choices: input.choices ? JSON.stringify(input.choices) : null,
        renderer: input.renderer ?? null,
        template: input.type === "computed" ? input.template ?? null : null,
        unit: fieldTypeTakesUnit(input.type) ? input.unit ?? null : null,
        // Scoped to the type that uses it, like template and unit above, so a
        // stray ref_kind on a text field cannot confuse the label resolver.
        ref_kind: input.type === "relation" ? input.ref_kind ?? null : null,
        applies_to: scopeTraits.length
          ? sql`${JSON.stringify({ traits: scopeTraits })}::jsonb`
          : null,
        field_role: role,
        // A new field with choices learns unless it says not to.
        learns: input.learns ?? null,
        aggregate: input.aggregate ?? null,
        help: input.help ?? null,
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
    return { ok: true, def: inserted, ...(warning ? { warning } : {}) };
  } catch (err) {
    // unique (org_id, entity_kind, name) — the same field twice is a refusal
    // with a name, not a 500.
    if ((err as { code?: string }).code === "23505") {
      return {
        ok: false,
        code: "duplicate_name",
        message: await duplicateFieldMessage(orgId, entityKind, input.display_label, scopeTraits.length > 0),
      };
    }
    throw err;
  }
}

/** The refusal for a field that is already there, in the words the person
 *  used: the label they typed and the kind as they know it, never the key or
 *  the kind id (#6680). */
async function duplicateFieldMessage(orgId: string, entityKind: string, label: string, scoped: boolean): Promise<string> {
  const kind = scoped ? undefined : (await listKindsForOrg(orgId)).find((k) => k.id === entityKind);
  const where = kind?.display_name ?? (scoped ? "that group of things" : "this kind of record");
  return `A field called "${label}" already exists on ${where}.`;
}

// ─────────────────────────── change one, remove one ─────────────────────────
//
// Both bodies used to live inline in the PATCH/DELETE routes. They moved here
// when the assistant got doors of its own (platform:edit-field /
// platform:remove-field): a rule that lives in a route handler is a rule the
// assistant does not obey, and the bundle-provenance routing below is exactly
// the kind nobody would think to copy.

/** The types a field can change between (the contract's list). */
export const RETYPEABLE: ReadonlySet<string> = new Set(RETYPEABLE_FIELD_TYPES);

export const FieldDefPatch = z.object({
  display_label: z.string().min(1).optional(),
  /** Change the field's type (see RETYPEABLE). Values already stored stay as
   *  they are; the retype preview says first which ones would not fit. */
  type: FieldTypeSchema.optional(),
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
  /** Whether a person's typing grows the choices ("Remember new entries").
   *  On a bundle's field it is the person's own override, like choices. */
  learns: z.boolean().nullable().optional(),
  /** How it adds up in a group's summary. Null goes back to the default rule. */
  aggregate: FieldAggregateSchema.nullable().optional(),
  /** Private: kept out of every share and public page unless it shows
   *  private notes. A person's own mark, kept in the override layer for every
   *  field, shipped or not, so a bundle update never clears it. */
  private: z.boolean().optional(),
});

export type FieldDefPatchInput = z.infer<typeof FieldDefPatch>;

export type UpdateFieldDefResult =
  | { ok: true; def: FieldDefRow; effectiveChoices?: string[] | null }
  | { ok: false; code: "not_found" | "unit_not_number" | "no_changes" | "role_owned_by_platform" | "role_wrong_type" | "type_not_changeable" | "type_is_the_bundles" | "same_meaning"; message: string };

/** Change one field def — the shared body of PATCH /field-defs/:id and the
 *  platform:edit-field action. */
async function updateFieldDefNow(
  orgId: string,
  id: string,
  patch: FieldDefPatchInput,
): Promise<UpdateFieldDefResult> {
  // The same refusal as create: a field may not be EDITED into claiming a role
  // another capability owns either, or the guard is one route deep.
  if (patch.field_role && fieldRoleOwner(patch.field_role)) {
    return { ok: false, code: "role_owned_by_platform", message: fieldRoleOwnedMessage(patch.field_role) };
  }
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
  if (patch.learns !== undefined) updates.learns = patch.learns;
  if (patch.aggregate !== undefined) updates.aggregate = patch.aggregate;

  const def = await meta
    .selectFrom("module_field_defs")
    .selectAll()
    .where("id", "=", id)
    .where("org_id", "=", orgId)
    .executeTakeFirst();
  if (!def) return { ok: false, code: "not_found", message: "field def not found" };

  if (patch.type !== undefined && patch.type !== def.type) {
    if (!RETYPEABLE.has(def.type) || !RETYPEABLE.has(patch.type)) {
      return {
        ok: false,
        code: "type_not_changeable",
        message: `A ${def.type} field cannot become ${patch.type}: only text, number, yes/no, date, link and rich text fields change type. Make a new field instead.`,
      };
    }
    if (def.bundle_id) {
      return {
        ok: false,
        code: "type_is_the_bundles",
        message: "This field comes from a bundle, and its type is the bundle's: the next update would put it back.",
      };
    }
    updates.type = patch.type;
    // A dropdown is a text field's; a unit is a number's. Neither survives
    // the change, and the preview has said so.
    if (patch.type !== "text") updates.choices = null;
    if (!fieldTypeTakesUnit(patch.type)) updates.unit = null;
  }
  // A unit only makes sense on a number field — checked here because the
  // patch body alone can't see the row's type.
  if (patch.unit != null && !fieldTypeTakesUnit(String(updates.type ?? def.type))) {
    return { ok: false, code: "unit_not_number", message: "unit is only valid on a number or measure field" };
  }
  const wrongType = patch.field_role ? fieldRoleTypeRefusal(patch.field_role, def.type) : null;
  if (wrongType) return { ok: false, code: "role_wrong_type", message: wrongType };
  // One field per meaning: a field is not given a meaning one of its kind's
  // other fields already carries (the same rule as create).
  if (patch.field_role && !def.entity_kind.startsWith("@")) {
    const same = fieldWithMeaning(await kindFieldsWithMeaning(orgId, def.entity_kind), patch.field_role, def.name);
    if (same) {
      return {
        ok: false,
        code: "same_meaning",
        message: `"${same.label}" on this kind already means ${FIELD_ROLE_LABELS[patch.field_role].label.toLowerCase()}. A kind holds one field per meaning: use that one, or settle the two first.`,
      };
    }
  }

  // Provenance: a `choices` change on a BUNDLE-owned field def routes to the
  // USER override layer (bundle_id null), never the bundle row — so the
  // "+ add option" can't be clobbered by the next bundle update. This is the
  // single chokepoint: every client PATCHes through here, so none of them can
  // clobber a bundle field.
  let routedChoices = false;
  // A label is the same: a person's name for a shipped field is theirs, and an
  // update that re-pushes the bundle's row must not put the bundle's back.
  const routesLabel = !!def.bundle_id && patch.display_label !== undefined;
  if ((def.bundle_id && (patch.choices !== undefined || patch.learns !== undefined)) || patch.private !== undefined || routesLabel) {
    const existing = await meta
      .selectFrom("native_field_overrides")
      .selectAll()
      .where("org_id", "=", orgId)
      .where("entity_kind", "=", def.entity_kind)
      .where("name", "=", def.name)
      .executeTakeFirst();
    const blob: FieldOverrideBlob = { ...(existing?.overrides ?? {}) };
    if (def.bundle_id && patch.choices !== undefined) {
      if (patch.choices === null) delete blob.choices;
      else blob.choices = patch.choices;
    }
    if (def.bundle_id && patch.learns !== undefined) {
      if (patch.learns === null) delete blob.learns;
      else blob.learns = patch.learns;
    }
    if (patch.private !== undefined) {
      if (patch.private) blob.private = true;
      else delete blob.private;
    }
    const blobSql = sql`${JSON.stringify(blob)}::jsonb` as unknown as FieldOverrideBlob;
    // Naming the field what the bundle names it clears the person's name, so
    // the bundle's later rewording reaches them.
    const overrideLabel = routesLabel ? (patch.display_label === def.display_label ? null : (patch.display_label ?? null)) : (existing?.display_label ?? null);
    // The row carries a place too, and the form takes any place on it as the
    // person's own: a row born from a choice or a label keeps the field where
    // the bundle put it (it once read 0, and the field jumped to the top).
    const keptPosition = existing?.position ?? def.position;
    await meta
      .insertInto("native_field_overrides")
      .values({
        org_id: orgId,
        entity_kind: def.entity_kind,
        name: def.name,
        display_label: overrideLabel,
        hidden: existing?.hidden ?? false,
        position: keptPosition,
        overrides: blobSql,
        bundle_id: null,
      })
      .onConflict((c) =>
        c.columns(["org_id", "entity_kind", "name"]).doUpdateSet({
          display_label: overrideLabel,
          overrides: blobSql,
          bundle_id: null,
          updated_at: new Date(),
        }),
      )
      .execute();
    if (def.bundle_id) {
      delete updates.choices;
      delete updates.learns;
      delete updates.display_label;
    }
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
    before: def,
  });
  clearComputedDefsCache();
  return routedChoices
    ? { ok: true, def: routesLabel ? { ...updated, display_label: patch.display_label ?? updated.display_label } : updated, effectiveChoices: patch.choices ?? def.choices }
    : { ok: true, def: updated };
}

export type DeleteFieldDefResult =
  | { ok: true; def: FieldDefRow }
  | { ok: false; code: "not_found"; message: string };

/** Remove one field def — the shared body of DELETE /field-defs/:id and the
 *  platform:remove-field action. Values already recorded stay on the records:
 *  the def is what goes, so re-adding the field under the same name brings them
 *  back into view. */
async function deleteFieldDefNow(orgId: string, id: string): Promise<DeleteFieldDefResult> {
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

/** A deleted field as it was, to put back. Only a field a person made comes
 *  back this way; a bundle's or a module's belongs to them. */
export const FieldDefSnapshot = z.object({
  id: z.string().uuid(),
  entity_kind: z.string().min(1),
  name: z.string().regex(FIELD_KEY_PATTERN),
  display_label: z.string().min(1),
  type: z.string().min(1),
  required: z.boolean().optional(),
  position: z.number().int().optional(),
  choices: z.array(z.string()).nullable().optional(),
  renderer: z.string().nullable().optional(),
  unit: z.string().nullable().optional(),
  template: z.string().nullable().optional(),
  help: z.string().nullable().optional(),
  section_id: z.string().uuid().nullable().optional(),
  ref_kind: z.string().nullable().optional(),
  decode_role: z.string().nullable().optional(),
  field_role: z.string().nullable().optional(),
  fact_scope: z.string().nullable().optional(),
  applies_to: z.unknown().optional(),
  learns: z.boolean().nullable().optional(),
  aggregate: z.enum(["sum", "per_unit", "none"]).nullable().optional(),
});

export type FieldDefSnapshotInput = z.infer<typeof FieldDefSnapshot>;

/** A field row as the snapshot that restores it. */
export function snapshotOf(def: FieldDefRow): FieldDefSnapshotInput {
  return {
    id: def.id,
    entity_kind: def.entity_kind,
    name: def.name,
    display_label: def.display_label,
    type: def.type,
    required: def.required,
    position: def.position,
    choices: def.choices,
    renderer: def.renderer,
    unit: def.unit,
    template: def.template,
    help: def.help,
    section_id: def.section_id,
    ref_kind: def.ref_kind,
    decode_role: def.decode_role,
    field_role: def.field_role,
    fact_scope: def.fact_scope,
    applies_to: def.applies_to ?? null,
    learns: def.learns,
    aggregate: def.aggregate,
  };
}

export type RestoreFieldDefResult =
  | { ok: true; def: FieldDefRow }
  | { ok: false; code: "already_there"; message: string };

/** Put a deleted field back exactly as it was: the same id, key, label,
 *  choices, place and meaning, so the values still on the records show again
 *  under what the person had set up. */
async function restoreFieldDefNow(orgId: string, snap: FieldDefSnapshotInput): Promise<RestoreFieldDefResult> {
  try {
    const row = await meta
      .insertInto("module_field_defs")
      .values({
        id: snap.id,
        org_id: orgId,
        entity_kind: snap.entity_kind,
        name: snap.name,
        display_label: snap.display_label,
        type: snap.type as never,
        required: snap.required ?? false,
        position: snap.position ?? 0,
        bundle_id: null,
        source_module: null,
        choices: snap.choices ? JSON.stringify(snap.choices) : null,
        renderer: snap.renderer ?? null,
        unit: snap.unit ?? null,
        template: snap.template ?? null,
        help: snap.help ?? null,
        section_id: snap.section_id ?? null,
        ref_kind: snap.ref_kind ?? null,
        decode_role: snap.decode_role ?? null,
        field_role: snap.field_role ?? null,
        fact_scope: snap.fact_scope ?? null,
        applies_to: snap.applies_to == null ? null : (JSON.stringify(snap.applies_to) as never),
        learns: snap.learns ?? null,
        aggregate: snap.aggregate ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await activity.log({ orgId, action: "field_def_restored", ref: { module: null, entityType: "field_def", entityId: row.id } });
    clearComputedDefsCache();
    return { ok: true, def: row };
  } catch (err) {
    // unique (org_id, entity_kind, name), or the id: the field is already there.
    if ((err as { code?: string }).code === "23505") return { ok: false, code: "already_there", message: `"${snap.display_label}" is already on this kind of record.` };
    throw err;
  }
}

export interface RetypePreview {
  from: string;
  to: string;
  /** Records looked at, and whether that was all of them. */
  checked: number;
  complete: boolean;
  /** Stored values that would not fit the new type. They stay as they are. */
  wontFit: number;
  examples: Array<{ id: string; title: string; value: unknown }>;
  /** What goes with the change: the dropdown, the unit. */
  drops: string[];
}

/** What changing a field's type would do to the values it already holds,
 *  read before the change so the person decides with it in front of them. */
export async function previewRetype(orgId: string, id: string, to: string): Promise<RetypePreview | { error: string; message: string }> {
  const def = await meta.selectFrom("module_field_defs").selectAll().where("id", "=", id).where("org_id", "=", orgId).executeTakeFirst();
  if (!def) return { error: "not_found", message: "field def not found" };
  if (!RETYPEABLE.has(def.type) || !RETYPEABLE.has(to)) {
    return { error: "type_not_changeable", message: `A ${def.type} field cannot become ${to}.` };
  }
  const drops: string[] = [];
  const choices = (def.choices as string[] | null) ?? null;
  if (to !== "text" && choices?.length) drops.push("its dropdown choices");
  if (!fieldTypeTakesUnit(to) && (def as { unit?: string | null }).unit) drops.push("its unit");
  const judged = { name: def.name, type: to, choices: to === "text" ? choices : null };
  // A field on a class of kinds has no one list to read; the change still
  // leaves every stored value where it is.
  if (isFieldScope(def.entity_kind)) return { from: def.type, to, checked: 0, complete: false, wontFit: 0, examples: [], drops };
  const all = await listAll(orgId, def.entity_kind, {}, undefined, { cap: 5000 });
  let wontFit = 0;
  const examples: RetypePreview["examples"] = [];
  for (const r of all.items) {
    const f = r.fields as Record<string, unknown>;
    const bag = f.metadata && typeof f.metadata === "object" ? (f.metadata as Record<string, unknown>) : {};
    const value = def.name in bag ? bag[def.name] : f[def.name];
    if (value === null || value === undefined || value === "") continue;
    if (valueFitsField(judged, value)) continue;
    wontFit++;
    if (examples.length < 10) examples.push({ id: r.id, title: r.title, value });
  }
  return { from: def.type, to, checked: all.items.length, complete: all.complete, wontFit, examples, drops };
}

/** Every field a kind has, with its meaning as the workspace has it: its own
 *  and scoped defs (a shipped def's meaning may be overridden), and the
 *  module's own columns a bundle or a person gave a meaning to. The one list
 *  the one-field-per-meaning rule and its overlap notice read. */
export async function kindFieldsWithMeaning(orgId: string, kind: string): Promise<Array<FieldWithMeaning & { source: "custom" | "shipped" | "built-in" }>> {
  const defs = await resolveFieldDefsForKind(orgId, kind);
  const kinds = [...new Set([kind, ...defs.map((d) => d.entity_kind)])];
  const rows = await meta
    .selectFrom("native_field_overrides")
    .select(["entity_kind", "name", "display_label", "overrides"])
    .where("org_id", "=", orgId)
    .where("entity_kind", "in", kinds)
    .execute();
  const own = new Map(rows.map((r) => [`${r.entity_kind} ${r.name}`, r] as const));
  const out: Array<FieldWithMeaning & { source: "custom" | "shipped" | "built-in" }> = defs.map((d) => {
    const o = own.get(`${d.entity_kind} ${d.name}`);
    return {
      name: d.name,
      label: o?.display_label ?? d.display_label,
      field_role: (o?.overrides as FieldOverrideBlob | null)?.field_role ?? d.field_role ?? null,
      source: d.bundle_id || d.source_module ? "shipped" : "custom",
    };
  });
  for (const r of rows) {
    if (r.entity_kind !== kind || out.some((f) => f.name === r.name)) continue;
    const fr = (r.overrides as FieldOverrideBlob | null)?.field_role ?? null;
    if (fr) out.push({ name: r.name, label: r.display_label ?? r.name, field_role: fr, source: "built-in" });
  }
  return out;
}

/** A kind's field as a person's form sees it: its own def with the user
 *  layer on top (a bundle field's choices and `learns` live in
 *  native_field_overrides, never on the bundle's row). Every write that grows
 *  or shrinks a choice list starts from THIS list, or a second addition to a
 *  bundle field would replace the first. Null when the kind has no such field. */
export async function effectiveFieldDef(
  orgId: string,
  kind: string,
  name: string,
): Promise<(ResolvedFieldDef & { choices: string[] | null; learns: boolean | null }) | null> {
  return (await effectiveFieldDefsForKind(orgId, kind)).find((d) => d.name === name) ?? null;
}

/** Every field on a kind with its choices and "remember new entries" as the
 *  workspace has them: a shipped field's own list lives in the override layer
 *  once changed (updateFieldDef routes it there), and a reader of the raw def
 *  would see the bundle's list instead. One query for the kind's overrides. */
export async function effectiveFieldDefsForKind(
  orgId: string,
  kind: string,
): Promise<Array<ResolvedFieldDef & { choices: string[] | null; learns: boolean | null; private: boolean }>> {
  const defs = await resolveFieldDefsForKind(orgId, kind);
  const kinds = [...new Set(defs.map((d) => d.entity_kind))];
  const rows = kinds.length
    ? await meta
        .selectFrom("native_field_overrides")
        .select(["entity_kind", "name", "overrides"])
        .where("org_id", "=", orgId)
        .where("entity_kind", "in", kinds)
        .execute()
    : [];
  const own = new Map(rows.map((r) => [`${r.entity_kind} ${r.name}`, r.overrides] as const));
  return defs.map((def) => {
    const o = own.get(`${def.entity_kind} ${def.name}`);
    return {
      ...def,
      choices: (o?.choices ?? (def.choices as string[] | null)) ?? null,
      learns: o?.learns ?? def.learns ?? null,
      private: o?.private === true,
    };
  });
}

/** The fields of a kind its owner marked private, its own columns included
 *  (the override layer holds the mark for any field). */
export async function privateFieldNames(orgId: string, kind: string): Promise<Set<string>> {
  const defs = await resolveFieldDefsForKind(orgId, kind);
  const kinds = [...new Set([kind, ...defs.map((d) => d.entity_kind)])];
  const rows = await meta
    .selectFrom("native_field_overrides")
    .select(["name", "overrides"])
    .where("org_id", "=", orgId)
    .where("entity_kind", "in", kinds)
    .execute();
  return new Set(rows.filter((r) => (r.overrides as FieldOverrideBlob | null)?.private === true).map((r) => r.name));
}

/** What a request remembered about a workspace's field definitions (its
 *  fields, their scopes, which are secret): forgotten once one changes, so a
 *  send that adds Author and then maps the record sees Author (#5933). */
const forgetFieldDefs = (orgId: string) =>
  forgetPerRequest((key) => /^(entity-field-defs|field-scopes|secret-defs):/.test(key) && key.startsWith(`${key.split(":")[0]}:${orgId}:`));

export async function createFieldDef(...args: Parameters<typeof createFieldDefNow>): ReturnType<typeof createFieldDefNow> {
  try {
    return await createFieldDefNow(...args);
  } finally {
    forgetFieldDefs(args[0]);
  }
}

export async function updateFieldDef(...args: Parameters<typeof updateFieldDefNow>): ReturnType<typeof updateFieldDefNow> {
  try {
    return await updateFieldDefNow(...args);
  } finally {
    forgetFieldDefs(args[0]);
  }
}

export async function restoreFieldDef(...args: Parameters<typeof restoreFieldDefNow>): ReturnType<typeof restoreFieldDefNow> {
  try {
    return await restoreFieldDefNow(...args);
  } finally {
    forgetFieldDefs(args[0]);
  }
}

export async function deleteFieldDef(...args: Parameters<typeof deleteFieldDefNow>): ReturnType<typeof deleteFieldDefNow> {
  try {
    return await deleteFieldDefNow(...args);
  } finally {
    forgetFieldDefs(args[0]);
  }
}
