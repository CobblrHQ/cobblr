import { z } from "zod";
import { FACE_NAMES, type FaceName, FIELD_ROLE_VALUES, FIELD_TYPE_VALUES, NOT_RETYPEABLE_FIELD_TYPES } from "@cobblr/platform-contract/field-vocabulary";
import { FieldAggregateSchema } from "@cobblr/platform-contract/field-aggregate";
import { type AnyAxisName, type AnyTraitName, FACE_TRAIT_AXES, TRAIT_NAMES } from "@cobblr/platform-contract/traits";

// ───────────────────────── Module manifest ─────────────────────────

export const Intent = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  // Zod's runtime type for the payload schema. Modules pass a real
  // ZodSchema; we type it loosely here to avoid coupling to a specific
  // version of zod in the validator output.
  schema: z.unknown().optional(),
});

export const NavItem = z.object({
  label: z.string().min(1),
  route: z.string().regex(/^\//, "route must start with /"),
  icon: z.string().optional(),
});

// ─────────────────────── Pillar A: entity kinds ────────────────────
//
// Modules declare the entity kinds they own — abstract descriptions
// other modules can introspect without importing the source module's
// code. Stable IDs (e.g. "inventory:part") are the contract.

export const EntityFieldRole = z.enum([
  "title",
  "subtitle",
  "image",
  "summary",
  "quantity",
  "unit",
]);
export const FieldTypeSchema = z.enum(FIELD_TYPE_VALUES);
export const RetypeableFieldTypeSchema = FieldTypeSchema.exclude(NOT_RETYPEABLE_FIELD_TYPES);
export const FieldRoleSchema = z.enum(FIELD_ROLE_VALUES);

/**
 * FACES: what a record shows, as a view over the traits its collection wears.
 *
 * docs/design-decisions/one-record-substrate.md: "stock is a face, not a type;
 * faces stack, derived from signals, per collection, sticky, one-tap override".
 * A face is not a second vocabulary. It is a person-facing name for a
 * combination of trait values - some on the six declared axes, two on the
 * trial axes above - resolved per collection rather than declared per kind:
 *
 *   stock       identity: fungible
 *   serialized  identity: unique, on a kind DECLARED fungible (units under a type)
 *   maintained  tangibility: physical + identity: unique
 *   container   containment: container
 *   perishable  spoilage: perishable          (trial axis)
 *   lendable    custody: lendable             (trial axis)
 *
 * Fields, panels and actions never mention a face; they declare `traits`, and
 * the same matcher that always served actions decides. The face names exist
 * for the row a person taps ("More about this item: + Serials") and for the
 * Presentation page, where a choice is written as a per-collection trait
 * override. Until 2026-09-09 a box of tea rendered every section the platform
 * had, because nothing resolved any of this per collection.
 */
export const FaceSchema = z.enum(FACE_NAMES);
/** A collection's resolved trait values, one per axis (real and trial),
 *  as the faces resolver hands them on. */
export type CollectionTraits = Partial<Record<AnyAxisName, AnyTraitName>>;
/** Which faces a set of resolved traits implies. Pure; the one definition. */
/** Whether a collection discloses STOCK, answered from its meta-side config
 *  alone, or null when only its data can say. The rungs, in order, and the
 *  reason each sits where it does:
 *    1. the person's own toggle (`stock: true|false`) wins outright;
 *    2. the bundle that made the collection said it wears no stock face
 *       (`faces.stock === false`): lean, whatever a data write latched. A
 *       bookshelf's first book arrived with qty 1 and latched the shelf to
 *       stock, and every book then wore Use one, Used up and a reorder point
 *       (the 2026-09-12 review); the author's declaration is the fact, the
 *       latch was a guess from a number every create sends;
 *       And the same declaration the other way (`faces.stock === true`): the
 *       bundle says its collection is counted stock, so a box of screws wears
 *       Use one from its first item rather than after a second is counted.
 *       A declaration governs both ways; only an undeclared collection is left
 *       to its data (2026-09-24, #3646);
 *    3. the sticky latch (`stock_latched`) set by an earlier stock-shaped write;
 *    4. null: nothing meta-side says, probe the data (bias lean).
 *  The kernel's kind synthesis and the inventory module's disclosure route
 *  both read this, so they cannot disagree about the same collection. */
export function stockDisclosureFromConfig(cfg: Record<string, unknown> | null | undefined): boolean | null {
  if (!cfg) return null;
  if (typeof cfg.stock === "boolean") return cfg.stock;
  const faces = cfg.faces as Record<string, unknown> | null | undefined;
  if (faces && typeof faces === "object" && typeof faces.stock === "boolean") return faces.stock;
  if (cfg.stock_latched === true) return true;
  return null;
}

export function facesOf(traits: CollectionTraits, declaredIdentity: string | null | undefined): FaceName[] {
  const out: FaceName[] = [];
  if (traits.identity === "fungible") out.push("stock");
  if (traits.spoilage === "perishable") out.push("perishable");
  if (traits.identity === "unique" && declaredIdentity === "fungible") out.push("serialized");
  if (traits.tangibility === "physical" && traits.identity === "unique") out.push("maintained");
  if (traits.custody === "lendable") out.push("lendable");
  if (traits.containment === "container") out.push("container");
  return out;
}
export type FaceConfig = Partial<Record<FaceName, boolean>>;
/**
 * A person's per-face choices, applied to a collection's derived traits.
 *
 * FACTS AND CHOICES ARE DIFFERENT THINGS, and an Off never rewrites a fact.
 * Turning the service log off on a tool collection must not make the drill
 * fungible (which would take its serial number and its lend-ability with it),
 * and "don't track expiry on the pantry" must not tell the platform the tea
 * keeps. So an Off only HIDES the face; the traits stand. An On asserts a fact
 * where the choice is one - tracking individuals makes them unique, choosing
 * to lend makes custody lendable, saying things go off makes spoilage
 * perishable, saying a thing holds things makes it a container, counting
 * makes it fungible - and merely shows the face where it is not (service on a
 * screw cannot make the screw unique; it just shows the log).
 *
 * Returns both: the resolved traits (eligibility, what a thing CAN do) and
 * the faces shown (disclosure, what a person wants to SEE). The strip and the
 * panels read the second; anything reasoning about the thing reads the first.
 */
export function resolveFaces(
  derived: CollectionTraits,
  explicit: FaceConfig | null | undefined,
  declaredIdentity: string | null | undefined,
): { traits: CollectionTraits; faces: FaceName[] } {
  const traits: CollectionTraits = { ...derived };
  const assert = (axis: AnyAxisName, value: AnyTraitName, on: boolean | undefined) => {
    if (on === true) traits[axis] = value;
  };
  assert("identity", "fungible", explicit?.stock);
  assert("identity", "unique", explicit?.serialized);
  assert("spoilage", "perishable", explicit?.perishable);
  assert("custody", "lendable", explicit?.lendable);
  assert("containment", "container", explicit?.container);
  const implied = new Set<FaceName>(facesOf(traits, declaredIdentity));
  const faces = FACE_NAMES.filter((f) => {
    const choice = explicit?.[f];
    if (choice === false) return false;
    if (choice === true) return true;
    return implied.has(f);
  });
  return { traits, faces };
}

export const EntityField = z.object({
  name: z.string().min(1).max(80),
  // `object` is for free-form JSON attribute blobs (e.g.
  // inventory:part.metadata) — opaque to the kernel beyond
  // type-checking that it's an object. Renderers treat it as
  // "json blob, show keys"; consumer modules read specific keys
  // via platform.entities.lookupMany.
  type: z.enum(["text", "number", "boolean", "date", "image-path", "url", "object"]),
  /** The words a person reads for this field, where its name would not do
   *  ("purchase_price_cents" is "Paid"). A record's history, and anything
   *  else that names the field without its own form, reads it; a workspace's
   *  relabel still wins. Absent: the name, spelt out. */
  label: z.string().min(1).max(80).optional(),
  // SERVER-OWNED: the value is maintained by the module, not set by whoever
  // writes the record. Declaring a field WITHOUT this when the writer refuses it
  // is an invitation to write something that will be silently discarded — the
  // update returns 200 with a fresh updated_at, so it reads as applied. That is
  // exactly what `core-locations:location.position` did: the kind offered a
  // writable number, the assistant set 0-11 across twelve racks, every call
  // succeeded, and nothing moved (2026-08-18). Anything that describes a kind
  // for writing (the AI tool registry, form builders) must leave these out.
  readOnly: z.boolean().optional(),
  // The fixed set of values a text field takes, when it takes one (a
  // location's `kind` is "container" or "area"). Declared, the assistant's
  // kind summary shows it the way a custom dropdown's choices show, and the
  // model sends one of them; undeclared, it saw `kind: text` and proposed a
  // bin with kind "bin", refused on confirm with a raw enum error
  // (2026-09-20). A writer may still validate more tightly than this says.
  choices: z.array(z.string().min(1)).min(1).optional(),
  // Money, and how the column holds it: "cents" (an integer column such as
  // purchase_price_cents) or "amount" (the currency's main unit, 12.5). Every
  // surface shows and takes it through @cobblr/platform-contract/money, so a
  // cents column never reaches a screen as 430000.
  money: z.enum(["cents", "amount"]).optional(),
  // How it adds up in a group's summary (@cobblr/platform-contract/field-aggregate):
  // a per-unit property (price each) is totalled as value x quantity, never summed.
  aggregate: FieldAggregateSchema.optional(),
  role: EntityFieldRole.optional(),
  /** The trait value this native field belongs to, real or trial (`qty` is
   *  `fungible`, `serial_number` is `unique`, `assigned_to` is `lendable`).
   *  Absent = the base record, shown whatever the collection wears. */
  trait: z
    .lazy(() => z.enum([...TRAIT_NAMES, ...(Object.keys(FACE_TRAIT_AXES) as string[])] as [string, ...string[]]))
    .optional(),
  // The SEMANTIC decode role (P3 of the identifier-decoder registry) — distinct
  // from the PRESENTATION `role` above. Marks a field as either HOLDING a
  // decodable identifier (`identifier:<decoderId>`, e.g. `identifier:vin`) or as
  // a decode TARGET filled from a decoder's flat output key (`decode:<key>`,
  // e.g. `decode:make`). Optional + generic: a decoder targets fields by this
  // declared role instead of matching English names, so ISBN/HIN/appliance
  // decoders drop in later without per-kind code. See parseDecodeRole below and
  // docs/design-decisions/vin-decode.md §9.
  decodeRole: z.string().max(80).optional(),
  // The SEMANTIC RECORD role — a third, distinct axis from the presentation
  // `role` (how to DISPLAY it) and `decodeRole` (identifier decoding). A field
  // marked with a record role is TARGETED by that role, never by matching an
  // English name, so a consumer works for any module or bundle and the kernel
  // never learns a domain word ("Electrical", "10-pack"). The rule decodeRole
  // established. Two values today:
  //
  //   category — the field saying what KIND of thing this record is, WITHIN its
  //     table. The scan matchmaker needs it: without it the ONLY way it can
  //     express "this is an electrical part and that is a plumbing part" is to
  //     route them to different TABLES — which is exactly what it did, scattering
  //     five parts across four near-synonym tables. A difference in kind is a
  //     CATEGORY, not a different table. See docs/design-decisions/scan-category-routing.md.
  //
  //   pack — the packaging count of the PHYSICAL item: how many base units are in
  //     the package you're holding (a single, a 10-pack). Distinct from `quantity`
  //     (how many you have) and `unit` (each/L/kg) — the third counting dimension.
  //     Filled from the observed pack (parsePackSize / vision), NOT a "usual buy"
  //     guess. Marking a field with this role is how a tracker opts into the pack
  //     dimension without every bundle re-inventing a `typical_pack` column.
  //     See FIELD_ROLE_PACK + docs/design-decisions/scan-pack-role.md.
  //
  //   identifier — the field holds a value physically MARKED on the object (a
  //     serial number, an asset tag) that a scan or a search can resolve straight
  //     back to this record. Unlike category/pack there may be MORE THAN ONE per
  //     kind, and it is the declaration the resolvable registry reads to build a
  //     scan-and-search provider for the kind, so a workspace no longer has to
  //     hand-write a QR rule for a field the module already knew was an
  //     identifier. See docs/design-decisions/resolvable-registry.md D6.
  fieldRole: FieldRoleSchema.optional(),
  required: z.boolean().optional(),
  description: z.string().optional(),
});

/** The field whose value says what KIND of thing a record is, within its table.
 *  At most one per entity kind (a partial unique index enforces it). */
export const FIELD_ROLE_CATEGORY = "category";

/** The field holding the PHYSICAL pack count of the item in hand — how many base
 *  units are in the package you scanned (a single, a 10-pack). The third counting
 *  dimension beside `quantity` (role) and `unit` (role); filled from the observed
 *  pack, never a "usual buy" guess. At most one per entity kind. */
export const FIELD_ROLE_PACK = "pack";

/** A field physically MARKED on the object that resolves back to its record: a
 *  serial number, an asset tag. Unlike category/pack a kind may declare several.
 *  The resolvable registry reads these to build a per-kind scan+search provider,
 *  so a declared identifier resolves without a hand-written QR rule. See
 *  docs/design-decisions/resolvable-registry.md. */
export const FIELD_ROLE_IDENTIFIER = "identifier";

/** The native field NAMES a kind marks as identifiers (fieldRole "identifier").
 *  Reads the resolved registry record, so it sees module natives and any
 *  workspace override. Empty when the kind declares none. */
export function identifierFieldNames(kind: { fields?: { name: string; fieldRole?: string | null }[] }): string[] {
  return (kind.fields ?? []).filter((f) => f.fieldRole === FIELD_ROLE_IDENTIFIER).map((f) => f.name);
}

/** The universal base: the native fields EVERY entity kind keeps, regardless of
 *  which domain module it borrows its shape from. Everything else a module
 *  declares (assets' state/warranty/serial, inventory's qty/reorder) is a
 *  domain-native that a lean kind — a Bookshelf, a Movies list — hides. This is
 *  the "a kind owns its fields" rule (field-model spec). */
export const BASE_NATIVE_FIELDS: ReadonlySet<string> = new Set([
  "name",
  "image_path",
  "location_id",
  "notes",
  "metadata",
]);

/** A kind's native-field policy. `base` = only the universal base shows;
 *  `inherit` = all the module's natives (today's default); a list = base + these
 *  explicit natives to keep (e.g. a Wine list keeps `quantity`). */
export type NativeFieldsPolicy = "base" | "inherit" | readonly string[];

/** The native field NAMES a policy hides: everything a module declares that is
 *  neither in the universal base, nor a title/image role (those ARE the base
 *  identity + cover), nor in an explicit keep-list. Pure, so the authoring
 *  compile and the installer agree on exactly what a lean kind drops. */
export function nativesToHide(
  nativeFields: readonly { name: string; role?: string | null }[],
  policy: NativeFieldsPolicy,
): string[] {
  if (policy === "inherit") return [];
  const keep = new Set<string>(BASE_NATIVE_FIELDS);
  if (Array.isArray(policy)) for (const n of policy) keep.add(n);
  return nativeFields
    .filter((f) => f.role !== "title" && f.role !== "image" && !keep.has(f.name))
    .map((f) => f.name);
}

// `\bpack\b` matches the WORD "pack" — deliberately not "package" / "backpack"
// (no word boundary), so only genuine pack-size labels trip the guard.
const PACK_LABEL_RE = /\bpack\b/i;
const PACK_BUYING_HABIT_RE = /\b(?:usual(?:ly)?|typical(?:ly)?)\b|\byou (?:usually|typically) buy\b/i;

/** Guardrail for the pack dimension (see FIELD_ROLE_PACK). A field whose label
 *  names a "pack" IS the packaging count of the scanned item, so it must ride
 *  `field_role: "pack"` (the platform fills it from the observed package) rather
 *  than every bundle re-inventing a bespoke column; and it must describe what you
 *  SCANNED, never a "usually buy" habit — the exact conflation the "Usual pack"
 *  field shipped once. Returns the issues (path + message) so a Zod schema and a
 *  test share one source of truth. DB-free + pure. */
export function packFieldIssues(f: {
  display_label: string;
  help?: string | null;
  field_role?: string | null;
}): Array<{ path: "field_role" | "help"; message: string }> {
  const issues: Array<{ path: "field_role" | "help"; message: string }> = [];
  if (PACK_LABEL_RE.test(f.display_label) && f.field_role !== FIELD_ROLE_PACK) {
    issues.push({
      path: "field_role",
      message:
        "a field whose label names a 'pack' is the packaging dimension. Set field_role:'pack' so the scan fills it from the observed package, instead of a bespoke pack column.",
    });
  }
  const text = `${f.display_label} ${f.help ?? ""}`;
  if (PACK_LABEL_RE.test(text) && PACK_BUYING_HABIT_RE.test(text)) {
    issues.push({
      path: "help",
      message:
        "a pack field records the package you SCANNED, not what you 'usually'/'typically' buy. Drop the buying-habit framing (see FIELD_ROLE_PACK).",
    });
  }
  return issues;
}

export const EntityKindIdRegex = /^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$/;

/** A workspace collection's name ("3d-printers", "pantry"): what the
 *  instance and bundle routes accept, and so the first half of the kind its
 *  records carry ("3d-printers:item"). */
export const InstanceNameRegex = /^[a-z0-9][a-z0-9-]*$/;

/** Any kind a record can carry: a module's (`machines:machine`, which
 *  EntityKindIdRegex governs where modules declare them) or a collection's
 *  (`3d-printers:item`). Built from InstanceNameRegex so the two cannot
 *  disagree: a collection named with a leading digit was refused by
 *  placement, and laying out a 3D printer answered 500 (#6369). */
export const KindRefRegex = new RegExp(`^(?:[a-z][a-z0-9_-]*|${InstanceNameRegex.source.slice(1, -1)}):[a-z][a-z0-9_-]*$`);
