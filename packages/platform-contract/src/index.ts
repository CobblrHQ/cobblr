import { arrivedEverywhere as arrivedEverywhereForView } from "@cobblr/platform-contract/day";
import { FieldAggregateSchema } from "@cobblr/platform-contract/field-aggregate";
import type { GroupBy, GroupPlan, GroupedResult } from "./grouped-list.js";
import { parseDecodeRole, type DecodeRole } from "@cobblr/platform-contract/decode-role";
export { parseDecodeRole, type DecodeRole } from "@cobblr/platform-contract/decode-role";
export { groupListRows, normalizeGrouping } from "@cobblr/platform-contract/grouped-list";
export type { GroupBy, GroupPlan, GroupedResult, EntityGroup, GroupTotal } from "./grouped-list.js";
import { ActionGroupReference } from "@cobblr/platform-contract/action-groups-schema";
export type { Money, MoneyTotal, MoneyConversion, ExchangeRates } from "@cobblr/platform-contract/money";
// The platform contract — types and validators that modules import
// when registering with cobblr-core. Modules MUST NOT import from
// @cobblr/api directly; everything they need crosses through here.
//
// Phase 0 ships the stub: the typed manifest schema, defineModule(),
// and intent declaration shape. Module loading wires onto these in
// later phases.

import type { UploadMiddleware, UploadOptions, UploadRefusal, UploadSizeRow } from "./upload.js";
import type { ConnectionTestOutcome } from "./connection-verification.js";
import { z } from "zod";
import { SERVICE_EFFECTS, type PlatformServices } from "@cobblr/platform-contract/services";
export type { PlatformServices } from "@cobblr/platform-contract/services";
import type { DateFieldDirection } from "@cobblr/platform-contract/date-field-direction";
import { ORG_ROLES, type OrgRoleName } from "@cobblr/platform-contract/org-roles";
import { centsFromAmount } from "@cobblr/platform-contract/money";
import { isFloatingModel } from "@cobblr/platform-contract/ai-models";
import { isJunkCategory } from "@cobblr/platform-contract/category-reconcile";
import { measurePaths, measureTokens, type Measure } from "@cobblr/platform-contract/measure";

export type { DateFieldDirection } from "@cobblr/platform-contract/date-field-direction";
export { dateFieldDirection, directionOfRole, canBeOverdue, dateEventTitle } from "@cobblr/platform-contract/date-field-direction";
export { randomId } from "@cobblr/platform-contract/random-id";
export { pluralise, countOf, wordForCount, countWordsFor, quantityWithUnit, itemNounFor, articleFor, withArticle, type CountWords } from "@cobblr/platform-contract/plural";
export { PLATFORM_OWNER, PLATFORM_COMMANDS, PLATFORM_COMMANDS_VERSION } from "@cobblr/platform-contract/platform-commands";
export { expiryState, expiryPhrase, EXPIRING_WITHIN_DAYS, type ExpiryState, type ExpiryReading } from "@cobblr/platform-contract/expiry-grace";
export { fieldDay, fieldDayUnreadable } from "@cobblr/platform-contract/field-day";
export { arrivedEverywhere, dayHere, dayIn, countdownWords, daySaid, daysUntil, daysUntilField, theirDay, type Day } from "@cobblr/platform-contract/day";
export { keepMembers, isMember, parcelAudience } from "@cobblr/platform-contract/membership";
export { splitEntityKind, entityKindOf, type EntityKindParts } from "@cobblr/platform-contract/entity-kind";
export { actionRunsUnconfirmed, type ActionConsent } from "@cobblr/platform-contract/action-consent";
export { ActionRefusal, isActionRefusal, crashSentence } from "@cobblr/platform-contract/action-refusal";
export { isActionStep, type ActionUndoStep, type ActionUndoer, type ActionUndoContext } from "@cobblr/platform-contract/action-undo";
import type { ActionUndoer, ActionUndoStep, ActionUndoContext } from "@cobblr/platform-contract/action-undo";
export { approvalDedupeKey, blockedSentence, type ApprovalRemedy, type ApprovalRemedyKind, type BlockedAction } from "@cobblr/platform-contract/blocked-action";
import type { BlockedAction } from "@cobblr/platform-contract/blocked-action";
export { destinationLabel, normaliseTargetKind, type DestinationTable } from "@cobblr/platform-contract/destination-label";
import type { TitleVariants } from "@cobblr/platform-contract/display-identity";
import type { Disposition } from "@cobblr/platform-contract/disposition";
import type { OfferDecision, OfferIntake } from "@cobblr/platform-contract/share-offer";
export { NotificationBatcher, type ComposedBurst } from "@cobblr/platform-contract/notification-batcher";
import type {
  ResolvableProvider,
  ResolveContext,
  ResolveOutcome,
} from "./resolvables.js";

// Scanned-label parsing lives in its own file, reachable at
// `@cobblr/platform-contract/qr-token`. It is deliberately NOT re-exported here:
// this package is consumed source-first, and the api loads it under plain Node,
// which resolves a relative specifier literally. `./qr-token.js` does not exist
// (only the .ts does), so a re-export here fails at runtime while tsc and tsx
// both resolve it happily. The subpath export sidesteps the question.

// ───────────────────────── Module manifest ─────────────────────────

const Intent = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  // Zod's runtime type for the payload schema. Modules pass a real
  // ZodSchema; we type it loosely here to avoid coupling to a specific
  // version of zod in the validator output.
  schema: z.unknown().optional(),
});

const NavItem = z.object({
  label: z.string().min(1),
  route: z.string().regex(/^\//, "route must start with /"),
  icon: z.string().optional(),
});

// ─────────────────────── Pillar A: entity kinds ────────────────────
//
// Modules declare the entity kinds they own — abstract descriptions
// other modules can introspect without importing the source module's
// code. Stable IDs (e.g. "inventory:part") are the contract.

const EntityFieldRole = z.enum([
  "title",
  "subtitle",
  "image",
  "summary",
  "quantity",
  "unit",
]);

/** The semantic RECORD roles a field can carry. ONE shared list so the three
 *  places that validate it (this schema, and the two bundle routes) cannot drift
 *  apart. `lint:field-role-enum` fails if a literal pair is hand-written instead
 *  of imported from here. */
// `expiry`: the date this record's contents stop being usable. A ROLE, not a
// field name, because every use case calls it something else (best before, use
// by, service due, licence expires) and behaviour must never keyword-match a
// label. Consumers ask "which field carries expiry here", so a bundle can skin
// the label freely.
// `assignee`: whose job this is. A ROLE over either a `member` field (direct
// user link) or a `relation` to the kind a workspace uses for people, so a
// household member without a login is still a real, groupable assignee — they
// simply resolve as not notifiable. Consumers ask the platform who the assignee
// is and never learn which shape backed it.
import { platform } from "@cobblr/platform-contract/platform-runtime";
import {
  isListedChoice,
  ROLE_CLARIFIES,
  FACE_NAMES,
  FIELD_ROLE_VALUES,
  FIELD_TYPE_VALUES,
  NOT_RETYPEABLE_FIELD_TYPES,
  fieldNoteKey,
  type FaceName,
  type FieldRole,
} from "@cobblr/platform-contract/field-vocabulary";
export {
  isListedChoice,
  ROLE_CLARIFIES,
  FACE_LABELS,
  FACE_NAMES,
  FIELD_NOTE_SUFFIX,
  FIELD_ROLE_LABELS,
  FIELD_ROLE_VALUES,
  FIELD_TYPE_VALUES,
  NOT_RETYPEABLE_FIELD_TYPES,
  RETYPEABLE_FIELD_TYPES,
  UNIT_FIELD_TYPES,
  fieldNoteKey,
  fieldRoleOwnedMessage,
  fieldRoleOwner,
  fieldRoleTypeRefusal,
  fieldTypeTakesUnit,
  isFieldNoteKey,
  type FaceName,
  type FieldDefType,
  type FieldRole,
} from "@cobblr/platform-contract/field-vocabulary";
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

const EntityField = z.object({
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

// ─────────────── Decode field-role vocabulary (P3) ────────────────
//
// The generalization seam of the identifier-decoder registry (VIN is its only
// current consumer). A decoder emits a flat bag of SEMANTIC keys (a VIN decode →
// { year, make, model, body, fuel_type, trim }); a bundle DECLARES which field
// holds the identifier and which fields receive each decoded key, by ROLE — so
// the fill no longer depends on a field being named "Make" in English. Two
// shapes, both carried in a single `decode_role` string:
//
//   identifier:<decoderId>   — this field HOLDS a decodable code (identifier:vin)
//   decode:<key>             — fill this field from the decoder's <key> (decode:make)
//
// Minimal + decoder-agnostic: <key> is the decoder's own output vocabulary, so a
// future ISBN decoder emitting `author` fills a `decode:author` field with zero
// new platform code. Presentation roles (title/subtitle/…) are untouched.

/**
 * Every DecodeRole variant MUST be consumed by the fill planner. Adding a kind to
 * the union without handling it in planDecodeFill is a COMPILE ERROR, courtesy of
 * the `never` below.
 *
 * This exists because `identifier:` was parsed and then silently ignored for
 * months. parseDecodeRole understood it perfectly; planDecodeFill only ever looked
 * for `kind === "target"`, so the field a bundle DECLARED as the holder of the VIN
 * was the one field the VIN never reached — after a scan it sat empty while the VIN
 * was printed in the title directly above it. Nothing failed. Nothing warned. The
 * declaration was simply a lie the type system was happy to keep.
 *
 * A variant you declare and don't consume is worse than one you never added: it
 * reads as a feature. So the compiler now insists.
 */
function assertEveryRoleKindIsConsumed(r: DecodeRole): void {
  switch (r.kind) {
    case "identifier": // → the identifier holder claim, at the top of planDecodeFill
      return;
    case "target": // → the decode:<key> claim, in the loop below
      return;
    default: {
      const unhandled: never = r;
      throw new Error(
        `DecodeRole "${(unhandled as { kind: string }).kind}" is declared but nothing fills it. ` +
          "Handle it in planDecodeFill — a role nothing consumes is a lie in the type.",
      );
    }
  }
}

/** A fillable field, described generically for the decode-fill planner. */
export interface DecodeFillTarget {
  /** Opaque id the caller uses to apply the fill; never interpreted here. */
  id: string;
  /** Programmatic field name (native column or metadata key). */
  name: string;
  /** Display label (may be relabeled, e.g. "Make", "VIN"). */
  label: string;
  /** Is the field currently empty? Only empty targets are ever filled. */
  empty: boolean;
  /** The field's declared `decode_role` string, when it has one. Preferred over
   *  name/label matching. */
  role?: string | null;
}

export interface DecodeFill {
  target: DecodeFillTarget;
  /** The decoder's semantic key this fill came from (year/make/model/…). */
  decodedKey: string;
  value: string | number;
}

/** Fallback name/label matchers (the P1 behaviour) — used only when no field
 *  declares the matching `decode:<key>` role. Order is the order decoded keys
 *  are consumed. Kept deliberately small + generic; a bundle that wants
 *  precision declares roles instead of relying on these. */
const DECODE_NAME_MATCHERS: ReadonlyArray<{
  key: string;
  match: (t: DecodeFillTarget) => boolean;
}> = [
  { key: "make", match: (t) => /^(make|manufacturer)$/i.test(t.name) || /^(make|manufacturer)$/i.test(t.label) },
  { key: "model", match: (t) => /^model$/i.test(t.name) || /^model$/i.test(t.label) },
  { key: "year", match: (t) => /^(model[_ ]?)?year$/i.test(t.name) || /^(model )?year$/i.test(t.label) },
  { key: "body", match: (t) => /^body([_ ]?class)?$/i.test(t.name) || /^body( class)?$/i.test(t.label) },
  { key: "fuel_type", match: (t) => /^fuel([_ ]?type)?$/i.test(t.name) || /fuel/i.test(t.label) },
  { key: "trim", match: (t) => /^trim$/i.test(t.name) || /^trim$/i.test(t.label) },
];

/**
 * Decide which fields a decode result fills. Generic across decoders. For each
 * decoded key it PREFERS a field whose `decode_role` is `decode:<key>` (P3),
 * then falls back to name/label matching (P1). Guarantees:
 *   - EMPTY ONLY: a non-empty target is never chosen (no clobbering typed input).
 *   - ONE-TO-ONE: each target is filled by at most one decoded key.
 *   - SKIP ABSENT: a decoded key with no matching empty target is dropped.
 * Pure; unit-tested. Shared by the server scan-fill and the client form.
 */
export function planDecodeFill(
  decoded: Record<string, string | number>,
  targets: DecodeFillTarget[],
  /** The identifier that WAS decoded, when the caller knows it. A field declaring
   *  `identifier:<decoderId>` is the field that HOLDS that code — the VIN box on a
   *  vehicle, the ISBN box on a book — so it gets filled with the code itself.
   *
   *  Without this the role was parsed and then silently ignored: the Vehicles
   *  bundle tags `serial_number` as `identifier:vin`, and after a VIN scan that
   *  field sat empty while the VIN it was declared to hold was printed in the title
   *  directly above it. Optional, so a caller that doesn't know its own code
   *  behaves exactly as before. */
  identifier?: { decoderId: string; code: string },
): DecodeFill[] {
  const fills: DecodeFill[] = [];
  const claimed = new Set<string>();
  const roleOf = (t: DecodeFillTarget): DecodeRole | null => parseDecodeRole(t.role);

  // Every role a target declares must be one this planner actually consumes. The
  // check is compile-time (the `never` in assertEveryRoleKindIsConsumed); calling
  // it here keeps it wired to the real code path instead of rotting as an unused
  // export somebody deletes.
  for (const t of targets) {
    const r = roleOf(t);
    if (r) assertEveryRoleKindIsConsumed(r);
  }

  // The identifier holder is claimed FIRST: naming its decoder is the most specific
  // claim a field can make, so it must not lose its target to a name-match below.
  if (identifier?.code) {
    const want = identifier.decoderId.toLowerCase();
    const holder = targets.find((t) => {
      if (!t.empty || claimed.has(t.id)) return false;
      const r = roleOf(t);
      return r?.kind === "identifier" && r.decoderId === want;
    });
    if (holder) {
      claimed.add(holder.id);
      fills.push({ target: holder, decodedKey: want, value: identifier.code });
    }
  }

  for (const [key, value] of Object.entries(decoded)) {
    if (value === "" || value === null || value === undefined) continue;
    // P3: a field explicitly declaring `decode:<key>` wins outright.
    let target = targets.find((t) => {
      if (!t.empty || claimed.has(t.id)) return false;
      const r = roleOf(t);
      return r?.kind === "target" && r.key === key;
    });
    // P1 fallback: name/label match, but never steal a field that another key's
    // ROLE has reserved (a role declaration is authoritative).
    if (!target) {
      const matcher = DECODE_NAME_MATCHERS.find((m) => m.key === key);
      if (matcher) {
        target = targets.find((t) => {
          if (!t.empty || claimed.has(t.id)) return false;
          const r = roleOf(t);
          if (r?.kind === "target" && r.key !== key) return false; // reserved by another role
          return matcher.match(t);
        });
      }
    }
    if (!target) continue;
    claimed.add(target.id);
    fills.push({ target, decodedKey: key, value });
  }
  return fills;
}

// ─────────────────── Trait vocabulary (6 axes) ────────────────────
//
// Each entity kind can declare where it sits on six orthogonal axes.
// Axes are independently optional — skipping an axis with `null`
// means "this axis doesn't meaningfully apply to my entity." See
// docs/architecture/traits.md for the full rationale.

export const Tangibility = z.enum(["physical", "digital"]);
export const Identity = z.enum(["fungible", "unique"]);
export const Containment = z.enum(["container", "containable"]);
export const TimeAxis = z.enum(["schedulable", "timeless"]);
export const Lifecycle = z.enum(["completable", "indefinite"]);
export const Persistence = z.enum(["durable", "ephemeral"]);

/** Built-in renderer ids for a catalog's declarative field presentation. The
 *  platform owns the renderer library; bundles/catalogs only pick one per
 *  field. See web/src/components/CatalogFieldValue.tsx. */
export const CatalogFieldRenderer = z.enum([
  "text",
  "color-hex",
  "image-url",
  "url-link",
  "year",
  "boolean",
  "code",
]);

/** The declarative config on an imported catalog (core-catalogs). The **single
 *  source of truth**, referenced by BOTH the module's write-time validator
 *  (`SchemaConfig`) AND the bundle installer (`CatalogEntry.schema`). Those two
 *  used to be hand-kept copies that drifted — each silently stripped keys the
 *  other had (`field_map`, `exclude_from_global_search`), breaking features on
 *  install. Add a catalog-schema key HERE, once, and both paths get it. Strict
 *  on purpose: an unrecognised key is a bug, not something to wave through. */
export const CatalogSchemaConfig = z.object({
  id_column: z.string().optional(),
  title_column: z.string().optional(),
  image_column: z.string().optional(),
  subtitle_column: z.string().optional(),
  description_column: z.string().optional(),
  /** Per-field renderer overrides, keyed by payload field name. */
  field_renderers: z.record(CatalogFieldRenderer).optional(),
  /** Per-field display-label overrides (`{ num_parts: "Pieces" }`). */
  field_labels: z.record(z.string()).optional(),
  /** Catalog-match prefill + preferred-catalog derivation:
   *  `{ catalogPayloadKey: instanceFieldName }`. */
  field_map: z.record(z.string()).optional(),
  /** Replace the card image slot with a renderer over `payload[hero_field]`
   *  (e.g. a colour swatch from `rgb`). */
  hero_field: z.string().optional(),
  hero_renderer: CatalogFieldRenderer.optional(),
  /** Keep a huge / non-matchable catalog (a set BOM) out of cross-catalog
   *  search + the quick-add typeahead. */
  exclude_from_global_search: z.boolean().optional(),
  /** Entity kinds this catalog is meaningful to match against (omit = all). */
  bindable_to_kinds: z.array(z.string()).optional(),
  /** Stable `<vendor>.<kind>` id so other modules find "the canonical sets
   *  catalog" without coupling to a bundle id. */
  semantic_type: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/).optional(),
});

/** Reverse map from a trait name to the axis it lives on. Used by
 *  the action matcher to compute the per-axis-OR / cross-axis-AND
 *  semantics for `appliesTo: { traits: [...] }`. */
export const AXIS_OF_TRAIT = {
  physical: "tangibility",
  digital: "tangibility",
  fungible: "identity",
  unique: "identity",
  container: "containment",
  containable: "containment",
  schedulable: "time",
  timeless: "time",
  completable: "lifecycle",
  indefinite: "lifecycle",
  durable: "persistence",
  ephemeral: "persistence",
} as const;

export type TraitName = keyof typeof AXIS_OF_TRAIT;
export type AxisName = (typeof AXIS_OF_TRAIT)[TraitName];

/**
 * TRIAL AXES: traits in every way but one - no preset or profile takes a
 * position on them. They exist so a face can be spelled in trait words
 * ("goes off" is `perishable`, "gets lent" is `lendable`) and matched by the
 * same per-axis-OR / cross-axis-AND rule, without asking every module author
 * to declare spoilage for a task or custody for a location.
 *
 * Resolved per COLLECTION by the faces resolver (api/src/platform/faces.ts),
 * from a field role or an explicit choice, never from the kind's declaration.
 * If one earns its keep it moves into AXIS_OF_TRAIT and the presets; that is a
 * move, not a rewrite, because everything already reads them through
 * axisOfTrait(). Decided 2026-09-09: "add these as extra traits for the
 * purpose of faces, defined the same way, and see how that goes."
 */
export const FACE_TRAIT_AXES = {
  perishable: "spoilage",
  keeps: "spoilage",
  lendable: "custody",
  kept: "custody",
} as const;
export type TrialTraitName = keyof typeof FACE_TRAIT_AXES;
export type TrialAxisName = (typeof FACE_TRAIT_AXES)[TrialTraitName];
export type AnyTraitName = TraitName | TrialTraitName;
export type AnyAxisName = AxisName | TrialAxisName;
/** The axis a trait lives on, real or trial. Undefined for an unknown word. */
export function axisOfTrait(t: string): AnyAxisName | undefined {
  return (AXIS_OF_TRAIT as Record<string, AxisName>)[t] ?? (FACE_TRAIT_AXES as Record<string, TrialAxisName>)[t];
}

/** The 12 trait words as a tuple, for validating client input against the
 *  vocabulary (z.enum) instead of re-listing it somewhere it can drift. */
export const TRAIT_NAMES = Object.keys(AXIS_OF_TRAIT) as [TraitName, ...TraitName[]];

// One axis assignment. Three valid shapes:
//   "physical" — the entity sits on this trait
//   null — axis skipped (doesn't meaningfully apply)
//   { trait: "unique", uncertain: true } — judgment call, signaled
const axisAssignment = <T extends z.ZodTypeAny>(values: T) =>
  z.union([
    values,
    z.null(),
    z.object({ trait: values, uncertain: z.literal(true) }),
  ]);

const RawTraits = z.object({
  tangibility: axisAssignment(Tangibility).optional(),
  identity: axisAssignment(Identity).optional(),
  containment: axisAssignment(Containment).optional(),
  time: axisAssignment(TimeAxis).optional(),
  lifecycle: axisAssignment(Lifecycle).optional(),
  persistence: axisAssignment(Persistence).optional(),
});

export type RawTraitsDecl = z.infer<typeof RawTraits>;

// The 10 platform-blessed presets. Each maps to a 6-tuple of trait
// values. Modules use `profile: "<name>"` as shorthand and `overrides`
// to flip individual axes from the preset's defaults.
// See docs/architecture/traits.md §"Presets — preset shorthand".
export const TRAIT_PRESETS = {
  "digital-record": {
    tangibility: "digital",
    identity: "unique",
    containment: null,
    time: "timeless",
    lifecycle: "indefinite",
    persistence: "durable",
  },
  // A lean catalog record — a film, a book, a board game. The face an
  // inventory instance shows when it carries no stock signal (see
  // one-record-substrate.md). Identity is UNIQUE — the load-bearing axis:
  // catalog records are counted per-title, so combine/merge treats duplicates
  // as one thing (max), never summing a phantom quantity the way it would for
  // fungible stock. Tangibility is uncertain: a film is digital, a shelved book
  // is physical, and the catalog face neither knows nor needs to.
  "catalog-record": {
    tangibility: { trait: "physical", uncertain: true },
    identity: "unique",
    containment: "containable",
    time: "timeless",
    lifecycle: "indefinite",
    persistence: "durable",
  },
  "owned-thing": {
    tangibility: "physical",
    identity: "unique",
    containment: "containable",
    time: "timeless",
    lifecycle: "indefinite",
    persistence: "durable",
  },
  place: {
    tangibility: "physical",
    identity: "unique",
    containment: "container",
    time: "timeless",
    lifecycle: "indefinite",
    persistence: "durable",
  },
  "work-item": {
    tangibility: "digital",
    identity: "unique",
    containment: null,
    time: "schedulable",
    lifecycle: "completable",
    persistence: "durable",
  },
  "stock-material": {
    tangibility: "physical",
    identity: "fungible",
    containment: "containable",
    time: "timeless",
    lifecycle: "indefinite",
    persistence: "durable",
  },
  "recurring-schedule": {
    tangibility: "digital",
    identity: "unique",
    containment: null,
    time: "schedulable",
    lifecycle: "indefinite",
    persistence: "durable",
  },
  "one-shot-completable": {
    tangibility: "digital",
    identity: "unique",
    containment: null,
    time: "timeless",
    lifecycle: "completable",
    persistence: "durable",
  },
  "auto-pruning-record": {
    tangibility: "digital",
    identity: "unique",
    containment: null,
    time: "timeless",
    lifecycle: "indefinite",
    persistence: "ephemeral",
  },
  "vendor-order": {
    tangibility: "digital",
    identity: "unique",
    containment: null,
    // Dictionary marks Time as `(?)` for vendor orders — vendor's
    // external schedule isn't the workspace's schedule. We collapse
    // to schedulable here; module authors can override if they
    // disagree.
    time: "schedulable",
    lifecycle: "completable",
    persistence: "durable",
  },
} as const satisfies Record<string, RawTraitsDecl>;

export type PresetName = keyof typeof TRAIT_PRESETS;

const PresetNameSchema = z.enum(
  Object.keys(TRAIT_PRESETS) as [PresetName, ...PresetName[]],
);

const EntityKind = z
  .object({
    id: z
      .string()
      .regex(EntityKindIdRegex, "entity kind id must be <module>:<name>"),
    displayName: z.string().min(1),
    displayNamePlural: z.string().optional(),
    icon: z.string().optional(),
    fields: z.array(EntityField).default([]),
    // Cross-module read whitelist — see docs/architecture/entity-resolver.md.
    // Field names other modules' renderers can read via platform.entities.lookup()
    // / the resolver. The kernel projects ResolvedEntity.fields to this list
    // before returning to a foreign caller; anything not declared is private
    // to the owning module.
    //
    // Implicit always-exposable: `id`, `title`, `subtitle`, `image_path`,
    // `detailUrl` (the cross-cutting display props on ResolvedEntity itself).
    //
    // Default behaviour when omitted: legacy — full ResolvedEntity.fields
    // is returned and a one-time deprecation warning is logged per kind.
    // New modules SHOULD declare exposableFields.
    // What "the same place" means for this kind, when deciding whether two
    // records are duplicates of each other. The field name that scopes it
    // (`parent_id` for locations, `location_id` for parts), or "workspace" for
    // a kind where two of the same title anywhere is a duplicate.
    //
    // ABSENT MEANS NOT DEDUPLICATED, deliberately. Two assets called "Drill"
    // are usually two drills; two projects called "Kitchen" are usually a
    // rename in progress. Guessing that same-title means same-thing is exactly
    // the guess that deletes somebody's work, so a kind opts IN by saying how
    // it should be read.
    duplicateScope: z.union([z.literal("workspace"), z.string().min(1)]).optional(),
    // The kind whose records are THIS kind's own categories (inventory:part's
    // is inventory:category: a table of categories, a category_id on the
    // record, a filter in its list). The platform's scan category axis on such
    // a kind is a second question with the same name; it is labelled as
    // scanning's so a form does not ask "Category" twice, until the two are
    // joined into one axis that reads and grows these records.
    categoryAxis: z.string().min(1).optional(),
    // A native text field on the record that IS this kind's category
    // (assets:asset's `type`, "Type / category" on its form). The scan
    // category axis answers from it instead of adding a "Category" custom
    // field beside it, so a record has one category whether it was scanned
    // or typed. A kind declares this or `categoryAxis`, never both.
    categoryField: z.string().min(1).optional(),
    exposableFields: z.array(z.string().min(1)).optional(),
    // Fields the MEMBER'S OWN ASSISTANT may read beyond exposableFields (Cobb,
    // or an MCP client acting as that member): what a person wrote for
    // themselves, like a part's notes, that they can already read in the app.
    // Never to other modules, shares or other workspaces, and still under
    // fieldReadScopes. The AI settings tell the person their assistant reads
    // them (#4798).
    assistantReadableFields: z.array(z.string().min(1)).optional(),
    // Per-field read-scope (H2): map a field name to the capability
    // (action_id) a viewer must hold to read it. Layered ON TOP of
    // exposableFields — a field must be exposable AND (if listed here)
    // the viewer must hold its capability, else the kernel omits it
    // from the read. Owner/admin and viewer-less internal reads see
    // everything; the member-facing views/portal path passes the
    // viewer. Enables tiered member access ("Tier 1 sees parts, not
    // prices"). The capability should be a grantable action so admins
    // can assign it via roles / the permission matrix.
    fieldReadScopes: z.record(z.string().min(1), z.string().min(1)).optional(),
    // Path template (relative to PUBLIC_BASE_URL) for the entity's
    // canonical detail page. {id} placeholder gets substituted.
    detailRoute: z.string().optional(),
    // Module-relative GET endpoint for lookup. {id} placeholder.
    // The platform proxies to this when other modules ask for the
    // entity's data via platform.entities.lookup().
    getEndpoint: z.string().optional(),
    // Module-relative POST collection endpoint that creates one record of this
    // kind (e.g. "/entries"). Declaring it makes the kind creatable by generic
    // callers — the Ask Cobb chat's create proposals + the workspace-tools
    // registry (in-app tool loop + MCP). Only declare it when the plain
    // collection POST accepts a simple fields body; leave unset for kinds
    // created via actions/wizards.
    createEndpoint: z.string().optional(),
    // Module-relative PATCH endpoint that partially updates one record
    // (e.g. "/entries/{id}"). Same contract as createEndpoint: declaring it
    // makes the kind updatable by generic callers; the PATCH must accept a
    // partial fields body.
    updateEndpoint: z.string().optional(),
    // Module-relative DELETE endpoint for one record (e.g. "/entries/{id}").
    // Declaring it makes the kind deletable by generic callers.
    deleteEndpoint: z.string().optional(),
    // THE module's primary kind — the entity its instance-scoped item routes
    // (/orgs/:slug/instances/:name/items) dispatch to (primaryRouter). At most
    // one kind per module declares it. Instance-kind synthesis copies the
    // primary kind's shape (fields/traits/endpoints) for each named instance;
    // a multi module without a declared primary simply gets no synthesized
    // instance kinds (honest opt-in, never guessed — sales' FIRST kind is
    // customer but its primary is order, so declaration order can't be trusted).
    primary: z.boolean().optional(),
    // Module-relative GET collection endpoint listing this kind's records
    // (e.g. "/entries") — the module's OWN full-fat list, enforcing its own
    // role gating. Declaring it lets FIRST-PARTY generic surfaces (the floor
    // plan's entity occupants, future pickers) enumerate rows with the fields
    // the module's own pages see (location_id, metadata, image_path) — data
    // the exposableFields-projected /entities/:kind list deliberately hides
    // from foreign/member callers. Response contract: { items: [...] } where
    // rows carry at least id + the kind's declared fields.
    listEndpoint: z.string().optional(),
    version: z.string().optional(),
    // Cross-module trait declarations. Three mutually-exclusive
    // forms:
    //   1. raw — `traits: { tangibility: "physical", ... }`
    //   2. preset — `profile: "owned-thing"`
    //   3. preset + override — `profile: "owned-thing", overrides: { lifecycle: "completable" }`
    // `defineModule()` resolves form 2/3 into form 1 at load time so
    // downstream code only ever reads `traits`.
    traits: RawTraits.optional(),
    profile: PresetNameSchema.optional(),
    overrides: RawTraits.optional(),
    // Labeling hint (read generically by the `labels` module via the kernel
    // entity-kind registry — NOT a labels-specific coupling). Whether a
    // printed label draws the human-readable code in the QR center DEFAULTS
    // to this per-kind value when the workspace hasn't set an explicit
    // toggle. Omitted => true (today's behavior). A kind sets it `false`
    // when its entities are name-unique / non-enumerable enough that a
    // disambiguating code is noise — e.g. a location ("the Office"), unlike
    // "monitor 5 of 17". Any module may declare it; a generic extension
    // point, not a special case. A user's explicit per-kind toggle still
    // wins over this default. See docs/design-decisions/label-codes.md.
    labelCodeOverlayDefault: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.traits && data.profile) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `entity kind '${data.id}': cannot use both 'traits' (raw) and 'profile' (preset) at once — pick one`,
        path: ["profile"],
      });
    }
    if (data.overrides && !data.profile) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `entity kind '${data.id}': 'overrides' only makes sense alongside 'profile'`,
        path: ["overrides"],
      });
    }
    // exposableFields must reference declared field names (or the
    // implicit-always-exposable cross-cutting props on ResolvedEntity).
    if (data.exposableFields) {
      const declared = new Set(data.fields.map((f) => f.name));
      const implicit = new Set([
        "id",
        "title",
        "subtitle",
        "image_path",
        "detailUrl",
      ]);
      for (const name of data.exposableFields) {
        if (!declared.has(name) && !implicit.has(name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `entity kind '${data.id}': exposableFields references '${name}' which is neither a declared field nor an implicit cross-cutting prop (id/title/subtitle/image_path/detailUrl)`,
            path: ["exposableFields"],
          });
        }
      }
    }
    // fieldReadScopes keys must be declared fields, and a gated field
    // should also be exposable — gating a field the whitelist already
    // hides is a no-op and almost always a mistake.
    if (data.fieldReadScopes) {
      const declared = new Set(data.fields.map((f) => f.name));
      const exposable = data.exposableFields
        ? new Set(data.exposableFields)
        : null;
      for (const name of Object.keys(data.fieldReadScopes)) {
        if (!declared.has(name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `entity kind '${data.id}': fieldReadScopes gates '${name}', which is not a declared field`,
            path: ["fieldReadScopes"],
          });
        } else if (exposable && !exposable.has(name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `entity kind '${data.id}': fieldReadScopes gates '${name}' but it isn't in exposableFields, so the whitelist already hides it — add it to exposableFields or drop the scope`,
            path: ["fieldReadScopes"],
          });
        }
      }
    }
  });

// ─────────────────────── Pillar B: actions ─────────────────────────
//
// Modules declare what they can do TO entities. Actions list the
// kinds they apply to — either by explicit ID, or by predicate
// ({ any: true } / { hasFieldRole: 'title' }).

// ─────────────────────── Wire target (Q1) ─────────────────────────
//
// What the wire fires the action on. Two forms:
//   - "self" (or omitted) — action runs on the source entity. The
//     no-target-declared default; preserves today's fire-on-source
//     behaviour.
//   - { rel, dir?, kind? } — action runs on entities discovered by
//     walking entity_pairings from the source. `rel` is required;
//     `dir` defaults to "in" (incoming pairings — find things that
//     point AT the source via this relation); `kind` filters target
//     kinds when one source pairs with multiple kinds via the same
//     relation.
// See docs/architecture/wires-and-bundles.md (Q1, resolved).
export const WireTarget = z.union([
  z.literal("self"),
  // "none": the wire fires with NO entity context — for trigger events
  // that don't originate from an entity (e.g. an inbound webhook). The
  // action locates its own target from its (template-rendered) args;
  // templates see only the event.* block. See wires-and-bundles.md.
  z.literal("none"),
  z.object({
    rel: z.string().min(1),
    dir: z.enum(["in", "out"]).optional(),
    kind: z.string().optional(),
  }),
]);

export type WireTargetDecl = z.infer<typeof WireTarget>;

// Action predicate. Either {any: true} (universal) or a structured
// predicate combining kinds + traits + hasFieldRole. Across the three
// sub-predicates the semantics is OR (any one hitting matches); within
// `traits` the semantics is AND (all listed traits must be present).
//
// Examples:
//   { kinds: ["projects:task"] }
//     → only this exact kind
//   { traits: ["physical"] }
//     → any entity kind whose trait fingerprint includes "physical"
//   { traits: ["physical", "fungible"] }
//     → both required (Stock material profile only)
//   { traits: ["physical"], kinds: ["projects:task"] }
//     → any physical thing OR specifically this task kind
//   { hasFieldRole: "title" }
//     → any kind that declared a field with role=title
const ActionAppliesTo = z.union([
  z.object({ any: z.literal(true) }),
  z
    .object({
      kinds: z.array(z.string()).min(1).optional(),
      traits: z.array(z.string()).min(1).optional(),
      // A native field role ("quantity") OR a workspace field role ("expiry",
      // "assignee"). The second half is what lets an action follow the
      // WORKSPACE's own vocabulary: a bundle marks its "Best before" field as
      // expiry, and every action about perishables appears on that table and
      // on no other. Before this, the only way to scope "Threw it out" was to
      // the whole inventory kind, so a box of screws offered it too.
      hasFieldRole: z.union([EntityFieldRole, FieldRoleSchema]).optional(),
      // What the record must ALSO be, whichever of the above matched. The
      // three above are OR; this is AND. A status, a home or a stock count
      // belongs to a physical thing, so an action scoped to a module's kind
      // says `requires: { traits: ["physical"] }` and is not offered on a
      // collection of that kind that holds descriptions of things (a filament
      // TYPE, whose collection resolves no traits).
      requires: z.object({ traits: z.array(z.string()).min(1) }).optional(),
    })
    .refine(
      (d) => d.kinds || d.traits || d.hasFieldRole,
      "appliesTo: must specify at least one of kinds, traits, or hasFieldRole (or use { any: true } for universal match)",
    ),
]);

export const ActionIdRegex = /^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$/;

// A permission a module checks at one of its own routes that is not an action
// anyone runs: "delete a place with places inside it" is the Delete button
// on a bigger target, not a verb of its own. Declared here, it appears in the
// permissions matrix beside the actions, an admin can grant it, and a member
// refused it gets the ask (approvals.ts), because a capability nobody can
// grant is a door only the admin tier can ever pass.
export const ModuleCapability = z.object({
  id: z.string().regex(ActionIdRegex, "capability id must be <module>:<name>"),
  label: z.string().min(1),
  // What holding it lets a person do, shown in the permissions matrix under
  // the label, where an admin decides whether to grant it.
  description: z.string().min(1),
});
export type ModuleCapability = z.infer<typeof ModuleCapability>;


// A COMMAND a module ships: a sentence its users would type, and what to do
// when they type it.
//
// The no-AI floor answers with text, so a workspace without a model can be told
// how to add a location and never asked to add twelve. A workspace can teach
// itself commands by watching an AI work (docs/…/learned commands), but that
// only helps somebody who already had an AI. Shipping the common ones means a
// brand-new workspace, with no AI at all, can already be asked for the handful
// of things everyone wants.
//
// The author writes the SENTENCE, never a regex: `template` is compiled into
// its pattern and slots. A hand-written expression is a way to get subtly wrong
// something that writes to workspaces.
const ModuleCommand = z.object({
  // Stable id, <module>:<name>, so a workspace can turn one off by name.
  id: z.string().regex(ActionIdRegex, "command id must be <module>:<name>"),
  // What a user would type, with {blanks}: "make rack {from} through {to} in
  // {parent}". `from`/`to` are the range pair by convention and the only slots
  // that match digits.
  template: z.string().min(3).max(300),
  // One line for the settings list: what it does, in words. It may carry the
  // template's {blanks}: "Add {choice} to the {field} choices" reads as a
  // description in the list and, filled with what the person typed, is the
  // offer's own summary ("Add Aran to the yarn weight choices") instead of
  // the generic "Runs edit field".
  description: z.string().max(300).optional(),
  // What to do, with {slot} references. Same shape a learned command stores, so
  // shipped and learned commands run through exactly one code path.
  plan: z
    .array(
      z.object({
        tool: z.enum(["create", "update", "delete", "action"]),
        entityKind: z.string().default(""),
        actionId: z.string().optional(),
        payload: z.record(z.unknown()),
      }),
    )
    .min(1)
    .max(5),
  // For a command that repeats over a range: which payload field counts, and
  // the shape around the counter ("Rack {n}").
  repeatField: z.string().optional(),
  repeatShape: z.string().optional(),
});
export type ModuleCommandDecl = z.infer<typeof ModuleCommand>;

/** One blank in a command template. */
export interface CommandSlot {
  name: string;
  kind: "text" | "number" | "range";
}

function escapeCommandRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile a written template into the pattern and slots that bind it.
 *
 *   "make rack {from} through {to} in {parent}"
 *     → ^\s*make rack (\d+) through (\d+) in (.+?)\s*$
 *     → from:number, to:number, parent:text
 *
 * This is what lets a MODULE ship a command: an author writes the sentence
 * their users would type and never writes a regex. Nobody should have to
 * hand-author an anchored expression with the capture groups in slot order to
 * contribute one, and a hand-written one is a way to get it subtly wrong in a
 * thing that writes to workspaces.
 *
 * `from` and `to` are the range pair by convention, and are the only slots
 * matched as digits — everything else is text.
 */
export function compileTemplate(template: string): { pattern: string; slots: CommandSlot[] } | null {
  const text = template.trim();
  if (!text) return null;
  const slots: CommandSlot[] = [];
  let pattern = "";
  let last = 0;
  for (const m of text.matchAll(/\{([a-z0-9_]+)\}/gi)) {
    const name = m[1]!;
    if (slots.some((s) => s.name === name)) return null; // one capture per slot
    pattern += escapeCommandRegex(text.slice(last, m.index!));
    const numeric = name === "from" || name === "to";
    pattern += numeric ? "(\\d+)" : "(.+?)";
    slots.push({ name, kind: numeric ? "number" : "text" });
    last = m.index! + m[0]!.length;
  }
  if (slots.length === 0) return null; // a command with no blanks is a macro
  pattern += escapeCommandRegex(text.slice(last));
  return { pattern: `^\\s*${pattern}\\s*$`, slots };
}



/** A KIND of workspace notification a module sends: the eventType it
 *  dispatches with, and the name a person would recognise it by on the
 *  "who gets told" settings page. */
export const NotificationKind = z.object({
  eventType: z.string().regex(/^[a-z0-9-]+\.[a-z0-9._-]+$/, "eventType is <module>.<what>"),
  label: z.string().min(1).max(80),
  description: z.string().max(300).optional(),
});
export type NotificationKind = z.infer<typeof NotificationKind>;

const EntityAction = z.object({
  group: ActionGroupReference.optional(),
  primary: z.boolean().default(false),
  id: z
    .string()
    .regex(ActionIdRegex, "action id must be <module>:<name>"),
  label: z.string().min(1),
  description: z.string().optional(),
  icon: z.string().optional(),
  appliesTo: ActionAppliesTo.default({ any: true }),
  // Entity vs workspace scope. Default "entity": the action runs ON a record
  // — the entity-detail button, a wire target, invoke_action with an entity.
  // "workspace": a config/admin operation that runs on the WORKSPACE itself,
  // not any one record (rename a label-code prefix, flip a default, seed a
  // group). A workspace action skips entity resolution (its handler's ctx has
  // no `entity`), never renders as an entity-detail button, and `appliesTo` is
  // ignored (it matches no kind). Crucially it is reached through the SAME
  // invoke_action rail with no entity_kind/entity_id — which is how a config
  // operation becomes AI-reachable (Cobb / MCP) WITHOUT a bespoke per-op tool.
  // See docs/architecture/wires-and-bundles.md and the AI-reachability lint.
  scope: z.enum(["entity", "workspace"]).default("entity"),
  // Whether this action renders as a clickable button on entity-
  // detail pages. Default true. Set false for wire-only actions
  // (event reactions) — they're still targetable by wires, just
  // not surfaced as a manual button.
  userInvokable: z.boolean().default(true),
  // Exists only as the way back for another action: registered as an undo
  // step, run by Undo on a card through the actions route, and otherwise
  // unreachable. Not a button (userInvokable is false too), and not in any
  // list the assistant reads: the registry hides it from every reader that
  // does not ask for it, and the chat refuses a model that names one. A
  // guard holds that every action reached only as an undo step says this.
  internal: z.boolean().default(false),
  // Fired by an EVENT and nothing else: its record is named by the event's
  // payload (a task by linkedTaskId, an inbox row by the scan), so asked in
  // words there is nothing to act on. Not offered to the assistant, on the
  // rail or in list_actions. This is NOT `userInvokable: false`, which only
  // says "no button on the record's page" and is set on plenty of actions
  // the assistant runs every day (placing a thing in a bin, tagging it,
  // adjusting stock); reading that flag as wire-only took twelve of those
  // off the rail (2026-09-14). An action that says this has no phrasings
  // (a guard holds it), and an event-subject action with none says this.
  wireOnly: z.boolean().default(false),
  // An entity-scoped action that may ALSO run with no record: its handler
  // reads `ctx.entity` when there is one and its arguments when there is
  // not. lists:add-item is the case: a low-stock wire adds THIS part to the
  // shopping list, and a person says "put milk on the shopping list" where
  // milk is not a record at all. Without this the invoke door required a
  // record for every entity action, so the action's own example sentence
  // could not run, and a stranger asking it got an empty list created and
  // no milk (2026-09-22, #3255). Not `scope: "workspace"`, which would strip
  // the record from the wire that has one.
  recordOptional: z.boolean().default(false),
  // Can running this by mistake be put right again, INSIDE the workspace?
  //
  // This is what decides whether an AI connection that cannot show a
  // confirmation prompt may run it. The rule was "records yes, actions never",
  // which is not the real line: a relayed chat auto-applies create / update /
  // DELETE on records because those are tracked and undoable, and it blocked
  // reordering locations, which is undone by reordering them again. Cobb was
  // left saying he had no tool for it at all (2026-08-19).
  //
  // Default FALSE, because the unsafe answers are the interesting ones: an
  // action can command a device, send a message, place an order or destroy a
  // set of rows, and none of those come back. Say `undoable: true` only when
  // every effect stays in this workspace AND a person can put it back without
  // help. When in doubt, leave it: the cost is a refusal that explains itself,
  // not a silently missing capability.
  undoable: z.boolean().default(false),
  /** Who may run it without being granted it: the lowest role, by rank
   *  (@cobblr/platform-contract/org-roles). A guest never is. Absent: the
   *  admin tier, and anyone granted it (#5170).
   *
   *  The ONE answer for every door. A route that does the same thing gates
   *  with requireCapability on this action's id, which reads this, so a
   *  member who may add a line on the Purchases page may add it through the
   *  API and through Cobb too, and one who may not is refused at all three.
   *  lint:route-and-action-gate-agree holds every paired route to it.
   *
   *  `"requester"`: the person who started what it answers (their service
   *  job, the change the assistant held for them) runs it whatever their
   *  role, and the admin tier as ever; the module registers who that is with
   *  platform().actions.registerRequester (#5192). Every invokable action
   *  says one of these or `grantedAs` (lint:every-action-says-who-runs-it). */
  runBy: z.union([z.enum(ORG_ROLES).refine((r) => r !== "guest", "A guest never runs an action by role."), z.literal("requester")]).optional(),
  /** A capability whose grant also covers this action, when several actions
   *  share one permission (inventory's holdings are all "add a part"). */
  grantedAs: z.string().regex(ActionIdRegex).optional(),
  /** What running it does to the world, which decides who has to say yes
   *  (services.md §9): `none`, `writes`, `physical` (moves or heats
   *  something: sending a print) or `spends`. The same field a service
   *  capability declares. Absent reads as `writes`. `physical` is never run
   *  without a person's confirm, from any door. */
  effect: z.enum(SERVICE_EFFECTS).optional(),
  /** What this action does to a dated thing that is due, when it is one of
   *  the verbs that settle it: `used` (it is gone, used), `discarded` (it went
   *  off and was thrown out), `still-good` (checked, fine, due again later).
   *  A surface that lists what is due ("needs you") offers the applicable
   *  actions that declare one, so no screen names a module's action ids and a
   *  new module's verbs appear by declaring this. Absent = not such a verb. */
  finishes: z.enum(["used", "discarded", "still-good"]).optional(),
  /** Which face this verb belongs to, for DISCLOSURE: a hidden face takes its
   *  verbs off the record along with its fields and panels. Eligibility is
   *  `appliesTo` (facts); this is the person's choice. Absent = the base
   *  record, shown whatever is hidden. */
  face: FaceSchema.optional(),
  // How a PERSON asks for this, in their own words. One or two lines.
  //
  // The action list in the assistant's prompt is ids and labels, which tells a
  // model what exists and not what a request for it sounds like. An example is
  // the cheapest possible bridge between "someone typed a sentence" and "this
  // is the action that answers it", and it doubles as the phrasing a command
  // can be written from. Kept short: these ride in every chat prompt.
  examples: z.array(z.string().min(3).max(120)).max(3).default([]),
  // UI route the platform navigates to when the user clicks the
  // action. {entityKind}, {entityId} placeholders.
  invokeRoute: z.string().optional(),
  // Handler key the module registered via
  // platform.actions.registerHandler() at boot. Optional — actions
  // can be route-only.
  invokeHandler: z.string().optional(),
  // Optional machine-readable arg shape. Keys are the arg names the
  // invokeHandler reads from ctx.args; each has a label + a type. The wire
  // composer renders a labelled field per arg (each value a literal or a
  // {{token}}); the wire engine renders string args at fire time. Absent →
  // the composer falls back to a free template.
  //
  // "list" is a sequence, not a scalar. It exists because core-locations:reorder
  // takes `ids` and could only declare itself "text", so every caller that read
  // the schema was told to send a string to a handler that required an array —
  // and an assistant reading that concluded it could not run the action at all
  // (2026-08-19). A "list" arg must be accepted by its handler BOTH as a real
  // array and as a delimited string, since the wire composer's field is a text
  // box and always will be. "json" is the same bargain for a structured value
  // (an order's line items, a view's config): read it with readJsonArg.
  // `required`: the handler cannot do without it. The invoke door, the
  // assistant's guard and the bench all read this one flag, so a call that
  // drops it is refused before it becomes a card that dies on press; without
  // it every caller assumed and nothing noticed (#3123). An argument the
  // handler defaults or tolerates absent is left unmarked.
  argsSchema: z
    .record(
      z.object({
        label: z.string().min(1),
        // `date` is a calendar day (YYYY-MM-DD), asked with a date picker.
        type: z.enum(["text", "number", "boolean", "list", "json", "date"]).default("text"),
        required: z.boolean().optional(),
        // Required as a group ("fields or rename_to"): at least one of the
        // arguments naming the same group must be carried.
        oneOf: z.string().min(1).optional(),
        // What may be picked, in a person's words; the form offers a choice
        // instead of a text box. `choicesFrom` is the same for choices that
        // depend on the record's kind (its counters), resolved by the server
        // when it lists the kind's actions.
        choices: z.array(z.object({ value: z.string().min(1), label: z.string().min(1) })).optional(),
        choicesFrom: z.enum(["counters", "people"]).optional(),
        // Offered on the button's sheet though the action runs without it.
        ask: z.boolean().optional(),
        // Asked and required together with that argument (every_n with
        // every_unit): the form waits for both and the door refuses one alone.
        with: z.string().min(1).optional(),
        // An amount of money, given the way a person says it ("45", "$45.50"):
        // asked with the money input, shown on a confirm card as "$45.50", and
        // turned into its column's shape by the handler
        // (@cobblr/platform-contract/money moneyForStorage). Never cents.
        money: z.boolean().optional(),
      }),
    )
    .optional(),
  // The event payload keys this action reads when a wire fires it and the
  // wire's own args do not say (adjust-stock takes partId and delta off the
  // event). Every shipped wire into this action must then carry each key in
  // its args or trigger on an event whose declared payload has it:
  // "Mark arrived" once emitted `qty` where the stock wire read `delta`, the
  // wire skipped in silence, and nothing added the stock
  // (scripts/every-wire-gets-what-its-action-reads.test.ts).
  readsFromEvent: z.array(z.string().min(1)).optional(),
  version: z.string().optional(),
});

// A LIVE CONTROL — the Live box (docs/design-decisions/live-controls.md). An
// ongoing session mode a module exposes: scan-drive, auto-print, a drive
// indicator. The platform aggregates these across enabled modules; the box
// renders only the ones whose `requires` capability the workspace currently
// satisfies (none apply → the box renders nothing, like DriveBanner when idle).
// The declaration is metadata + gating + shape; reading/writing the toggle wires
// per `scope` (see the doc §6).
const LiveControlIdRegex = /^[a-z0-9][a-z0-9_-]*\.[a-z0-9][a-z0-9_-]*$/;
const LiveControl = z
  .object({
    // Stable id, <module>.<name>, e.g. "labels.auto-print".
    id: z.string().regex(LiveControlIdRegex, "live control id must be <module>.<name>"),
    label: z.string().min(1),
    // Kebab-case lucide icon name.
    icon: z.string().min(1),
    // The capability signal that must be present for this control to appear
    // (e.g. "printer.connected", "scanner.bridge") — a capability a module
    // provides. The box hides the control unless the workspace satisfies it;
    // this is what keeps the box self-hiding without any module knowing it exists.
    requires: z.string().min(1),
    // Where the on/off lives, so a flip writes to the right place:
    //   tab       — this browser tab only (localStorage; scan-drive follower)
    //   user      — the signed-in user everywhere (server; auto-print policy)
    //   workspace — the whole org (server)
    scope: z.enum(["tab", "user", "workspace"]).default("user"),
    // The shape the renderer draws:
    //   switch         — a bare toggle
    //   switch-segment — a toggle + an inline segmented choice (needs `segment`)
    //   switch-detail  — a toggle + an expandable body + a "configure" deep-link
    //   status         — a status row + stop/dismiss, no on-toggle (the drive
    //                    indicator fold-in)
    control: z.enum(["switch", "switch-segment", "switch-detail", "status"]).default("switch"),
    // For control "switch-segment" — the inline choices (Open/Print for scan-drive).
    segment: z.array(z.object({ value: z.string().min(1), label: z.string().min(1) })).optional(),
    // For scope user/workspace — the org-scoped path the box GETs for current
    // state and PUTs to flip. Omitted for scope tab (the renderer uses a
    // client-side adapter keyed by `id`; doc §6).
    endpoint: z.string().optional(),
    // Deep-link the expanded "configure" opens (control "switch-detail").
    detail: z.string().optional(),
    // Sort order within the box (ascending); absent sorts after ordered ones.
    order: z.number().optional(),
    version: z.string().optional(),
  })
  .superRefine((c, ctx) => {
    if (c.control === "switch-segment" && (!c.segment || c.segment.length < 2)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "control 'switch-segment' needs a `segment` of at least 2 choices" });
    }
    if ((c.scope === "user" || c.scope === "workspace") && c.control !== "status" && !c.endpoint) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `scope '${c.scope}' control needs an \`endpoint\` (server-side state)` });
    }
  });

/** The Configuration pages a module may add a section to
 *  (`contributes.panels`, surface "configuration-section"), by their path under
 *  /configuration. A kernel settings page that shows one module's setting
 *  hosts it this way rather than importing the module's code
 *  (lint:kernel-config-pages-name-no-module). */
export const CONFIGURATION_SECTION_HOSTS = ["notification-audiences"] as const;
export type ConfigurationSectionHost = (typeof CONFIGURATION_SECTION_HOSTS)[number];

const ModuleManifest = z.object({
  // Stable identifier — must be unique across the platform, used as
  // the table prefix and the URL segment under /api/v1/modules/.
  // Module name doubles as a URL segment + a key in module_field_defs.source_module
  // etc. Leading digit allowed so names like "3d-printers" work; everything must
  // still be kebab/snake-case ascii.
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "name must be kebab/snake-case ascii"),
  aliases: z.array(z.string().regex(/^[a-z0-9][a-z0-9_-]*$/)).optional(),
  retirement: z.object({
    reason: z.string().trim().min(1),
    replacement: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/).optional(),
  }).optional(),
  version: z.string().regex(/^\d+\.\d+\.\d+/, "version must be semver-ish"),
  displayName: z.string().min(1),
  description: z.string().min(1),
  icon: z.string().optional(),
  // Module band — see docs/architecture/module-layers.md.
  //   foundational: platform can't work without it (very small set;
  //                  no per-workspace disable toggle)
  //   stock:        ships in the default Cobblr install + default-enabled,
  //                  toggleable per workspace. The Apple-first-party-app
  //                  band (gold, but deletable).
  //   marketplace:  community-authored, downloadable, requires explicit
  //                  install. Future tense — band exists in the model so
  //                  we don't have to redesign when it ships.
  //   user:         custom-built for one specific app — a workshop app's
  //                  workshop-mods, a homestead app's livestock module.
  // Default 'user' so any module without a declared band lands in the
  // most-conservative bucket (user-controlled, freely toggleable).
  // Maintainers curate which modules are *actually* foundational /
  // stock; declaring band: 'foundational' in an unrelated user module
  // is informational only — the platform won't treat it as such unless
  // it's also in the curated foundational list (see module-layers.md
  // §"Foundational modules — the strict-test band").
  band: z.enum(["foundational", "stock", "marketplace", "user"]).default("user"),

  // Release maturity — distinct from `band` (band = where in the layer model;
  // maturity = how finished). The UI surfaces it as a badge. The ladder:
  //   hidden:       merged but off everywhere — never loads. The dark-ship
  //                 state: land a module's code + migrations on main to keep
  //                 main releasable, invisible until you promote it up.
  //   experimental: rough / narrow / may change or vanish; an "Experimental"
  //                 badge, AND skipped at load when
  //                 COBBLR_DISABLE_EXPERIMENTAL_MODULES=true (the public /
  //                 trial default) so a half-baked connector never fronts a
  //                 public deploy.
  //   beta:         usable but still moving; a "Beta" badge. Unlike
  //                 experimental it is NEVER hidden — it always loads, even
  //                 under COBBLR_DISABLE_EXPERIMENTAL_MODULES — it just tells
  //                 the user "sub-1.0, expect change". The rung for a module
  //                 that is real and shipping but not yet at 1.0.
  //   stable:       ready for general use; no badge.
  // The same ladder + badge applies to a FEATURE (a LiveControl) via the
  // capability gate — one vocabulary, two zooms. See
  // docs/design-decisions/release-channels.md + architecture/module-layers.md.
  maturity: z.enum(["hidden", "experimental", "beta", "stable"]).default("stable"),

  // Capability vs. domain. A *capability* module is ambient plumbing that
  // makes other things work (views, search, scan, ai, recurrence, …) — it
  // has no decision content ("do you want search?") and no behavioural
  // side-effects until used, so it's enabled for every new workspace
  // automatically. A *domain* / connector module (inventory, machines,
  // digifab, …) adds nav nouns + per-user relevance, so it stays an
  // explicit opt-in (the module picker / "+ New thing" funnel). Foundational
  // modules are always-on regardless; this flag is for the stock band.
  // See docs/architecture/module-layers.md.
  autoEnable: z.boolean().default(false),

  /** An optional outside integration, offered under services, not a collection row. */
  integration: z.object({ route: z.string().startsWith("/") }).optional(),

  // A user-facing NAV entry this module contributes, even though the `core-`
  // prefix / foundational band would otherwise exclude it from the navbar.
  //
  // The nav hides every `core-*` module on the convention that the prefix means
  // plumbing. That is right for most of them, but a module can be foundational
  // AND something you browse daily — locations, files, tags, saved views — and
  // such a module had nowhere to go except /configuration. That is how the
  // settings area became the dumping ground for data browsers, and why
  // Locations ended up reachable at two URLs (one of them inside the settings
  // shell) until 2026-07.
  //
  // Declaring `nav` is the escape hatch, made declarative: it used to be two
  // hardcoded synthetic entries in useNavModules (core-scan, core-locations),
  // so the next such module needed a code change in the host to be reachable.
  //
  // `route` is the canonical URL for the page — the ONE place it lives. Do not
  // also register it as a settings destination.
  // See docs/design-decisions/configuration-revamp.md.
  nav: z
    .object({
      /** The noun as the user sees it, singular-or-plural as it reads in a
       *  navbar ("Locations", "Files", "Tags"). A workspace can rename it via
       *  Presentation; this is the default. */
      label: z.string().min(1),
      /** Canonical route. Must be mounted in the host. */
      route: z.string().startsWith("/"),
      /** Lucide icon name, kebab-case (e.g. "map-pin"). */
      icon: z.string().optional(),
      /** Presentation-override key, when the module's rename should follow an
       *  entity kind rather than the module name. */
      overrideKey: z.string().optional(),
      /** A ROW in the navigation, beside the workspace's collections. Only for
       *  a page people go to as a place (Locations, the Scan Inbox). Everything
       *  else declared here is search-only: routable, listed in the feature
       *  index, reached from inside records, never a row. A fresh workspace's
       *  nav is Home, its collections, and the primary doors; nothing else
       *  (docs/design-decisions/nav-collapse.md). */
      primary: z.boolean().optional(),
      /** A LIVE NUMBER on the row: how much is waiting behind this door. The
       *  host polls `GET /orgs/:slug/modules/<name><path>` and shows the
       *  integer at `field` as a pill beside the label, on every nav surface;
       *  zero shows nothing. Declare it only for a queue a person works down
       *  (the scan inbox's pending captures), never for a size (a collection's
       *  row count is not a call to action). Keep the endpoint a single cheap
       *  count, since every open tab asks it every few seconds. */
      count: z
        .object({
          path: z.string().startsWith("/"),
          field: z.string().min(1),
        })
        .optional(),
    })
    .optional(),

  // Whether a workspace can install this module multiple times under
  // different "instance" names. "multi" modules add an `instance`
  // column to their tables (via a migration) and gain instance-
  // scoped routes at /orgs/:slug/instances/<name>/items. "single"
  // modules (default) install once per workspace; their default
  // instance name is implicitly the module name. Foundational
  // modules are always 'single' regardless of declaration.
  // See docs/architecture/instances.md.
  instanceability: z.enum(["single", "multi"]).default("single"),

  // Modules this module OPERATES ON — an opt-in operator/capability
  // (digifab sends files to machines' managers; labels prints labels for
  // inventory/assets/machines) rather than a kind of thing you track.
  // A non-empty list means "not a trackable kind": the new-workspace
  // funnel's "Track a kind of thing" column excludes it and offers it as
  // a capability instead. Promotes the funnel's interim OPERATES_ON UI
  // map to declared manifest data — option (a)→(c) in
  // docs/design-decisions/what-to-do-funnel.md.
  operatesOn: z.array(z.string()).default([]),

  // Which side of a grown sidebar this module's row sits on: a COLLECTION is
  // a place a person keeps things (Inventory, Purchases, the pantry); a TOOL
  // is a place they go to do something (Labels, Lists, Digital Fabrication).
  // Absent, the host derives it: a primary door and an operator (`operatesOn`
  // non-empty) read as tools, everything else as a collection. Declare it when
  // the derivation reads wrong: Purchases operates on inventory and is still a
  // collection of orders; Lists operate on nothing and are still a tool.
  // docs/design-decisions/nav-collapse.md ("The growing middle").
  navKind: z.enum(["collection", "tool"]).optional(),

  // Optional icon-only quick-action pinned to the navbar's RIGHT
  // cluster — a module's single most-used action that earns prime,
  // always-visible placement (e.g. core-scan's camera button, which
  // power users hit constantly). Rendered only while the module
  // is enabled. Distinct from `ui.navItems` (the left-nav text links):
  // this is the one critical icon, not a page entry.
  headerAction: z
    .object({
      /** Kebab-case lucide icon name, e.g. "scan-line" / "camera". */
      icon: z.string().min(1),
      /** Tooltip + aria-label (icon-only, so this is the only text). */
      label: z.string().min(1),
      /** Web route to navigate to on click. */
      route: z.string().min(1),
    })
    .optional(),

  // Optional. Pillar-E specialisation modules (3d-printers,
  // workshop-mods, etc.) often have NO tables of their own — they
  // only contribute field-defs/wires to entity kinds owned by a
  // depended-on base module. Such modules omit `schema` entirely.
  schema: z
    .object({
      tablePrefix: z.string().regex(/^[a-z][a-z0-9_]*_$/, "tablePrefix must end with _"),
      migrationsDir: z.string().min(1),
    })
    .optional(),

  // The api/ui imports are functions returning a dynamic import so
  // the loader can decide when to evaluate them (and so modules can
  // be lazily code-split in the web bundle).
  api: z.function().returns(z.promise(z.unknown())).optional(),
  ui: z
    .object({
      navItems: z.array(NavItem).default([]),
      components: z.function().returns(z.promise(z.unknown())).optional(),
    })
    .optional(),

  /** @deprecated Retired: nothing ever handled an intent; the assistant works
   *  through record tools and `exposes.actions`. Accepted so an old
   *  third-party manifest loads; lint:manifest-advertises-what-it-has refuses
   *  one in a first-party manifest. */
  intents: z.array(Intent).default([]),
  dependencies: z.array(z.string()).default([]),
  // Grantable permissions this module checks that are not actions (see
  // ModuleCapability).
  capabilities: z.array(ModuleCapability).default([]),
  exposes: z
    .object({
      events: z.array(z.string()).default([]),
      // What each event carries: the payload keys every emit of it sends.
      // An action that reads from an event (readsFromEvent) can only be
      // wired to an event that declares the keys it reads.
      eventPayloads: z.record(z.array(z.string().min(1))).default({}),
      /** @deprecated Retired: nothing ever resolved these names. A module
       *  reaches another through platform().entities, an action or an event. */
      api: z.array(z.string()).default([]),
      actions: z.array(EntityAction).default([]),
      // Sentences this module's users would type, and what to do about them.
      // Available with no AI connected at all. See ModuleCommand.
      commands: z.array(ModuleCommand).default([]),
      // Live controls — ongoing session modes surfaced in the Live box.
      live: z.array(LiveControl).default([]),
      // The KINDS of workspace notification this module sends (the eventType
      // it dispatches with, and a name a person would recognise), so the
      // workspace can say who each kind is for. A kind not declared here is
      // still delivered; it just cannot be pointed at fewer people than
      // everyone until it is.
      notifications: z.array(NotificationKind).default([]),
    })
    .default({ events: [], eventPayloads: {}, api: [], actions: [], commands: [], live: [], notifications: [] }),
  // Pillar A — entity kinds the module provides for the rest of
  // the platform to introspect.
  provides: z
    .object({
      entityKinds: z.array(EntityKind).default([]),
    })
    .default({ entityKinds: [] }),
  // Pillar E — module composition. A module can declare field-defs
  // and wires that target entity kinds owned by OTHER (depended-on)
  // modules. When this module is enabled for an org, the platform
  // applies these contributions to module_field_defs /
  // entity_action_bindings with source_module set to the module's
  // name. Disabling the module cleans them up.
  contributes: z
    .object({
      fieldDefs: z
        .array(
          z.object({
            entity_kind: z.string(),
            name: z.string().regex(/^[a-z][a-z0-9_]*$/),
            display_label: z.string().min(1),
            type: FieldTypeSchema,
            /** For type='relation': the entity-kind id this field references
             *  (e.g. "core-locations:location"). The stored value is the target
             *  entity's id (in metadata); the read layer resolves it to the
             *  target's title and injects `<name>_label` for display. */
            ref_kind: z.string().optional(),
            required: z.boolean().optional(),
            position: z.number().int().optional(),
            choices: z.array(z.string()).optional(),
            /** Whether what a person types becomes a choice
             *  (@cobblr/platform-contract/field-choices). */
            learns: z.boolean().optional(),
            /** How it adds up in a group's summary
             *  (@cobblr/platform-contract/field-aggregate). */
            aggregate: FieldAggregateSchema.optional(),
            /** Built-in renderer id — color-hex / image-url / url-link / year /
             *  boolean / code / markdown / qr / text. The web UI switches on
             *  this when drawing the value. */
            renderer: z
              .enum(["text", "color-hex", "image-url", "url-link", "year", "boolean", "code", "markdown", "qr"])
              .optional(),
            /** Server-managed: the value is computed/stamped server-side
             *  (e.g. core-mobility's `away_since`) and a client write is
             *  never accepted — the write router preserves the stored
             *  value across an unrelated edit rather than taking the
             *  client's. Server-side writers (wire action handlers)
             *  bypass the router and write it directly. Default false. */
            server_managed: z.boolean().optional(),
            /** What the field MEANS (see FIELD_ROLE_VALUES): an assets
             *  `assigned_to` person field is the `assignee`, so the platform
             *  knows the thing gets lent without learning the field's name. */
            field_role: FieldRoleSchema.optional(),
          }),
        )
        .default([]),
      // Pillar E (UI) — panels this module contributes INTO another
      // module's web surfaces: a page-level tab on the target module's
      // list page, or a panel inside the target kind's detail modal.
      // The web renders contributions through its panel registry
      // (web/src/panels/registry.tsx) — a host page renders whatever
      // enabled modules contribute, never naming a contributor. A
      // contribution is honored ONLY when the target's module is in
      // this module's `operatesOn` (validated below): operatesOn is
      // the declared capability that grants UI presence. See
      // docs/design-decisions/machines-digifab-unification.md §5.
      panels: z
        .array(
          z.object({
            /** Registry id, `<module>:<panel>` (e.g. "digifab:fleet-tab") —
             *  must have a component registered web-side. */
            id: z.string().regex(/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/),
            surface: z.enum(["module-page-tab", "entity-detail-panel", "configuration-section"]),
            /** Target module ("machines") for a page tab, entity kind
             *  ("machines:machine") for a detail panel, or a Configuration
             *  page (one of CONFIGURATION_SECTION_HOSTS) for a section. */
            target: z.string().min(1),
            /** The tab/panel label the host renders. */
            title: z.string().min(1),
            /** Same predicate an action carries, matched against the traits
             *  the collection wears ("Price history" is `traits: ["fungible"]`
             *  and says nothing on a catalog). Absent, `target` alone decides. */
            appliesTo: ActionAppliesTo.optional(),
            /** The face this panel belongs to, for disclosure (see the same
             *  field on an action). */
            face: FaceSchema.optional(),
            placement: z.enum(["summary", "details"]).optional(),
          }),
        )
        .default([]),
      wires: z
        .array(
          z.object({
            source_kind: z.string(),
            action_id: z.string(),
            trigger_type: z
              .enum(["user-invoked", "event", "on-create", "on-update", "on-delete"])
              .default("user-invoked"),
            trigger_event: z.string().optional(),
            template: z.string().optional(),
            // Q1 wire target. Omit (or "self") → action runs on the
            // source entity (default). Object form opts into cross-
            // module pairing traversal: action runs on each entity
            // discovered by walking entity_pairings from the source.
            // `dir` defaults to "in" (incoming — find things that
            // point AT the source via this relation). `kind` filters
            // the discovered target kind when one source pairs with
            // multiple kinds via the same relation.
            // See docs/architecture/wires-and-bundles.md (Q1).
            target: WireTarget.optional(),
          }),
        )
        .default([]),
    })
    .default({ fieldDefs: [], panels: [], wires: [] }),
  subscribes: z.array(z.string()).default([]),

  // Lifecycle hooks — let a module register background work the
  // platform can't otherwise see. Both are dynamic imports (same
  // pattern as `api`/`ui.components`) so the loader controls when
  // they're evaluated.
  //
  // onBoot: runs after every module is mounted, immediately before
  //   app.listen. Awaited; a thrown error is logged + skipped (the
  //   process keeps booting — a stuck onBoot can't take down the
  //   whole platform). Use for: starting a scheduler, registering
  //   background subscribers, warming a cache.
  // onShutdown: runs on SIGINT/SIGTERM before server.close. Awaited
  //   with a short budget. Use for: stopping intervals, flushing
  //   in-flight work.
  //
  // Both are `() => Promise<unknown>` so the module's import lives
  // in its own bundle — no transitive load of every module's
  // implementation just to read the manifest.
  lifecycle: z
    .object({
      onBoot: z.function().returns(z.promise(z.unknown())).optional(),
      onShutdown: z.function().returns(z.promise(z.unknown())).optional(),
    })
    .optional(),
}).superRefine((m, ctx) => {
  // A declared capability is this module's own: its id carries the module's
  // name, and it is not one of the module's actions under a second label
  // (grantableActions lists the action first and would drop this one's words
  // without a sound).
  const actionIds = new Set(m.exposes.actions.map((a) => a.id));
  m.capabilities.forEach((c, i) => {
    if (!c.id.startsWith(`${m.name}:`)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capabilities", i, "id"],
        message: `capability "${c.id}" must start with this module's name, "${m.name}:"`,
      });
    }
    if (actionIds.has(c.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capabilities", i, "id"],
        message: `capability "${c.id}" is already one of this module's actions; an action is grantable as it is, so declare it once`,
      });
    }
  });
  // The panel gate: contributing UI into another module's surfaces
  // requires DECLARING you operate on it. Keeps `operatesOn` honest
  // (it stops being decorative) and makes drive-by UI injection a
  // manifest-validation failure, not a review argument.
  for (const p of m.contributes.panels) {
    // A section on a Configuration page: the page is the kernel's, not a
    // module's, so there is no module to operate on. It is gated instead by
    // the page naming itself a host, and by the page's own role.
    if (p.surface === "configuration-section") {
      if (!(CONFIGURATION_SECTION_HOSTS as readonly string[]).includes(p.target)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["contributes", "panels"],
          message: `panel "${p.id}" is a configuration section for "${p.target}", which is not a page that hosts sections (${CONFIGURATION_SECTION_HOSTS.join(", ")})`,
        });
      }
      continue;
    }
    // `*` — a panel on EVERY entity detail view. Some side-cars are not about
    // one module's entities at all: a conversation, a tag. Enumerating every
    // kind that should have one is a list that is wrong the day a module ships,
    // and getting it wrong is silent (the panel simply never appears).
    //
    // It is NOT a hole in the gate above. `operatesOn` exists to stop drive-by
    // UI injection, and a universal panel is the largest injection there is, so
    // it is limited to modules that are ALWAYS ON: a workspace cannot turn
    // these off, so there is no surprise to spring on it. A stock module that
    // the user chose to enable, or a marketplace one, still has to name what it
    // operates on.
    if (p.target === "*") {
      if (m.band !== "foundational" && !m.autoEnable) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["contributes", "panels"],
          message: `panel "${p.id}" targets every kind ("*"), which only an always-on module may do — "${m.name}" is neither band "foundational" nor autoEnable`,
        });
      }
      continue;
    }
    const targetModule = p.target.includes(":") ? p.target.split(":")[0]! : p.target;
    if (!m.operatesOn.includes(targetModule)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contributes", "panels"],
        message: `panel "${p.id}" targets "${p.target}" but "${targetModule}" is not in operatesOn — a module may only contribute panels into modules it declares it operates on`,
      });
    }
  }
});

export type ModuleManifest = z.infer<typeof ModuleManifest>;
export type ModuleIntent = z.infer<typeof Intent>;
export type EntityKindDecl = z.infer<typeof EntityKind>;
export type EntityFieldDecl = z.infer<typeof EntityField>;
export type EntityActionDecl = z.infer<typeof EntityAction>;
export type LiveControlDecl = z.infer<typeof LiveControl>;
export type ActionAppliesToDecl = z.infer<typeof ActionAppliesTo>;

/**
 * FIELD SCOPES — the closed vocabulary for a field def that applies to a CLASS
 * of entity kinds instead of exactly one ("Origin: where I got this", on every
 * physical thing the workspace tracks — parts, assets, machines, places).
 *
 * A scope is just an `appliesTo` predicate over an entity kind, which is
 * precisely what an action's `appliesTo` already is — so a scoped field is
 * matched by the SAME matcher (matchAction), not a second one. The key is a
 * SENTINEL parked in `module_field_defs.entity_kind` (which stays NOT NULL), and
 * it starts with `@` so it can never collide with a real kind id (`module:kind`).
 *
 * Scoped on TRAITS, never on names or a use case: a kind is in-scope because it
 * declared `tangibility: physical`, not because someone listed it. New physical
 * kinds (a module installed next month, a bundle's instance) inherit the field
 * with no migration — that's the whole point.
 *
 * A kind with NO declared traits matches no trait scope. That's deliberate: it
 * keeps workspace-wide fields off untyped internal plumbing kinds by default.
 *
 * See docs/design-decisions/trait-scoped-fields.md.
 */
/** One-click shortcuts INTO the trait vocabulary — not a replacement for it. Any
 *  combination of the 12 traits is a valid scope; these are just the ones worth a
 *  chip. (The first version of this shipped only two canned scopes, which quietly
 *  told users the other four axes didn't exist.) */
export const FIELD_SCOPE_PRESETS: Array<{
  key: string;
  label: string;
  hint: string;
  traits: TraitName[];
}> = [
  {
    key: "physical",
    label: "All physical items",
    hint: "Anything you can hold, store, or point at: parts, assets, machines, places.",
    traits: ["physical"],
  },
  {
    key: "digital",
    label: "All digital items",
    hint: "Things with no physical body: records, documents, entries.",
    traits: ["digital"],
  },
  {
    key: "physical-unique",
    label: "Things tracked one by one",
    hint: "Physical AND individually identified: an asset, a machine, a vehicle. Excludes bulk stock.",
    traits: ["physical", "unique"],
  },
  {
    key: "physical-fungible",
    label: "Countable stock",
    hint: "Physical AND interchangeable: tracked by quantity, not by which specific one.",
    traits: ["physical", "fungible"],
  },
];

/** The canonical sentinel for a trait scope: `@` + the traits, sorted, joined by
 *  `+`. Parked in `module_field_defs.entity_kind` (which is NOT NULL), where it
 *  keeps `unique (org_id, entity_kind, name)` meaningful — one "origin" per scope
 *  per org — and can never collide with a real kind id (`module:kind`).
 *  Deterministic, so the same scope always lands on the same row. */
export function fieldScopeSentinel(traits: readonly string[]): string {
  return `@${[...traits].sort().join("+")}`;
}

/** Plain-language gloss per platform PROFILE. The profile names are the authoring
 *  vocabulary (a module declares `profile: "owned-thing"`); these say what that
 *  means to someone who has never read the traits doc. */
const PROFILE_HINTS: Record<string, string> = {
  "owned-thing": "A specific thing you own and track one by one — an asset, a machine, a vehicle.",
  "stock-material": "Bulk stock you count rather than name — parts, filament, screws.",
  place: "Somewhere things live — a room, a shelf, a bin.",
  "digital-record": "A record with no physical body — a tag, a file, an entry.",
  "catalog-record": "A lean catalog entry you keep one per title — a film, a book, a board game.",
  "work-item": "Something with a date that can be finished — a task, a job, an order.",
  "vendor-order": "An order placed with someone: it has a date and a done state.",
  "recurring-schedule": "Scheduled, but never finishes — a recurring routine.",
  "one-shot-completable": "A one-off you finish, with no schedule attached.",
  "auto-pruning-record": "A short-lived record that ages out on its own.",
};

/**
 * The platform PROFILES, as field scopes — the other way to say "a class of
 * things". A profile is a full 6-axis fingerprint (what a module declares its kind
 * AS: `profile: "owned-thing"`), so as a scope it means "every kind shaped like
 * this": owned-thing catches assets, machines and vehicles, but not parts (those
 * are fungible) and not locations (those are containers).
 *
 * DERIVED from TRAIT_PRESETS rather than re-listed, so a new platform profile
 * appears here for free and the two can't drift apart.
 *
 * DEDUPED BY FINGERPRINT, because some profiles are trait-identical: `work-item`
 * and `vendor-order` are the same six traits, so as PREDICATES they are the same
 * scope. Two chips would both light up when either was picked and read as a bug;
 * one chip named for both tells the truth — scope to either and you get both.
 */
export function fieldScopeProfiles(): Array<{
  key: string;
  label: string;
  hint: string;
  traits: TraitName[];
}> {
  const byFingerprint = new Map<string, { names: string[]; traits: TraitName[] }>();
  for (const [name, preset] of Object.entries(TRAIT_PRESETS)) {
    // A skipped axis (null) contributes nothing: the profile is silent about it,
    // so a scope built from it has to be silent too.
    const traits = Object.values(preset).filter(
      (v): v is TraitName => typeof v === "string" && v in AXIS_OF_TRAIT,
    );
    if (!traits.length) continue;
    const key = fieldScopeSentinel(traits);
    const hit = byFingerprint.get(key);
    if (hit) hit.names.push(name);
    else byFingerprint.set(key, { names: [name], traits });
  }
  return [...byFingerprint.entries()].map(([key, { names, traits }]) => ({
    key,
    label: names.join(" / "),
    hint:
      names.length === 1
        ? (PROFILE_HINTS[names[0]!] ?? "")
        : `${PROFILE_HINTS[names[0]!] ?? ""} ${names.slice(1).join(", ")} has the same six traits, so this scope covers both.`,
    traits,
  }));
}

/** The traits encoded in a sentinel, or [] if it isn't one. The sentinel is
 *  self-describing on purpose — a human reading the DB can see the scope. */
export function parseFieldScope(entityKind: string): TraitName[] {
  if (!entityKind.startsWith("@")) return [];
  return entityKind
    .slice(1)
    .split("+")
    .filter((t): t is TraitName => t in AXIS_OF_TRAIT);
}

/** True when a field def's `entity_kind` is a scope sentinel rather than a real
 *  entity kind. Total and cheap — real kind ids never start with `@`. */
export function isFieldScope(entityKind: string): boolean {
  return entityKind.startsWith("@");
}

/** Human name for a scope: the preset's label when it is one, else the trait
 *  words. The UI must never render a raw `@physical+unique` at a user. */
export function fieldScopeLabel(traits: readonly string[]): string {
  const key = fieldScopeSentinel(traits);
  const preset = FIELD_SCOPE_PRESETS.find((p) => fieldScopeSentinel(p.traits) === key);
  if (preset) return preset.label;
  if (traits.length === 0) return "Nothing";
  return `${[...traits].sort().join(" + ")} things`;
}

/**
 * Builder for a module's default export. Validates the manifest at
 * load time — invalid shape throws with a readable message before
 * the module is registered. Returns the validated manifest, typed.
 *
 * Usage in a module:
 *   export default defineModule({ name: "inventory", ... });
 */
export function defineModule(manifest: z.input<typeof ModuleManifest>): ModuleManifest {
  const result = ModuleManifest.safeParse(manifest);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid module manifest for "${
        (manifest as { name?: unknown }).name ?? "<unnamed>"
      }":\n${issues}`,
    );
  }

  // Resolve preset + overrides into the canonical raw form, so
  // downstream code (registry sync, action matching, UI rendering)
  // can always read `traits` directly. `profile` and `overrides` are
  // preserved on the entry for introspection / tooling.
  const resolved = result.data;
  const aliases = resolved.aliases ?? [];
  if (aliases.includes(resolved.name) || new Set(aliases).size !== aliases.length) {
    throw new Error(`Invalid module aliases for "${resolved.name}": aliases must be unique and differ from name`);
  }
  if (resolved.retirement && (resolved.maturity === "hidden" || resolved.maturity === "experimental")) {
    throw new Error(`Retired module "${resolved.name}" must load on every deployment: use beta or stable maturity`);
  }
  if (resolved.retirement && resolved.band === "foundational") {
    throw new Error(`Cannot retire foundational module "${resolved.name}"`);
  }
  if (resolved.retirement?.replacement && [resolved.name, ...aliases].includes(resolved.retirement.replacement)) {
    throw new Error(`Module "${resolved.name}" cannot replace itself`);
  }

  for (const kind of resolved.provides.entityKinds) {
    if (kind.profile) {
      const base = TRAIT_PRESETS[kind.profile];
      kind.traits = { ...base, ...(kind.overrides ?? {}) };
    }
  }

  return resolved;
}

/** Resolve preset+overrides into the 6-tuple. Exposed for tooling
 *  (CLI, debug endpoints) that needs the same expansion logic as
 *  defineModule() outside the module-loading path. */
export function resolveTraits(decl: {
  traits?: RawTraitsDecl;
  profile?: PresetName;
  overrides?: RawTraitsDecl;
}): RawTraitsDecl | undefined {
  if (decl.traits) return decl.traits;
  if (decl.profile) {
    const base = TRAIT_PRESETS[decl.profile];
    return { ...base, ...(decl.overrides ?? {}) };
  }
  return undefined;
}

/** Read one trait-axis value off a resolved traits map, tolerating both the
 *  plain string form and the `{ trait, uncertain }` inference form the
 *  entity-kind registry can carry. Exported so every trait consumer (kind
 *  synthesis, scan confirm, disclosure) reads an axis one way instead of
 *  growing private near-copies. */
export function traitAxisValue(
  traits: Record<string, unknown> | null | undefined,
  axis: string,
): string | null {
  const v = traits?.[axis];
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "object" && "trait" in (v as Record<string, unknown>)) {
    const t = (v as { trait?: unknown }).trait;
    return typeof t === "string" ? t : null;
  }
  return null;
}

/** Placement capability (see placement-and-containment.md): can a kind hold
 *  other things inside it? Containment is a PHYSICAL relationship — any physical
 *  thing can be a container (a server holds a PSU; a rack holds a server; a
 *  drawer holds tools). Digital records / work-items cannot. This is the
 *  `canContain` capability from the spec, derived from traits rather than a new
 *  schema field, so it composes with the existing container/containable axis
 *  (which stays for backward-compatible action matching). */
export function canContain(traits: Record<string, unknown> | null | undefined): boolean {
  return traitAxisValue(traits, "tangibility") === "physical";
}

/** Can a kind be placed inside a container? Anything carrying a containment
 *  trait (containable OR container — both are physical); digital records (no
 *  containment axis) cannot. */
export function canBeContained(traits: Record<string, unknown> | null | undefined): boolean {
  return traitAxisValue(traits, "containment") != null;
}

// ──────────────────────── Platform runtime ────────────────────────
//
// Modules don't import from the api workspace directly — that'd
// couple them to the platform implementation. Instead, the api
// registers an implementation of the Platform interface at boot
// via setPlatform(), and modules read it via platform().
//
// Surface starts small (activity + events). It will grow as
// connectors hit real needs.

export interface ActivityRef {
  /** Module name, or `null` for platform-level events. */
  module: string | null;
  entityType: string;
  entityId: string;
}

export interface ActivityLogParams {
  orgId: string;
  userId: string | null;
  action: string;
  ref: ActivityRef;
  diff?: unknown;
  /** The record as it was before this write. Given with a patch `diff`, the
   *  log works out what really changed, old → new, custom fields included
   *  (`changes`, activity-changes.ts). Every `*_updated` write passes it
   *  (lint:history-knows-what-changed). */
  before?: unknown;
  /** HOW the write was made, when the caller knows better than the request
   *  context: a sync names itself ("automation", "<connection> sync"), so a
   *  record it creates is not a row with no actor (#3836). */
  via?: { kind: ActivityViaKind; label?: string | null } | null;
}

/** HOW a write was made, beside who made it. The one list: the api's request
 *  context and every module read it from here. `surface` is a place in the
 *  app that is not a record's own page (a floor plan, a shelf drawing), its
 *  label the words the activity shows ("via floor plan"). */
/** `share`: a friend's edit, made in a share space and applied here (its
 *  label is their name). */
export type ActivityViaKind = "mcp" | "assistant" | "automation" | "label" | "surface" | "share";

export class RecordRestoreRefused extends Error {
  status: number;
  constructor(message: string, status = 409) { super(message); this.status = status; }
}

export interface DeletionSnapshot {
  image: Record<string, unknown>;
  related?: unknown;
}

export interface DeletionParticipant {
  snapshot(orgId: string, ref: EntityRef, snapshot?: DeletionSnapshot): Promise<unknown>;
  restore(orgId: string, ref: EntityRef, image: unknown): Promise<void>;
  purge?(orgId: string, ref: EntityRef, image: unknown): Promise<void>;
}

export interface DeletedRecordImage {
  id: string;
  image: Record<string, unknown>;
  details: unknown;
  deletedBy: string | null;
  deletedAt: Date;
}

export interface PlatformDeletedRecords {
  exclusive<T>(orgId: string, kind: string, id: string, work: () => Promise<T>): Promise<T>;
  capture<T>(orgId: string, kind: string, id: string, work: () => Promise<T>): Promise<T>;
  keep(orgId: string, kind: string, id: string, image: Record<string, unknown>, details?: unknown, deletedBy?: string | null, deletedAt?: Date): Promise<string>;
  get(orgId: string, kind: string, id: string): Promise<DeletedRecordImage | null>;
  forget(orgId: string, kind: string, id: string): Promise<void>;
  restore(orgId: string, kind: string, id: string, deletionId?: string): Promise<boolean>;
  registerParticipant(name: string, participant: DeletionParticipant): void;
  registerLifecycle(kind: string, lifecycle: { restore(orgId: string, id: string): Promise<void>; purge(orgId: string, id: string): Promise<boolean> }): void;
}

/** The one door for a thing that is no longer the person's (sold, given away,
 *  gone) and the way back. A module reaches it here so its batches land the
 *  same way the record's own Mark gone does. */
export interface PlatformDispositions {
  /** All or nothing: refuses before writing when the kind cannot retire or a
   *  record is missing. `quiet` leaves out the per-record activity line, for a
   *  caller that writes one line for the whole batch. */
  markGone(
    orgId: string,
    userId: string | null,
    kind: string,
    ids: readonly string[],
    details: { how: Disposition; on?: string | null; price?: number | null; to?: string | null; note?: string | null },
    opts?: { quiet?: boolean },
  ): Promise<{ ok: true; done: Array<{ id: string; title: string }> } | { ok: false; error: string }>;
  bringBack(
    orgId: string,
    userId: string | null,
    kind: string,
    ids: readonly string[],
    opts?: { quiet?: boolean },
  ): Promise<{ ok: true; done: Array<{ id: string; title: string }> } | { ok: false; error: string }>;
}

export interface HistoryWriter {
  /** The owning module's row table, for predicates applied before paging. */
  table?: string;
  snapshotDeletion?(orgId: string, id: string): Promise<DeletionSnapshot | null>;
  restoreDeletion?(orgId: string, snapshot: DeletionSnapshot): Promise<void>;
  snapshot(orgId: string, id: string): Promise<Record<string, unknown> | null>;
  restore(orgId: string, image: Record<string, unknown>): Promise<void>;
}

export interface PlatformActivity {
  registerHistoryWriter(kind: string, writer: HistoryWriter): void;
  log(p: ActivityLogParams): Promise<void>;
}

export type EventHandler = (payload: unknown) => void | Promise<void>;

export interface PlatformEvents {
  /** Emit an event. Returns a Promise that resolves once every direct
   *  subscriber registered via on() has run, in order, and then any
   *  wires (user-configured entity_action_bindings) for the event have
   *  finished firing. A caller can:
   *    • `await emit(...)` — read-after-write for subscribers AND
   *      wires; the response goes out after both have applied. Do this
   *      when anything after you depends on what a handler does: a
   *      ledger row an undo will void, a count a page will refetch.
   *    • `emit(...)` (no await) — fire-and-forget; both still run, the
   *      caller just doesn't wait. For notifications only.
   *  Never rejects: a handler that throws is logged and the rest run. */
  emit(eventName: string, payload: unknown): Promise<void>;
  /** Subscribe a handler to an event. The module name is captured
   *  for diagnostics — failures get logged with which module's
   *  handler threw. Handlers run inline when the event is emitted, so
   *  an awaiting emitter sees their effect; a handler whose work is slow
   *  (a network call, a render) schedules that work itself with
   *  setImmediate and returns, so the emitter is not made to wait. */
  on(eventName: string, module: string, handler: EventHandler): void;
}

/** Tenant-DB accessor for background work that doesn't have a
 *  request context (event handlers, scheduled jobs, etc.). The
 *  returned value is a Kysely instance — typed loosely here so the
 *  platform-contract doesn't need to know about every module's
 *  schema. Callers cast to their own schema type. */
/** What a module may know about a workspace without touching cobblr_meta
 *  itself. Added for the hosted identify scope: the allowance had to answer
 *  "is this workspace the yarn app?" and a module has no other way to ask. */
export interface PlatformOrgInfo {
  id: string;
  slug: string;
  accent?: string | null;
  /** The managed app this workspace is locked into, or null for a platform
   *  workspace. Mirrors `orgs.app_mode`. */
  app_mode: { app: string; home_path: string; label?: string } | null;
}
export interface PlatformOrgs {
  get(orgId: string): Promise<PlatformOrgInfo | null>;
}

export interface PlatformTenants {
  getDb(orgId: string): Promise<unknown>;
  /** Release this tenant's connection pool — but ONLY if it currently has
   *  no checked-out clients (all connections idle, none waiting). The pool
   *  reopens lazily on the next `getDb`. No-op if the org has no cached pool.
   *
   *  For background jobs that sweep EVERY tenant on a tick (due-soon,
   *  recurrence, expiry): without this, each org's pool stays cached open
   *  with a live connection, so one tick holds one pool per tenant and a
   *  box with many tenants exhausts Postgres `max_connections` ("remaining
   *  connection slots are reserved for SUPERUSER"). Call it after finishing
   *  each org to keep the sweep's peak at ~one tenant pool. The idle guard
   *  makes it safe against concurrent request traffic — a pool a live
   *  request is mid-flight on is left untouched. */
  releaseIdleDb(orgId: string): Promise<void>;
  /** PREFER THIS for cross-tenant sweeps: runs `fn` with the tenant db, then
   *  releases the pool — immediately when nothing else touched it during the
   *  sweep (the common case), else once it has been quiet for the grace
   *  window. A bare getDb + releaseIdleDb pair could never release its own
   *  pool inside the grace window, so a sweep across N tenants held N pools
   *  and exhausted Postgres (staging, 2026-08-07). */
  withDb<T>(orgId: string, fn: (db: unknown) => Promise<T>): Promise<T>;
}

/** Cross-tenant DB access for the (small set of) modules that need
 *  to read or write platform-level tables (entity_action_bindings,
 *  wire_schedule_state, org_modules, etc.). Typed as `unknown` — the
 *  caller casts to a Kysely<schema> using a narrow structural type
 *  for just the tables it touches, same way `PlatformTenants.getDb`
 *  works for tenant DBs.
 *
 *  Modules touching this are limited: scheduler-style ("which wires
 *  fire when?"), platform observability ("what's enabled across all
 *  orgs?"). Day-to-day module work should stay on tenant DBs. */
export interface PlatformDb {
  meta: unknown;
  /** THE partial write to a record's jsonb bag (#3625): an expression to
   *  hand to an UPDATE's `.set({ [column]: … })` that sets the non-null keys
   *  and removes the null ones against the LIVE row, in one statement
   *  (@cobblr/platform-contract/jsonb-merge). Never read the bag, change it
   *  in JS and write it back: a concurrent edit in between is lost. */
  mergeJsonb(column: string, fields: Record<string, unknown>): unknown;
  /** A row's version, to select (`… as row_version`): Postgres's xmin, which
   *  every write to the row changes, by any path. With `atVersion` it makes a
   *  compare-and-set: read the version, decide, write only if it is the same. */
  rowVersion(): unknown;
  /** A WHERE condition: the row is still at this version. */
  atVersion(version: string): unknown;
}

// ──────────────── Pillar A runtime — entities ──────────────────────

/** Generic entity data returned to other modules. Module-private
 *  columns aren't here — only fields declared on the kind's manifest
 *  with role: 'title' / 'subtitle' / etc., plus the raw field map.
 *  Callers should rely on roles to render generically. */
export interface ResolvedEntity {
  kind: string;
  id: string;
  /** The named collection this record lives in, when its module keeps
   *  several ("groceries" for an inventory:part filed as a grocery); absent or
   *  null in the module's own default one. Lets a surface name the record by
   *  its collection instead of its kind (a jar of Nutella read "Part" in the
   *  pantry, #4146) and route to its instance page. */
  instance?: string | null;
  title: string;
  subtitle?: string;
  image_path?: string;
  detailUrl?: string;
  /** All declared fields, key → value. Numbers come back as numbers,
   *  strings as strings — modules cast as needed. */
  fields: Record<string, unknown>;
  /**
   * The user has put this out of use: archived, retired, decommissioned —
   * whatever the owning module calls it. It still exists and still resolves,
   * because its history is worth keeping; what it must not do is generate work.
   *
   * This exists because "stop bothering me about this" had no cross-module
   * expression. A sweeper that wants to skip retired records could only find
   * out by reaching into the owning module's table, which module isolation
   * forbids — so core-cadence kept putting archived groceries on the shopping
   * list, ignoring the one explicit instruction the user had given it.
   *
   * Absent means not retired. A module with no such concept just omits it.
   */
  retired?: boolean;
  /** A titled work's other forms (the original, a translation, a
   *  transliteration), when the record carries them in its metadata. The
   *  kernel composes `title` from these for the request's actor (their
   *  title preference) on the way out, so a surface reads `title` as
   *  served and never formats; the forms ride beside it for anything that
   *  needs to say where a title came from (#3061). */
  title_variants?: TitleVariants;
  /** On a search result that matched inside the record's words rather than
   *  its name (a pattern's PDF, its notes): the line the searched word is on,
   *  so a surface can say why the record is here. Absent on a name match and
   *  outside a search. */
  snippet?: string;
}

/** Module-side resolver for an entity kind. Registered at module
 *  boot. The platform calls these in-process; no HTTP loopback. */
export type EntityResolver = (
  orgId: string,
  id: string,
) => Promise<ResolvedEntity | null>;

/** Comparison-operator predicate for the `where` field of
 *  EntityListQuery. Supports literal comparisons, column-to-column
 *  comparisons (`{ ref_col }`), and the `'now'` sentinel for date
 *  columns (resolver substitutes `now()`).
 *
 *  Examples (workshop demos):
 *    { col: 'qty', op: '<', ref_col: 'min_qty' }   // low-stock
 *    { col: 'due_date', op: '<=', value: 'now' }    // overdue tasks
 *    { col: 'created_at', op: '>=', value: '2026-01-01' }
 *
 *  Resolvers ignore predicates they don't understand (unknown col,
 *  unsupported op for that column's type) so a config that's too
 *  aggressive degrades to "no extra filter" rather than 500ing. */
export interface FilterPredicate {
  col: string;
  op: "<" | "<=" | ">" | ">=" | "=" | "!=" | "empty" | "not_empty";
  /** Literal value. Use the string `'now'` for current timestamp on
   *  date/timestamptz columns, and `'today'` for the READER's calendar day
   *  against a date field (`EntityListQuery.today`): "ready to drink" is
   *  `drink_from <= today AND drink_by >= today` on the day the person is
   *  living in, never the server's UTC one. A `YYYY-MM-DD` literal compares
   *  as a day too. Mutually exclusive with `ref_col`. */
  value?: string | number | boolean | null;
  /** Compare against another column on the same row (low-stock-style
   *  qty < min_qty). Mutually exclusive with `value`. */
  ref_col?: string;
}

/** Query passed to a list resolver — generic primitives so the
 *  resolver implementation can decide how to apply them. Modules
 *  may safely ignore filter keys they don't support; core-views
 *  surfaces the supported set to the user via the view config. */
/** Who is reading, for the per-field read scopes. A person's `userId` +
 *  `role`; `publicRead` for an anonymous public page; `system` only through
 *  SYSTEM_VIEWER. */
export interface EntityViewer {
  userId?: string;
  role?: string;
  publicRead?: boolean;
  system?: true;
  /** The person's own assistant reading on their behalf (Cobb, MCP as that
   *  member): it also sees the kind's assistantReadableFields on records of
   *  the person's own workspace. */
  assistant?: boolean;
}

/** The reader for internal logic that must decide from the truth: an undo
 *  asking whether a field still holds values, a matcher, a sweeper, a heal.
 *  It sees every field, gated ones included, so it is never passed by code
 *  that answers a client (lint:system-viewer-stays-internal); each use says
 *  why on a `SYSTEM-READ:` line above it. */
export const SYSTEM_VIEWER: EntityViewer = Object.freeze({ system: true as const });

export interface EntityListQuery {
  group_by?: string | GroupBy[];
  group_subtotals?: boolean;
  group_offset?: number;
  group_limit?: number;
  group_keys?: Array<string | null>;
  /** Kernel-prepared, request-local SQL aggregation plan, never accepted from HTTP. */
  group_plan?: GroupPlan;
  /** Hard cap. Resolvers default to a sensible limit when omitted. */
  limit?: number;
  /** Offset-based pagination. Cursor-based variants can be added
   *  later once a v0.1 view actually needs them. */
  offset?: number;
  /** Field-name → value(s). Resolver decides operator (typically
   *  equality for scalars, IN for arrays). Unknown keys are ignored.
   *  Conventions:
   *    filter._tag = '<name>'  → entities carrying that tag
   *    filter.<other key>      → equality on a native column OR a
   *                              metadata-JSON field if no native
   *                              match (resolver decides) */
  filter?: Record<string, unknown>;
  /** Comparison predicates beyond equality. Each predicate AND'd
   *  together. Resolvers may support a subset of (col, op) pairs;
   *  unsupported ones are ignored. See FilterPredicate for examples. */
  where?: FilterPredicate[];
  /** Free-text — full-text-ish search, scoped to the resolver's
   *  judgement of what's searchable on the kind. */
  q?: string;
  /** Sort spec: array of `field` or `-field` (prefix `-` for desc). */
  sort?: string[];
  /** Also return records the module marks retired (archived, out of use,
   *  a unit kept out of the way). A list, a view and the assistant's list
   *  hide them unless asked, as a module's own list does; SEARCH asks, since
   *  "where is my old drill" is a question about something retired, and a
   *  search that cannot find it lies by omission. The resolver decides what
   *  retired means for its kind; a kind with no such notion ignores this. */
  include_retired?: boolean;
  /** The reader's calendar day (YYYY-MM-DD), what a `'today'` predicate
   *  compares against: the client's day when it said one, else the person's
   *  (accounts.dayFor). Absent, a resolver uses the day that has arrived
   *  everywhere, which is late for somebody rather than early for anybody. */
  today?: string;
}

/** The query a saved view asks for, read off its config the ONE way every
 *  surface must read it. A view's config carries `filter`, `where` and `sort`
 *  in the entity-list dialect; older bundles wrote `sort_by` + `sort_dir`
 *  instead, and the views installed from them still do, so both spellings
 *  are honoured here rather than at each reader. core-views' data route and
 *  the inventory list page both call this: for a long time the first applied
 *  the config and the second applied only group_by and visible_fields, so
 *  the same view sorted through one door and not the other (#2772, #2422). */
export function viewQuery(config: Record<string, unknown> | null | undefined, today = arrivedEverywhereForView(new Date())): Pick<EntityListQuery, "filter" | "where" | "sort"> {
  const cfg = config ?? {};
  const out: Pick<EntityListQuery, "filter" | "where" | "sort"> = {};
  if (cfg.filter && typeof cfg.filter === "object" && !Array.isArray(cfg.filter)) {
    out.filter = cfg.filter as Record<string, unknown>;
  }
  if (Array.isArray(cfg.where)) out.where = (cfg.where as FilterPredicate[]).map(p => {
    const value = p.value;
    if (typeof value !== "string") return p;
    const offset = /^today([+-][0-9]{1,4})?$/.exec(value);
    if (offset) {
      const date = new Date(today + "T12:00:00Z");
      date.setUTCDate(date.getUTCDate() + Number(offset[1] ?? 0));
      return { ...p, value: date.toISOString().slice(0, 10) };
    }
    if (value === "year-start" || value === "next-year-start") return { ...p, value: `${Number(today.slice(0, 4)) + (value === "next-year-start" ? 1 : 0)}-01-01` };
    return p;
  });
  const sort = normalizeSortSpec(cfg.sort);
  if (sort) out.sort = sort;
  else if (typeof cfg.sort_by === "string" && cfg.sort_by.trim()) {
    out.sort = [`${cfg.sort_dir === "desc" ? "-" : ""}${cfg.sort_by.trim()}`];
  }
  return out;
}

/** The sort grammar resolvers speak is the string form, `["name", "-qty"]`.
 *  View configs written by the view editor carry the object form,
 *  `[{ field, dir }]`, and for a while that passed through untouched and made
 *  resolvers return ZERO rows (D16). Both forms normalise here, to strings;
 *  anything unparseable degrades to `undefined` (unsorted), never an empty
 *  array, so a bad sort can never empty a result. */
export function normalizeSortSpec(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const e of raw) {
    if (typeof e === "string") {
      if (e.trim()) out.push(e.trim());
    } else if (e && typeof e === "object") {
      const field = (e as { field?: unknown }).field;
      const dir = (e as { dir?: unknown }).dir;
      if (typeof field === "string" && field.trim()) {
        out.push(dir === "desc" || dir === "-" ? `-${field.trim()}` : field.trim());
      }
    }
  }
  return out.length > 0 ? out : undefined;
}

/** Turn an `EntityListQuery.sort` spec (`["-excitement","name"]`) into an
 *  ordered list of `{ col, dir }` a list resolver can hand straight to its
 *  query builder. A leading `-` means descending; anything else ascending.
 *
 *  Only columns present in `sortable` survive — a resolver passes the set of
 *  columns it can actually order by (native cols it trusts), and unknown or
 *  unsafe fields are dropped rather than interpolated into SQL. Same
 *  degrade-don't-throw contract the `where`/`filter` paths follow: a sort the
 *  resolver can't honor becomes "no extra ordering", never an error. An empty
 *  or all-dropped spec returns `[]`, and the resolver falls back to its own
 *  default order.
 *
 *  Pure and dependency-free so both the api resolvers and the web client
 *  (which sorts already-fetched rows in the same order) share one definition
 *  of the grammar. */
export function parseSort(
  sort: string[] | undefined,
  sortable: ReadonlySet<string>,
): Array<{ col: string; dir: "asc" | "desc" }> {
  if (!sort || sort.length === 0) return [];
  const out: Array<{ col: string; dir: "asc" | "desc" }> = [];
  const seen = new Set<string>();
  for (const raw of sort) {
    if (typeof raw !== "string") continue;
    const token = raw.trim();
    if (!token) continue;
    const dir: "asc" | "desc" = token.startsWith("-") ? "desc" : "asc";
    const col = token.replace(/^-/, "").trim();
    if (!col || seen.has(col) || !sortable.has(col)) continue;
    seen.add(col);
    out.push({ col, dir });
  }
  return out;
}

export interface EntityListResult extends Partial<GroupedResult> {
  items: ResolvedEntity[];
  /** Total matching rows ignoring limit/offset — optional because
   *  count-queries on large tables can be expensive. */
  total?: number;
  /** The `where` predicates the resolver could not run. A predicate it
   *  cannot honour used to be dropped in silence, so a "Ready to drink" view
   *  whose date compare was unsupported showed EVERY bottle and said
   *  nothing. Reported here, and a view shows them. */
  unapplied?: FilterPredicate[];
  /** The resolver THREW, so `items` is not the answer, it is nothing. A failed
   *  list used to come back as `{ items: [] }`, indistinguishable from "no
   *  matches": a search whose SQL named a column the table does not have
   *  returned no orders and no projects on every surface for weeks, and only a
   *  server log said so. Set by the platform's list(), never by a resolver. */
  failed?: true;
  /** Why the list has nothing to say: the kind has no list here, or the
   *  module that keeps it is off. Both used to answer `{ items: [] }`, which a
   *  person's own picker reads well and an assistant read as "you have none"
   *  (#4199). Set by the platform's list(), never by a resolver. */
  unlisted?: "no-such-list" | "module-off";
}

/** Module-side list resolver for an entity kind. Optional — kinds
 *  without one return { items: [] } from list(). Same projection
 *  rules as single-hop lookup: each item is filtered through the
 *  kind's exposableFields when the caller is outside the owning
 *  module (the platform handles the projection — resolver returns
 *  the full row). */
export type EntityListResolver = (
  orgId: string,
  query: EntityListQuery,
) => Promise<EntityListResult>;

/** Module-side list resolver for the items of ANY instance of a multi-instance
 *  module. Registered once per module (not per instance); the platform calls it
 *  for `<instance_name>:item` kinds, resolving the instance→module via the
 *  workspace_module_instances table. Lets views/search/data/calendar see
 *  instance entities through the generic layer. Same projection rules as
 *  EntityListResolver. */
export type EntityInstanceListResolver = (
  orgId: string,
  instance: string,
  query: EntityListQuery,
) => Promise<EntityListResult>;

/** Single-entity resolver for the items of ANY of a module's instances. The
 *  platform calls it for a `<instance_name>:item` LOOKUP when no exact resolver
 *  is registered (resolving instance→module), so a detail/lookup of an instance
 *  item resolves + gets computed fields the same as the base kind. Modules
 *  register once (not per instance). The single-entity twin of
 *  EntityInstanceListResolver. */
export type EntityInstanceResolver = (
  orgId: string,
  instance: string,
  id: string,
) => Promise<ResolvedEntity | null>;

/** Tier-2 context provider for computed fields. Given an entity, returns
 *  a namespaced bag of related/aggregated data referenced in a computed
 *  template as {{<namespace>.<key>}}. Best-effort: a throw renders the
 *  namespace empty rather than failing the whole resolve. */
export type ComputedContextProvider = (
  orgId: string,
  kind: string,
  id: string,
) => Promise<Record<string, unknown>>;

/** Context for resolving create-time field defaults. The kernel passes who is
 *  creating + what kind; a provider returns a partial of that kind's OWN
 *  fields. See PlatformEntities.registerCreateDefaults. */
export interface CreateDefaultsContext {
  orgId: string;
  /** The user creating the entity — many defaults are per-user (e.g. presence
   *  defaults a location from where the user is). Undefined for system / token
   *  callers; a provider should no-op when it needs a user and there is none. */
  userId?: string;
  /** The kind being created, e.g. "core-scan:item" / "inventory:part". */
  kind: string;
  /** Field values the caller already has (client-supplied). Providers may read
   *  these; the kernel never overrides a supplied value — defaults only fill
   *  keys the caller left unset (see resolveCreateDefaults). */
  supplied?: Record<string, unknown>;
}

/** A module's contribution of create-time defaults for one kind. Returns a
 *  partial of the kind's fields (by the kind's OWN field names). Best-effort:
 *  a throw is swallowed and contributes nothing. Provider-agnostic — presence,
 *  a GPS source, a manual room-pin all register the same way; the create path
 *  never imports any of them. */
export type CreateDefaultsProvider = (
  ctx: CreateDefaultsContext,
) => Promise<Record<string, unknown>>;

/** A device reading to apply to a linked entity. core-devices resolves the
 *  (connection, device) → entity link + mode, then asks the entity-OWNING
 *  module how that mode maps to one of ITS OWN actions — so core-devices never
 *  hardcodes the entity side and the owner never hardcodes the device side.
 *  (Audit 2026-06-26 follow-up — replaces the hardcoded
 *  `if (kind === "inventory:part")` branch in core-devices.) */
export interface DeviceApplyContext {
  /** The link's mode, e.g. "set" | "add". The owning module decides support. */
  mode: string;
  /** The reading's numeric value (null when the payload had none). */
  value: number | null;
  /** The target entity id (within the owner's kind). */
  entityId: string;
  /** Reason string to thread into the action (e.g. "device:scale-1"). */
  reason: string;
}

/** Maps a device reading to ONE of the owning module's actions. Returns the
 *  action id + args for core-devices to invoke (with its device-event context),
 *  or null if the module doesn't support that mode. */
export type DeviceApplyProvider = (
  ctx: DeviceApplyContext,
) => { actionId: string; args: Record<string, unknown> } | null;

/** What an entity-owning module declares so core-scan can treat its kind as a
 *  scan target — WITHOUT core-scan hardcoding a per-kind allowlist / endpoint /
 *  field map. Registered at boot via platform().entities.registerScannable.
 *  (Audit 2026-06-26 follow-up — replaces the hardcoded SCANNABLE set +
 *  KIND_CREATE_ENDPOINTS + KIND_QTY_FIELD maps in core-scan.) */
/** One scannable kind a workspace has (listScannableForOrg). */
export interface ScannableKind extends ScannableInfo {
  /** The kind records live under: a module's own ("inventory:part") or an
   *  instance's ("groceries:item"). */
  kind: string;
  /** The owning module. */
  module: string;
  /** The named instance the kind lives in, or null for the module's own. */
  instance: string | null;
  /** The registry record the kind came from (its fields, routes, traits). */
  record: EntityKindRecord;
}

export interface ScannableInfo {
  /** Singular noun for the scan UI / routing ("part", "asset", "machine"). */
  noun: string;
  /** Module HTTP path a confirmed scan POSTs to (under
   *  /api/v1/orgs/:slug/modules/), e.g. "inventory/parts". */
  createEndpoint: string;
  /** The create body's quantity field name ("qty" | "quantity"). Absent for
   *  kinds without a native quantity (one row = one thing, e.g. a record):
   *  scan flows then skip the qty bump / adjust affordances for that kind. */
  qtyField?: string;
  /** The qty field says how many identical things one record stands for, and
   *  the kind's list never also returns those things as records of their own
   *  (a unit named under its parent stays under it). Then a count answers in
   *  both records and things (`count_records`' `units`). Leave it off while
   *  the list can return a thing twice, or the count would add it twice. */
  qtyCountsThings?: boolean;
  /** Marks this the fallback scan target when no identify hint matches a noun
   *  (at most one should set it). Lets core-scan route an unhinted scan without
   *  hardcoding a default module. */
  default?: boolean;
  /** The action that moves this kind's quantity by a delta, invoked ON the
   *  record with args `{ delta, reason, restock?, sourceKind?, sourceId? }`
   *  and answering `{ ok, delta, newQty, clamped?, note?, error? }`: the
   *  module's own quantity door, where its floor, lots and ledger live. When
   *  declared, core-scan takes an undone bump back through it; without it,
   *  the quantity field is written through the module's own route. */
  adjustAction?: string;
  /** The action that keeps this thing at another place too: invoked ON the
   *  item with args `{ location_id, qty }` and answering `{ ok, id, card_id }`
   *  (the new place's record and the item it belongs to). When declared, a
   *  scan of a thing the workspace has, at a place it is not kept yet, files
   *  as that place's row under the same item instead of a count on another
   *  place or a second item. */
  holdAction?: string;
}

/** In-process create/update/delete for one kind, registered by the owning
 *  module. The WRITE counterpart to EntityResolver — used by cross-module
 *  writers (the sync engine) that have no HTTP request / user token. The
 *  writer resolves its own tenant db from orgId and runs the module's own
 *  validation + events. */
export interface EntityWriter {
  /** Owning row table, used for predicates that must run before paging. */
  table?: string;
  /** Create an entity; returns the new entity's id. */
  create(orgId: string, fields: Record<string, unknown>): Promise<string>;
  update(orgId: string, id: string, fields: Record<string, unknown>): Promise<void>;
  /** Optional, with `updateIf`: the record's version now (`rowVersionOf`),
   *  null when there is no such record. */
  version?(orgId: string, id: string): Promise<string | null>;
  /** Optional: `update`, only if the record is still at `version`. Answers
   *  the record's new version, or null when it changed in between and
   *  nothing was written (`updateRowAt`). Kernel code that writes a record
   *  somebody else may be editing (a share's mirror) reads the version,
   *  then the record, decides, and writes with this, so an edit in between
   *  is never overwritten. */
  updateIf?(orgId: string, id: string, fields: Record<string, unknown>, version: string): Promise<string | null>;
  /** Optional: set these metadata keys on one record and leave every other
   *  key as the live row holds it, in one statement (`withMetadataMerged`).
   *  `update` writes metadata wholesale, which is right for a sync that owns
   *  the whole bag and wrong for anyone filling a few fields on a record they
   *  do not own: an order stamping where a printer came from must not drop
   *  the printer's other fields (#3856). */
  mergeMetadata?(orgId: string, id: string, fields: Record<string, unknown>): Promise<void>;
  /** Optional: the id of an existing record whose `field` (a column, or a key
   *  inside `metadata` when `metadata` is true) equals `value`, or null. A sync
   *  asks this before creating a record its id-map does not know, so a record
   *  somebody already made with the source's key is ADOPTED instead of
   *  duplicated: two copies of one printer with the same source id, one made by an
   *  assistant and one by the next sync, was the bug (#3836). */
  findByKey?(orgId: string, key: { field: string; metadata: boolean }, value: string): Promise<string | null>;
  snapshotDeletion?(orgId: string, id: string): Promise<DeletionSnapshot | null>;
  restoreDeletion?(orgId: string, snapshot: DeletionSnapshot): Promise<void>;
  delete(orgId: string, id: string): Promise<void>;
  /** Optional: this thing is no longer the person's (sold, given away, parted
   *  out, …; `@cobblr/platform-contract/disposition`). The module records it
   *  the way its kind already means "out of use" (a machine's lifecycle
   *  state, a part's archive flag), so the record reads back `retired: true`
   *  and keeps its history. A kind without it has no such notion, and a
   *  caller says so rather than pretending. */
  retire?(orgId: string, id: string, how: { disposition: Disposition }): Promise<void>;
  /** Optional: the way back from `retire`: it is the person's again, in the
   *  lists and the totals, as it was before it left. A kind with `retire`
   *  and no `unretire` makes "I got it back" impossible, so give both. */
  unretire?(orgId: string, id: string): Promise<void>;
  /** Optional: existing entities of this kind, for a natural-key match during
   *  an import preview — so a one-time import MERGES a source record into an
   *  already-present row (same name) instead of duplicating it. Without this,
   *  an importer treats every unmapped source record as a brand-new create. */
  listForMatch?(
    orgId: string,
  ): Promise<Array<{ id: string; name: string; parentId?: string | null }>>;
  /** Optional: move values held under a custom field into the module's own
   *  taxonomy column, for a kind that declares `categoryAxis`.
   *
   *  The platform's scan category axis grew a choice field before a module's
   *  own tree could answer for it (#3223), so a workspace can hold values in
   *  `metadata[field]` that the module's own category filter never sees. Only
   *  the module may read its table, so the module moves them; the platform
   *  only orders the move before it removes the field. For each record with a
   *  value under `field` and nothing in `column`: find or create the taxonomy
   *  entry by normalised key, in the record's own instance, set the column,
   *  drop the metadata key. A record that already has a `column` value keeps
   *  it (somebody chose it) and loses only the stale key.
   *
   *  Idempotent: a second call finds nothing to move. `remaining` is how many
   *  records still hold a value under `field`; the platform removes the field
   *  only at zero, so a crash half way leaves a consistent workspace that the
   *  next pass finishes. */
  adoptAxisValues?(
    orgId: string,
    args: { field: string; column: string },
  ): Promise<{ moved: number; remaining: number }>;
  /** Optional: read an entity's current fields, so an import preview can show the
   *  both-sides diff (what's there now vs what the source would write). */
  read?(orgId: string, id: string): Promise<Record<string, unknown> | null>;
  /** Optional: put this exact row back, ID AND ALL.
   *
   *  Undo means the workspace returns to the state it was in, not that an
   *  opposite operation is performed. Those differ in ways that matter: a
   *  delete undone by CREATING a lookalike gives the record a new id, so every
   *  shelf that was inside it, every label pointing at it and every part filed
   *  under it are still pointing at something that no longer exists. It also
   *  runs the forward-write rules again, so a restore can be REFUSED by a rule
   *  the original write predates.
   *
   *  A restore is not a create. It writes the stored row back as it was, id
   *  included, and skips the validation a new record would face — the state
   *  being restored is by definition one this workspace already held.
   *
   *  Without this, undoing a delete falls back to recreating a copy, and says
   *  so plainly rather than pretending. */
  restore?(orgId: string, image: Record<string, unknown>): Promise<void>;
  /** Optional: the record's WHOLE row, every column, for a change ledger to
   *  keep as the state to come back to.
   *
   *  A resolved record is a curated view — the fields a kind chooses to
   *  publish. Notes, descriptions and anything the resolver leaves out are
   *  therefore invisible to an undo built on it: not restored, and not even
   *  noticed as having changed. Restoring a view is not restoring the state. */
  snapshot?(orgId: string, id: string): Promise<Record<string, unknown> | null>;
  /** Optional: what would go WITH this record if it were deleted.
   *
   *  Undo needs this because a delete is not local. Locations cascade to their
   *  children, so an undo that carefully spares a shelf you had edited, and
   *  then removes the rack it was in, has deleted your shelf anyway — one step
   *  later and with no message. Returning the names of what depends on this
   *  record lets an undo stop and say which.
   *
   *  Names, not a count, so the refusal can say WHICH thing it protected. */
  dependents?(orgId: string, id: string): Promise<string[]>;
  /** Optional: the usage counters a record of this kind keeps (a printer's
   *  print hours and prints), and a read of one record's current values. A
   *  maintenance schedule "every 200 print hours" is due by these, and the
   *  record's own module is the only one allowed to read its table (#3876).
   *  A value is null when the record has not counted anything yet. */
  counters?: EntityCounters;
}

/** One counter a kind keeps: its key in the kind's own storage, and what it
 *  counts in words a person reads ("print hours"). */
export interface EntityCounterDef {
  key: string;
  label: string;
}

export interface EntityCounters {
  defs: readonly EntityCounterDef[];
  read(orgId: string, id: string): Promise<Record<string, number | null>>;
}

/** A writer's refusal to create a second record where one of that name
 *  already is (a shelf called "Top" on a rack that has one). Carries the one
 *  that is there, so a caller that mirrors another system can link to it
 *  instead of failing: a sync whose source had the same place as a room made
 *  by hand refused every run and left everything pointing at it unmapped
 *  (#3900). The message is the writer's own sentence, unchanged. */
export class DuplicateRecordError extends Error {
  readonly existingId: string;
  constructor(message: string, existingId: string) {
    super(message);
    this.name = "DuplicateRecordError";
    this.existingId = existingId;
  }
}

export interface PlatformEntities {
  /** Register a resolver for one kind. Called from a module's
   *  api/index.ts at module-load time. */
  registerResolver(kind: string, resolver: EntityResolver): void;
  /** Register an in-process WRITER for one kind (create/update/delete).
   *  Lets cross-module writers (the sync engine) mutate this kind without
   *  an HTTP loopback or user token. */
  registerWriter(kind: string, writer: EntityWriter): void;
  /** Resolve the writer for a kind, or null.
   *
   *  Org-scoped because an INSTANCE kind (`<instance>:item` — a Bookshelf, a
   *  Wardrobe) exists only per-workspace and is never registered: only the
   *  owning module's real kind is. A by-kind-alone lookup misses on every one
   *  of them and the miss looks exactly like "this kind is not writable", so
   *  the caller quietly skips the write. Pass the org and instances resolve. */
  getWriter(orgId: string, kind: string): Promise<EntityWriter | null>;
  /** Set a few metadata keys on any record, whatever module owns it, leaving
   *  the rest as they are (the kind's writer's `mergeMetadata`). False when
   *  the kind cannot do it, so the caller can say so instead of claiming a
   *  write. Instance kinds resolve like getWriter. */
  mergeMetadata(orgId: string, kind: string, id: string, fields: Record<string, unknown>): Promise<boolean>;
  /** Put a row back exactly as it was, id and all. True when the kind's writer
   *  can do it; false when nothing here can, so the caller can fall back and
   *  say what it actually did instead of claiming a restore. */
  restore(orgId: string, kind: string, image: Record<string, unknown>): Promise<boolean>;
  /** The whole row for a record, when its kind can produce one — what a change
   *  ledger stores so an undo has real state to put back. */
  snapshot(orgId: string, kind: string, id: string): Promise<Record<string, unknown> | null>;
  /** What would be deleted along with this record. Empty when nothing would be;
   *  null when the kind cannot say (and a caller must not read that as "safe"). */
  dependents(orgId: string, kind: string, id: string): Promise<string[] | null>;
  /** Register a list-resolver for a kind. Optional — without one,
   *  list() returns an empty result. Modules opt in when they want
   *  their kind to appear in core-views, search results, etc. */
  registerListResolver(kind: string, resolver: EntityListResolver): void;
  /** Register a list-resolver for the items of any instance of a multi-instance
   *  module (keyed by module name). The platform invokes it for
   *  `<instance_name>:item` kinds. Lets instance entities appear in
   *  views/`data`/search/calendar through the generic layer. */
  registerInstanceListResolver(
    moduleName: string,
    resolver: EntityInstanceListResolver,
  ): void;
  /** Register a single-entity resolver for the items of any instance of a
   *  multi-instance module (keyed by module name). The platform invokes it for a
   *  `<instance_name>:item` LOOKUP when no exact resolver matches, so an instance
   *  item's detail/lookup resolves + computes fields like the base kind. */
  registerInstanceResolver(
    moduleName: string,
    resolver: EntityInstanceResolver,
  ): void;
  /** Register a tier-2 context provider for COMPUTED fields, under a
   *  namespace. A computed field def (type='computed') references it in
   *  its template as {{<name>.<key>}}; the kernel invokes the provider at
   *  entity-resolve time only when some computed template on the kind
   *  actually uses the namespace. Keeps computed fields modular — the
   *  field layer never imports any specific module.
   *
   *  Example (in modules/core-maintenance):
   *    platform().entities.registerComputedContext(
   *      "maintenance",
   *      async (orgId, kind, id) => {
   *        // kind "assets:asset" → entity_module "assets", type "asset"
   *        return { last_performed, last_performed_at, next_scheduled_at };
   *      },
   *    ); */
  registerComputedContext(name: string, provider: ComputedContextProvider): void;
  /** Register a provider of create-time field defaults for a kind. The
   *  provider-agnostic seam behind "default a field from context on create" —
   *  e.g. a presence module defaulting `scan_area`/`location_id` from the room
   *  the user is in. Many modules may register for the same kind; the create
   *  handler calls resolveCreateDefaults() before insert and applies the result
   *  ONLY to fields the caller left unset, so an explicit client value always
   *  wins. The create path never imports the provider's module.
   *
   *  Example (in a presence module):
   *    platform().entities.registerCreateDefaults("core-scan:item",
   *      async ({ userId }) => {
   *        const room = userId ? await currentRoom(userId) : null;
   *        return room ? { scan_area: room } : {};
   *      }); */
  registerCreateDefaults(kind: string, provider: CreateDefaultsProvider): void;
  /** Remove a previously-registered create-defaults provider (by reference).
   *  Mainly for tests / hot-reload symmetry. */
  unregisterCreateDefaults(kind: string, provider: CreateDefaultsProvider): void;
  /** Register how a device reading on this kind maps to one of the module's
   *  OWN actions (e.g. inventory maps set/add → set-stock/adjust-stock). Lets
   *  core-devices apply a reading without knowing any entity module — and the
   *  isolation lint can't be fooled by a hardcoded `kind === "…"` branch.
   *  Example (in modules/inventory):
   *    platform().entities.registerDeviceApply("inventory:part", (ctx) =>
   *      ctx.mode === "set" && typeof ctx.value === "number"
   *        ? { actionId: "inventory:set-stock",
   *            args: { partId: ctx.entityId, qty: ctx.value, reason: ctx.reason } }
   *        : null); */
  registerDeviceApply(kind: string, provider: DeviceApplyProvider): void;
  /** Resolve a device reading to {actionId,args} via the kind's registered
   *  provider, or null when none is registered / the mode is unsupported. */
  applyDevice(
    kind: string,
    ctx: DeviceApplyContext,
  ): { actionId: string; args: Record<string, unknown> } | null;
  /** Declare a kind as a scan target (core-scan reads this instead of a
   *  hardcoded allowlist). Called at boot by the owning module, e.g.
   *  platform().entities.registerScannable("inventory:part",
   *    { noun: "part", createEndpoint: "inventory/parts", qtyField: "qty" }). */
  registerScannable(kind: string, info: ScannableInfo): void;
  registerLabelValuesProvider(name: string, provider: (orgId: string, kind: string, id: string) => Promise<string[]>): void;
  labelValuesFor(orgId: string, kind: string, id: string): Promise<string[]>;
  /** The scan info for a kind, or null if it isn't a scan target. */
  getScannable(kind: string): ScannableInfo | null;
  /** The scan info for a MODULE, regardless of which of its kinds is asked for.
   *  Scannability is a module-level property (create endpoint + qty field), but a
   *  caller may hold an INSTANCE-scoped kind ("vehicles:item") rather than the
   *  registered base kind ("assets:asset") — the instance routes the create
   *  separately, so the module's one scannable still applies. Resolves by the
   *  module prefix; null if the module has no scan target. */
  getScannableForModule(module: string): ScannableInfo | null;
  /** Every registered scan target as { kind, ...info } — core-scan builds its
   *  scan menu from this (which modules/kinds are scannable + their nouns).
   *  BASE kinds only, one per module: the answer to "which modules can be
   *  scanned into", never to "which kinds hold records here". */
  listScannable(): Array<{ kind: string } & ScannableInfo>;
  /** The scannable kinds THIS workspace has, instances included: each of
   *  listKindsForOrg's records that is scannable (an instance kind inherits
   *  its module's scannable), with the module, the instance it lives in and
   *  the record. The one answer for anything that walks a workspace's
   *  RECORDS across kinds: a base-registry walk sees no grocery and no yarn
   *  and looks like it worked (#3132). */
  listScannableForOrg(orgId: string): Promise<ScannableKind[]>;
  /** Run every registered provider for `ctx.kind` and return the merged
   *  defaults. The FIRST provider to set a key wins (deterministic); a provider
   *  that throws contributes nothing; null/undefined values are skipped.
   *  Returns {} when no provider is registered — so calling this is a no-op for
   *  kinds nobody augments. The CALLER applies the result; the convention is
   *  client-supplied value wins, default fills the gap. */
  resolveCreateDefaults(ctx: CreateDefaultsContext): Promise<Record<string, unknown>>;
  /** Look up one entity by (kind, id). Returns null if the kind
   *  has no resolver (module not enabled) or the entity doesn't
   *  exist. Projects through the kind's exposableFields whitelist.
   *
   *  `fields` IS A SUBSET, NEVER THE WHOLE RECORD. exposableFields is curated
   *  by the owning module - inventory withholds notes, cost and supplier_url
   *  from cross-module readers on purpose. So this is the right
   *  way to READ ABOUT an entity and the wrong way to COPY one: anything that
   *  reads a record here and then destroys the original (a merge, a move
   *  between kinds, an export-and-delete) silently loses every field the module
   *  chose not to expose. Read the whole row through the module's OWN CRUD
   *  route under the caller's bearer instead, the way core-scan's attach and
   *  duplicates/merge do. Caught in review 2026-09-04, in a merge that would
   *  have deleted the duplicate's notes along with it.
   *
   *  `viewer.userId` is used by the M1 v0.5 per-link role gate:
   *  cross-workspace fall-through respects `min_target_role` on
   *  workspace_links. Omit for system / anonymous callers — only
   *  unrestricted links qualify in that case. */
  lookup(
    orgId: string,
    kind: string,
    id: string,
    viewer?: EntityViewer,
  ): Promise<ResolvedEntity | null>;
  /** List entities of a kind. Returns { items: [] } when no list
   *  resolver is registered. Each item is projected through the
   *  kind's exposableFields when callers are outside the owning
   *  module — same projection rule as lookup().
   *
   *  See lookup() for viewer semantics — same gate applies to the
   *  cross-workspace union.
   *
   *  H2 — per-field read-scope: pass the viewer's identity
   *  (`userId` + `role`) and the kernel resolves their effective
   *  capabilities, dropping any field the viewer lacks the capability
   *  for. Owner/admin see everything. Omitting the viewer is fail-closed:
   *  a gated field (a custom one in `metadata` too) is withheld, so a door
   *  that forgot its reader can never leak one. Internal logic that
   *  decides something from the truth (an undo asking whether a field
   *  still holds values, a matcher, a sweeper) passes SYSTEM_VIEWER. */
  list(
    orgId: string,
    kind: string,
    query?: EntityListQuery,
    viewer?: EntityViewer,
  ): Promise<EntityListResult>;
  /** Every record the query answers, walked a page at a time (list() answers
   *  one page, usually 50, when no limit is asked). `total` is the
   *  resolver's count, else the walked count once complete, else null;
   *  `complete` is false only past `cap` (default 5000). A surface that
   *  shows "all of them" uses this and shows `total`, never a page length. */
  listAll(
    orgId: string,
    kind: string,
    query?: EntityListQuery,
    viewer?: EntityViewer,
    opts?: { pageSize?: number; cap?: number },
  ): Promise<Omit<EntityListResult, "total"> & { total: number | null; complete: boolean }>;
  /** The fields of a kind `viewer` may not read (field read scopes). A
   *  writer of rows that are not read through list() or lookup() (a module's
   *  own export) drops these, so a hidden field is never a column. */
  hiddenFields(orgId: string, kind: string, viewer: { userId?: string; role?: string }): Promise<Set<string>>;
  /** Every record the query answers as a spreadsheet, read as `viewer`:
   *  a field their role may not read is neither a column nor a value, a
   *  relabelled field is under its label, a hidden one is left out. `only`
   *  (a view's visible fields) picks and orders the columns after the name.
   *  Null when the workspace has no such kind. */
  exportCsv(
    orgId: string,
    kind: string,
    query: EntityListQuery,
    viewer: { userId?: string; role?: string },
    only?: string[],
    options?: { includeSecrets?: boolean },
  ): Promise<{ csv: string; filename: string; rows: number; complete: boolean } | null>;
  /** Batched lookup — resolve N (kind, id) refs in one call. Foreign
   *  callers that need joined data should use this instead of N
   *  separate single-hop calls. Same projection rules as lookup().
   *  Refs that don't resolve are silently skipped (callers get fewer
   *  results than they asked for, matchable by kind+id). Order is
   *  not guaranteed. */
  lookupMany(
    orgId: string,
    refs: ReadonlyArray<{ kind: string; id: string }>,
    viewer?: EntityViewer,
  ): Promise<ResolvedEntity[]>;
  /** core-resolver v0.1: multi-hop pairing walk.
   *
   *  Chains N hops through entity_pairings. Each hop has the same
   *  shape walkPairings accepts (rel + dir + optional kind filter).
   *  All hops batch their SQL: one query per hop, not one per
   *  intermediate row. Dedups duplicate (kind, id) refs along the
   *  way. Returns the resolved entities at the END of the path,
   *  all projected through exposableFields.
   *
   *  Example: part → [used-by] → task → [child-of] → project
   *  resolves a part's downstream projects in two batched calls.
   *
   *  `opts.maxPerHop` (default 500) bounds the working set per hop
   *  so a path with explosive fanout doesn't OOM. */
  walkPath(
    orgId: string,
    source: { kind: string; id: string },
    hops: Array<{ rel: string; dir?: "in" | "out"; kind?: string }>,
    opts?: { maxPerHop?: number },
  ): Promise<ResolvedEntity[]>;
  /** Walk entity_pairings from a source and return resolved + projected
   *  target entities. dir defaults to "in" (incoming — find things that
   *  POINT AT the source via this relation). kind filters discovered
   *  targets. The kernel half of the entity-resolver design — see
   *  docs/architecture/entity-resolver.md. */
  walkPairings(
    orgId: string,
    source: { kind: string; id: string },
    spec: { rel: string; dir?: "in" | "out"; kind?: string },
  ): Promise<ResolvedEntity[]>;
  /** Can list() answer for this kind in this workspace (a list resolver,
   *  its module enabled)? A kind that cannot always lists empty. */
  listable(orgId: string, kind: string): Promise<boolean>;
  /** List all declared kinds from cobblr_meta.entity_kinds. */
  listKinds(): Promise<EntityKindRecord[]>;
  /** listKinds plus one synthesized `<instance>:item` kind per named
   *  instance in the org (shape copied from the module's PRIMARY kind;
   *  endpoints relative to /instances/<name>, marked by instance_name). */
  listKindsForOrg(orgId: string): Promise<EntityKindRecord[]>;
  /** Get a single kind's full declaration. */
  getKind(kind: string): Promise<EntityKindRecord | null>;
  /**
   * The workspace's field defs FOR THIS KIND that declare a role, with trait
   * scopes already resolved.
   *
   * A module cannot work this out for itself. A field scoped to `@physical`
   * applies to `inventory:part` through the same predicate the action registry
   * uses, and that matcher is a kernel internal: reading `module_field_defs`
   * directly and filtering on `entity_kind = kind` silently misses every
   * trait-scoped field, which is precisely where the interesting ones (origin,
   * acquisition) live.
   *
   * So the kernel answers the question and modules ask it. Returns only defs
   * with a `field_role`, because the callers are the ones that act on MEANING
   * rather than on a name.
   */
  roledFieldsFor(orgId: string, kind: string): Promise<RoledField[]>;
  /** Every field the workspace defines on `kind`, roled or not, in display
   *  order, trait-scoped ones included - the columns a table of this kind
   *  shows beyond the module's own. For the surfaces that must carry the WHOLE
   *  record rather than act on meaning: a CSV export that drops these ships a
   *  bookshelf without its authors (2026-09-12), and an import that cannot
   *  name them has nowhere to put them back. */
  fieldsFor(orgId: string, kind: string): Promise<DefinedField[]>;
  sealSecretFields(orgId: string, kind: string, fields: Record<string, unknown>, id?: string, current?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** What a kind counts as it is used: the module's own counters
   *  (EntityWriter.counters) and every number field marked with the `usage`
   *  role. The one answer for "every [5000] [miles]". */
  countersFor(orgId: string, kind: string): Promise<EntityCounterDef[]>;
  /** One record's reading of each of those counters (null when unread). */
  readCounters(orgId: string, kind: string, id: string): Promise<Record<string, number | null>>;
  /** The ONE resolver for where a QR/scan/search hit for an entity should land,
   *  INSTANCE AWARE — shared by the QR-token resolver, the scan registry, and
   *  search so they can't drift (they were three hand-kept copies that each
   *  hand-substituted `{id}` into a base detail_route and so mis-routed an item in
   *  a NAMED instance to the empty base page). It resolves the entity, probes the
   *  module's named instances when the base kind can't see it, and picks the
   *  per-instance route. Returns undefined when the entity has no reachable page. */
  detailPathForEntity(orgId: string, kind: string, id: string): Promise<string | undefined>;
  /** A record's complete browser address, INSTANCE AWARE and WORKSPACE
   *  QUALIFIED. This is the address for anything that leaves the app, such as
   *  a library write-back, notification channel, calendar feed or export.
   *  `origin` overrides the configured public origin for an inbound request. */
  recordAddressForEntity(orgId: string, kind: string, id: string, origin?: string | null): Promise<string | undefined>;
  /** The entity's current system TITLE, INSTANCE AWARE — the stock name, re-resolved
   *  live. Same instance probe as detailPathForEntity: tries the given kind, and if
   *  that base lookup can't see an item in a NAMED instance, probes the module's
   *  named instances. Lets a caller (the label queue) offer "revert this trimmed
   *  caption to the system name". null when the entity no longer resolves. */
  titleForEntity(orgId: string, kind: string, id: string): Promise<string | null>;
  /** The kind id an entity ACTUALLY lives under, INSTANCE AWARE: the given base
   *  `kind` for a default-instance entity, or `<instance_name>:item` when it's in
   *  a named instance the base kind can't see (a machine under "3D Printers").
   *  Pair with a kind's display label (listKindsForOrg) to show an instance-aware
   *  name instead of the raw `module:kind`. Falls back to `kind` when unresolved. */
  resolvedKindForEntity(orgId: string, kind: string, id: string): Promise<string>;
  /** The MODULE kind behind a kind string: identity for a registered kind,
   *  `<instance>:item` → its owning module's primary kind.
   *
   *  Instance kinds are synthesized per-org and never stored in entity_kinds,
   *  so any registry keyed by kind (actions, traits, the event payload-key
   *  convention) misses on one and returns nothing — silently. Resolve through
   *  here before such a lookup. Reads (`lookup`/`list`/`lookupMany`) don't need
   *  it; they fall back at the resolver level. */
  baseKindOf(orgId: string, kind: string): Promise<string>;
  /** The module kind behind a kind string AND the named instance it lives in:
   *  `groceries:item` → { base: "inventory:part", instance: "groceries" }; a
   *  module's own kind → { base: itself, instance: null }. The instance-kind
   *  grammar lives in the kernel alone; a caller that needs both halves reads
   *  them here rather than parsing the string. */
  resolveKind(orgId: string, kind: string): Promise<{ base: string; instance: string | null }>;
  /** Inject `<name>_label` for the relation/member fields on rows a module
   *  queried itself, so a record reads the same whichever URL asked for it.
   *  The generic entity resolver already does this; a module's own list route
   *  is a second read path and must not skip it. No-op for kinds with no such
   *  fields, so it is safe to call unconditionally. Batched across the page. */
  withFieldLabels<T extends Record<string, unknown>>(
    orgId: string,
    kind: string,
    rows: T[],
  ): Promise<T[]>;
  /** The names of a kind's SERVER-MANAGED custom fields (field defs with
   *  `server_managed = true`, e.g. core-mobility's `away_since`). A write
   *  route uses this to preserve the stored value across an unrelated client
   *  edit rather than accepting the client's — metadata is written wholesale
   *  (read-modify-write), so a stale client value would otherwise clobber a
   *  server-stamped one. Empty for kinds with no such fields (a no-op). */
  serverManagedFields(orgId: string, kind: string): Promise<string[]>;
}

export interface EntityKindRecord {
  id: string;
  module_name: string;
  /** The owning module's instanceability ("multi" = a workspace can create
   *  named instances of it — the AI builder uses this to know which modules
   *  can back a new provides_instances entry). Resolved from the registry at
   *  read time; "single" when unknown. */
  module_instanceability?: "single" | "multi";
  display_name: string;
  display_name_plural: string | null;
  icon: string | null;
  fields: EntityFieldDecl[];
  detail_route: string | null;
  endpoints: { get?: string; list?: string; create?: string; update?: string; delete?: string } | null;
  /** The module's primary kind (see the manifest `primary` flag). */
  is_primary?: boolean;
  /** Set ONLY on registry records synthesized for a workspace's named
   *  instances (`<instance>:item`): endpoints are then relative to
   *  /orgs/:slug/instances/<instance_name>, NOT /modules/<module_name>. */
  instance_name?: string;
  version: string;
  /** Resolved 6-axis trait fingerprint (or null if the kind declared
   *  no traits). Used by action matching when an action's appliesTo
   *  predicate specifies `traits: [...]`. */
  traits: RawTraitsDecl | null;
  /** Preset name (e.g. "owned-thing") if the manifest used profile
   *  shorthand. Bookkeeping for tooling. */
  profile: string | null;
  /** Labeling hint declared by the owning module: the default for
   *  drawing the human-readable code in the QR center when a workspace
   *  hasn't set an explicit per-kind toggle. Null = undeclared (the
   *  labels module treats null/absent as true — today's behavior). The
   *  labels module reads this generically off the registry rather than
   *  branching on any kind string. See docs/design-decisions/label-codes.md. */
  label_code_overlay_default: boolean | null;
  /** Cross-module read whitelist. Null = legacy (full fields returned,
   *  deprecation logged). Array = the names of fields foreign callers
   *  may read; the kernel projects ResolvedEntity.fields to this list
   *  before returning to a non-owning module. The implicit cross-cutting
   *  props (id/title/subtitle/image_path/detailUrl) are always exposable
   *  regardless of this list. See docs/architecture/entity-resolver.md. */
  exposable_fields: string[] | null;
  /** Field that scopes duplicate detection for this kind, or "workspace";
   *  null means it is never deduplicated (see the EntityKind manifest field). */
  duplicate_scope?: string | null;
}

// ──────────────── Pillar B runtime — actions ───────────────────────

/** Programmatic action handler. The platform routes
 *  platform.actions.invoke() calls to the right module's handler.
 *  Returns whatever the module wants — the caller might be the
 *  wire-engine running an event-triggered action, in which case
 *  the return is mostly ignored. */
export type ActionHandler = (ctx: ActionInvokeContext) => Promise<unknown>;

/** What an action is about to do, from its arguments, before it does it. One
 *  line for a single record; for a bulk action a list: every record that
 *  moves, and where. */
export interface ActionPlan {
  /** One line, the change in a sentence: "Move 5 records from Pantry into Tea". */
  title: string;
  /** One line per thing touched, by what a person calls it. */
  lines: string[];
}
/** A planner answers the plan, or the reason there is none. A reason goes
 *  back to the caller (the assistant fixes its arguments); a plan goes on
 *  the confirm card. Nothing else is ever shown. */
export type ActionPlanner = (ctx: ActionInvokeContext) => Promise<ActionPlan | { error: string } | null>;

/** A UI directive an action handler MAY include in its result to ask the web
 *  shell to open a first-party FLOW after the action completes — e.g.
 *  disassemble-kit returning `{ ok, ui: { flow: "core-scan:organize", args:
 *  { scope: "refs", refs } } }` so the sorting planner opens over exactly the
 *  parts it just spawned. The shell's action-invoke path (EntityActionsBar)
 *  reads `result.ui` and opens the registered flow; unknown flows are ignored,
 *  so this is safe to return whether or not the shell yet honors it. Declarative
 *  from the module's side — the handler returns data, never touches the web app
 *  (module isolation). Generic: any action of any module can hand off to any
 *  registered flow. See docs/architecture/invokable-flows-and-lego-redesign.md. */
export interface ActionUiDirective {
  /** Registered flow id, e.g. "core-scan:organize". */
  flow: string;
  /** Opaque args passed to the flow (e.g. { scope: "refs", refs: [...] }). */
  args?: Record<string, unknown>;
}

/** Per-request authentication context. Inherited from the originating
 *  request so wires fired async still carry the right actor (a stock
 *  bump from the UI fires wires tagged session; one from a `cbt_*`
 *  token fires wires tagged api_token with the token name). */
export interface ActionInvokeActor {
  user_id: string | null;
  display_name: string | null;
  auth_method: "session" | "api_token" | "system";
  /** Set only when `auth_method === "api_token"`; the token row id. */
  api_token_id?: string | null;
  /** Set only when `auth_method === "api_token"`; the token's name. */
  api_token_name?: string | null;
}

/** Q2 resolution: namespaced action context. Handlers receive the
 *  target entity, the originating event (or click context), and any
 *  pre-rendered template — each in its own block. ONE spelling for the
 *  record: `ctx.entity`. The top-level `entityKind` / `entityId` aliases
 *  are gone (2026-09-22) — a second spelling is a second thing every
 *  reader has to know about, and the one check that asks "does this
 *  handler read its record?" knew only the first, so it accused a handler
 *  that read the record through the alias (#3378).
 *  See docs/architecture/wires-and-bundles.md (Q2). */
/** One earlier step of a plan, as a later step's planner reads it. */
export interface PlanStepBefore {
  op: "delete";
  kind: string;
  id: string;
}

/** Who started what a run answers, from the arguments the run was given. */
export type ActionRequester = (ctx: { orgId: string; args: Record<string, unknown>; entity?: { kind: string; id: string } }) => Promise<string | null>;

export interface ActionInvokeContext {
  orgId: string;
  userId: string | null;
  /** Which pole this invocation runs on. "entity" (default) → `entity` is
   *  populated. "workspace" → a config/admin action with NO record, so
   *  `entity`/`entityKind`/`entityId` are all absent. A handler that reads
   *  `entity` must guard it: an entity-scoped handler can assert presence
   *  (the invoke route always populates it), a workspace handler never
   *  touches it. */
  scope?: "entity" | "workspace";
  /** The entity the action runs on. Present iff scope === "entity". For a
   *  wire with target='self', this is the source entity; for target:{rel,...}
   *  it's one of the entities discovered by walking pairings. The wire engine
   *  resolves it and projects through the kind's exposableFields. Absent for
   *  workspace-scoped actions. */
  entity?: {
    kind: string;
    id: string;
    fields?: Record<string, unknown>;
  };
  /** The originating event / user click / schedule that triggered
   *  this invocation. Always present; the `name`/`payload` shape
   *  varies by trigger type. */
  event: {
    name: string | null; // null for user-invoked
    payload: Record<string, unknown>;
    actor: ActionInvokeActor;
    timestamp: string; // ISO-8601
    trigger_type: "event" | "user-invoked" | "schedule" | "on-create" | "on-update" | "on-delete";
  };
  /** Pre-rendered template result, if the binding had a template. */
  rendered?: string;
  /** Extra args from the binding (passed through). */
  args?: Record<string, unknown>;
  /** For a PLANNER only: what the earlier steps of the same plan will have
   *  done by the time this one runs, so what the card says counts after them
   *  ("Delete this yarn, then remove Yarn" never says Yarn keeps its one
   *  record). Absent for a run, which reads the workspace as it then is. */
  before?: PlanStepBefore[];
  /** The origin (`https://host`) of the request that invoked the action,
   *  when a person pressed a button: the same origin the module's own
   *  routes see, so a handler that must mint an absolute URL (a label's
   *  QR) can use it the way the manual path does. Absent for a wire, a
   *  schedule or a webhook run, which have no request; those fall back
   *  to the workspace's configured base and may refuse without one. */
  origin?: string;
}

/** Assert that an action ran on a record (scope 'entity') and return that
 *  entity, narrowed to non-null. Entity-scoped handlers call this at the top
 *  instead of reaching into `ctx.entity` directly: the invoke route always
 *  populates `entity` for an
 *  entity-scoped action, so this only throws if a workspace-scoped invocation
 *  somehow reached an entity handler (a wiring mistake) — a clear error beats
 *  a downstream `undefined.id`. Workspace handlers never call it; they read
 *  `ctx.args`. */
export function requireActionEntity(ctx: ActionInvokeContext): {
  kind: string;
  id: string;
  fields?: Record<string, unknown>;
} {
  if (!ctx.entity) {
    throw new Error(
      "This action runs on a record, but was invoked without one (workspace scope). " +
        "Check the action's `scope` and how it was triggered.",
    );
  }
  return ctx.entity;
}

/** Read a `list`-typed action argument as an array of non-empty strings,
 *  whatever shape the caller sent.
 *
 *  A handler must not care: the SAME argument arrives as a real JSON array from
 *  invoke_action, and as a plain string from the wire composer, whose arg field
 *  is a single text box and always will be. When core-locations:reorder read
 *  `ctx.args.ids` with a bare `Array.isArray`, a caller who sent
 *  "id-a, id-b" got an empty list and an unhelpful refusal — with no way to
 *  tell from the schema which of the two forms was wanted (2026-08-19).
 *
 *  Accepts: an array (of strings, or of anything stringifiable), a JSON array
 *  in a string, or a string delimited by commas / newlines / whitespace.
 *  Returns [] when the arg is absent or empty — the caller decides whether
 *  empty is an error. */
export function readListArg(
  args: Record<string, unknown> | undefined,
  name: string,
): string[] {
  const raw = args?.[name];
  if (raw == null) return [];
  const clean = (xs: unknown[]): string[] =>
    xs.map((v) => (typeof v === "string" ? v.trim() : String(v ?? "").trim())).filter(Boolean);
  if (Array.isArray(raw)) return clean(raw);
  if (typeof raw !== "string") return clean([raw]);
  const text = raw.trim();
  if (!text) return [];
  if (text.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) return clean(parsed);
    } catch {
      // Not JSON after all; fall through to delimiter splitting.
    }
  }
  return clean(text.split(/[\s,]+/));
}

/** Read a `json`-typed action argument as a structured value, whatever shape
 *  the caller sent.
 *
 *  The twin of readListArg, for the same reason: invoke_action can send a real
 *  object or array, and a wire's arg field can only ever send the text a person
 *  typed into it. A handler that tests `typeof args.config === "object"` throws
 *  away the second form silently.
 *
 *  Returns undefined when the arg is absent, blank, or is a string that is not
 *  valid JSON - the caller decides whether that is an error. */
export function readJsonArg<T = unknown>(
  args: Record<string, unknown> | undefined,
  name: string,
): T | undefined {
  const raw = args?.[name];
  if (raw == null) return undefined;
  if (typeof raw !== "string") return raw as T;
  const text = raw.trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

export interface PlatformActions {
  registerHandler(handlerKey: string, handler: ActionHandler): void;
  /** What the action behind `handlerKey` would touch, from its arguments, or
   *  the reason there is no plan: asked before a confirm card exists, so
   *  "no unit called that" reaches the caller instead of a card that dies on
   *  press. A module registers it beside its handler. */
  registerPlanner(handlerKey: string, planner: ActionPlanner): void;
  /** How the action behind `handlerKey` is undone, from its result. Register
   *  it beside the handler; an action declared `undoable` must have one (a
   *  guard test holds the two together), and the card after a run offers
   *  Undo exactly when the run handed steps back. See action-undo.ts. */
  registerUndo(handlerKey: string, undoer: ActionUndoer): void;
  /** Who started the thing this run answers: the person whose service job,
   *  held change or request it is, from its arguments, or null when nobody
   *  did. An action declared run by "requester" registers one beside its
   *  handler, and the action door lets that person through whatever their
   *  role (#5192): a person may always answer, undo or cancel what they
   *  themselves started. The handler still checks it too. */
  registerRequester(handlerKey: string, requester: ActionRequester): void;
  /** Find every registered action that applies to a given entity
   *  kind, factoring in `applies_to` predicates. When `orgId` is
   *  provided, per-org appliesTo overrides take precedence over the
   *  module-declared default, and only modules the workspace has turned on
   *  count; `alsoOn` names modules the caller is about to turn on (a bundle
   *  install that enables what it requires), so their actions count too. */
  listApplicable(kind: string, orgId?: string, opts?: { alsoOn?: readonly string[] }): Promise<EntityActionRecord[]>;
  /** Invoke an action programmatically. Throws if no handler is
   *  registered for the action's invoke_handler key. */
  invoke(actionId: string, ctx: ActionInvokeContext): Promise<unknown>;
  /** The way back from a run, from its result: the steps the action's own
   *  undoer hands back (see registerUndo), or null when it left nothing to put
   *  back or has no undoer. A module that invokes another module's action and
   *  wants to keep its inverse beside its own record (a scan attach keeping
   *  the restock's) asks here, the same way the invoke route does. */
  undoFor(actionId: string, result: unknown, ctx: ActionUndoContext): Promise<ActionUndoStep[] | null>;
  /** What the actions' arguments pick from, for one kind: returns a function
   *  that gives an `args_schema` with every `choicesFrom` argument filled in
   *  as `choices` (the usage counters, the workspace's People). The same fill
   *  GET /actions?kind= answers with, for a module's own door that shows an
   *  action's form (a Station's Lend offers names, never an id box). */
  argChoices(orgId: string, kind: string, schemas: readonly unknown[]): Promise<(schema: unknown) => unknown>;
}

/** What a collection wears, as the platform resolved it: the trait values
 *  (real and trial axes) and the faces they imply. */
export interface FaceVerdict {
  kind: string;
  /** Eligibility: the trait values the collection wears (facts). */
  traits: CollectionTraits;
  /** Disclosure: the faces a person sees (facts less their choices). */
  faces: FaceName[];
  /** Which faces were chosen in config rather than derived. */
  explicit: FaceName[];
  /** The faces a person may turn on from a record ("More about this item").
   *  Every face not worn, except where the collection's shape rules them
   *  out: a family's type collection offers none (its things carry them). */
  offers: FaceName[];
}

export interface EntityActionRecord {
  group?: string | null;
  primary?: boolean;
  id: string;
  module_name: string;
  label: string;
  /** Can a mistaken run be put back (the manifest's `undoable`)? A surface
   *  that runs it one tap from a scan or a list row reads this: an action
   *  label only offers what its Undo can take back (#3897). */
  undoable?: boolean;
  description: string | null;
  icon: string | null;
  applies_to: ActionAppliesToDecl;
  /** "entity" (default) → runs on a record; "workspace" → a config/admin
   *  operation with no record (skips entity resolution, never an entity
   *  button, matches no kind). */
  scope: "entity" | "workspace";
  invoke_route: string | null;
  invoke_handler: string | null;
  /** False = wire-only; don't render as a user button. */
  user_invokable: boolean;
  /** The way back for another action, and nothing else: run from Undo only. */
  internal: boolean;
  /** Fired by an event and nothing else; its record comes from the event.
   *  Never offered to the assistant. Distinct from user_invokable, the
   *  button flag. */
  wire_only: boolean;
  /** Runs on a record when given one, and with no record too (the manifest's
   *  `recordOptional`). */
  record_optional?: boolean;
  /** What it does to a due, dated thing (the manifest's `finishes`), or null. */
  finishes?: "used" | "discarded" | "still-good" | null;
  /** Disclosure: the face this verb belongs to, or null for the base. */
  face: string | null;
  /** Where the module declared it, 0-based. The strip lists a record's own
   *  module's actions first, in this order. */
  position: number;
  /** Machine-readable arg shape for the wire composer / invoke forms; null if
   *  the action declared none. */
  args_schema: Record<string, { label: string; type: "text" | "number" | "boolean" | "list" | "json" | "date"; required?: boolean; oneOf?: string; choices?: { value: string; label: string }[]; choicesFrom?: "counters" | "people"; ask?: boolean; with?: string }> | null;
  version: string;
}

// ──────────────── Pillar C runtime — wires + templates ─────────────

export interface PlatformTemplates {
  /** Render a template against a flat key/value map. Supports
   *  {{key}} substitution and {{key | default: "fallback"}} for
   *  empty values. Markdown-safe (no code execution). */
  render(template: string, data: Record<string, unknown>): string;
}

/** One enabled wire that would fire for an event, as a surface needs to say
 *  what a gesture is about to do ("+1 to stock when checked"). */
export interface WireEffect {
  binding_id: string;
  action_id: string;
  /** The action's label from the registry, for a generic rendering. */
  action_label: string | null;
  source_kind: string;
  args: Record<string, unknown> | null;
}

export interface PlatformWires {
  /** Called by an emitting module when an event fires. The wire
   *  engine looks up matching bindings + invokes their actions. */
  fireEvent(eventName: string, orgId: string, payload: Record<string, unknown>): Promise<void>;
  /** The enabled wires that WOULD fire for `eventName` on a record of
   *  `sourceKind`, so a surface can say what a gesture will do before it is
   *  made. Matches the way the engine matches: by the record's BASE kind, so
   *  a wire on `groceries:item` and one on `inventory:part` both count for
   *  either. Same action + args listed once, as the engine fires it once. */
  effectsOf(orgId: string, eventName: string, sourceKind: string): Promise<WireEffect[]>;
}

/** Health-probe primitive. Modules register a named probe at boot
 *  (typically from a lifecycle.onBoot hook); core-healthcheck
 *  aggregates them and exposes the rollup over HTTP. Each probe is
 *  a function returning a status string + an optional detail object.
 *  A probe that throws is treated as 'error' with the thrown
 *  message — the aggregator never propagates exceptions. */
export type HealthStatus = "ok" | "degraded" | "error";

export interface HealthProbeResult {
  status: HealthStatus;
  detail?: Record<string, unknown>;
  message?: string;
}

export type HealthProbe = () => Promise<HealthProbeResult>;

export interface PlatformHealth {
  /** Register a probe by name. Idempotent — re-registering overrides
   *  the previous handler (useful for hot-reload in dev). */
  registerProbe(name: string, probe: HealthProbe): void;
  /** Snapshot all probes in parallel. Failed probes become
   *  { status: 'error', message: <err.message> } so the caller
   *  always gets a uniform shape. */
  snapshot(): Promise<Record<string, HealthProbeResult>>;
  /** A one-shot heal shim (a file carrying `DONE WHEN:`) records what one
   *  pass found, keyed by its own repo path: `found` is how much of its DONE
   *  WHEN was still untrue when it looked (candidates, not fixes: one it
   *  skipped still blocks deletion), `failed` the workspaces it could not
   *  read. The kernel keeps the date it last went clean (nothing found,
   *  nothing failed) and /healthz reports every shim, so the deletion
   *  condition is read over HTTPS on every deployment instead of from boot
   *  logs that leave with the container. Call it after EVERY whole pass that
   *  looked, one that found nothing included: silence is not zero. Never
   *  throws. */
  noteHealShim(shim: string, found: number, failed?: number): Promise<void>;
  /** A heal, reconcile or sweep pass caught a failure for one workspace (or
   *  module) and carried on. Record it here, never only in a log line: it is
   *  kept for /healthz, /readyz and tests, so "nothing happened" can never
   *  hide "it failed" (#4937). `scope` names what failed (an org id, a module).
   *  Never throws. lint:pass-failures-reported holds a pass's catches to it. */
  notePassFailure(pass: string, scope: string | null, err: unknown): void;
}

/** D3 — per-entity recurrence. Modules register a scanner per kind
 *  they want eligible for scheduled per-entity events. core-recurrence
 *  calls each scanner once per tick per tenant; the scanner returns
 *  rows of (entityId, rrule, title?) — module reads its own internal
 *  fields (no exposableFields projection) so private metadata is
 *  usable for scheduling.
 *
 *  Example registration (in modules/assets):
 *    platform().recurrence.registerScanner("assets:asset", async (orgId) => {
 *      const db = await platform().tenants.getDb(orgId);
 *      const rows = await db
 *        .selectFrom("assets_assets")
 *        .select(["id", "name", "metadata"])
 *        .execute();
 *      return rows
 *        .map((r) => ({
 *          entityId: r.id,
 *          rrule: (r.metadata as any)?.water_rrule,
 *          title: r.name,
 *          event: "assets.asset.recurred",
 *        }))
 *        .filter((r) => typeof r.rrule === "string" && r.rrule);
 *    });
 */
export interface RecurrentRow {
  entityId: string;
  rrule: string;
  title?: string;
  /** Event name to emit when this entity is due. Lets one kind
   *  fire different events for different sub-cases (water vs fertilize)
   *  by returning the same entity twice with different event names. */
  event: string;
}

export type RecurrenceScanner = (
  orgId: string,
) => Promise<RecurrentRow[]>;

export interface PlatformRecurrence {
  registerScanner(kind: string, scanner: RecurrenceScanner): void;
  listScanners(): Array<{ kind: string; scanner: RecurrenceScanner }>;
}

/** One dated thing on the workspace calendar — a scheduled maintenance
 *  entry, a task due date, a food item's expiry. Contributed by a module's
 *  CalendarSource; aggregated by core-calendar for the in-app month view
 *  and the iCal feed. */
export interface CalendarEvent {
  /** Stable within a source across reads — used as the iCal UID and the
   *  React key. Convention: `<source>:<entityId>:<yyyy-mm-dd>`. */
  id: string;
  title: string;
  /** ISO date ("2026-06-10") for all-day, or ISO datetime for timed. */
  date: string;
  allDay?: boolean;
  /** The contributing source's id (e.g. "maintenance", "task", "expiry"). A
   *  machine key: matched on for colour/grouping, never shown. */
  source: string;
  /** What to CALL the source on screen. Without it the raw id leaks: a
   *  dashboard row read "Roma Tomatoes - Bought on  INVENTORY-DATE". */
  sourceLabel?: string;
  /** Whether passing this date means something is late. Absent is read as a
   *  deadline, which is right for the dedicated sources (maintenance, tasks,
   *  expiry) - they only ever emit deadlines. The generic date-field source
   *  says explicitly, because most custom date fields record rather than
   *  demand. See date-field-direction.ts. */
  direction?: DateFieldDirection;
  /** Coarse category for colour/grouping (often == source). */
  category?: string;
  /** Deep-link back to the originating entity, when there is one. */
  entityModule?: string;
  entityType?: string;
  entityId?: string;
  detailUrl?: string;
}

/** A module's contribution of dated events for a window. Called with an
 *  inclusive [fromISO, toISO] date range; returns the events in it.
 *  Best-effort: a throw is swallowed and that source contributes nothing. */
export type CalendarSource = (
  orgId: string,
  fromISO: string,
  toISO: string,
) => Promise<CalendarEvent[]>;

/** D? — workspace calendar. Modules register a source of dated events;
 *  core-calendar aggregates every registered source for the in-app month
 *  view + the tokenised iCal feed.
 *
 *  Example (in modules/core-maintenance):
 *    platform().calendar.registerSource("maintenance", async (orgId, from, to) => {
 *      // query scheduled, not-yet-done entries in [from,to]
 *      return rows.map((r) => ({ id: ..., title: r.name, date: r.scheduled_at, ... }));
 *    }); */
/** What an entity-owning module passes to register the generic "date
 *  custom-field → calendar" source for its kind. The owner supplies its OWN
 *  table; the kernel runs the generic field-def-driven query (every type='date'
 *  field on the kind + its instance kinds becomes an all-day event). Moves the
 *  table/module knowledge OUT of the kernel and INTO the owning module.
 *  (Audit 2026-06-26 follow-up — was a hardcoded SPECS list in the kernel.) */
export interface DateFieldCalendarSpec {
  /** Base entity kind, e.g. "inventory:part". */
  kind: string;
  /** The module's own table for that kind, e.g. "inventory_parts". */
  table: string;
  /** Module name for the event source/category, e.g. "inventory". */
  entityModule: string;
  /** Entity type for the event payload, e.g. "part". */
  entityType: string;
  /** The columns that say how much of a record is on hand and which
   *  collection it is in. A record of a collection with the STOCK face and
   *  nothing on hand has nothing left to date: the kernel leaves its date
   *  fields off the calendar and out of queryDateField, so exhausted milk is
   *  never "expired 5d ago" on the day it is bought again. A collection
   *  without the stock face (a bookshelf, where the count is not the point)
   *  keeps every date. Omit and every row counts. */
  onHand?: { column: string; instanceColumn: string };
  /** Built-in date columns, declared by their owner, with a separate filter. */
  dateColumns?: Array<{
    column: string;
    label: string;
    source: "warranty" | "purchase";
    direction: DateFieldDirection;
    /** A true flag, such as a lifetime warranty, removes this date. */
    excludeWhen?: string;
  }>;

}

export interface PlatformCalendar {
  registerSource(id: string, source: CalendarSource): void;
  /** Register the generic date-custom-field calendar source for an entity kind.
   *  Called by the OWNING module at boot (e.g. inventory for inventory:part),
   *  so the kernel never hardcodes which modules/tables have date fields. */
  registerDateFieldSource(spec: DateFieldCalendarSpec): void;
  /** Run every registered source for the window and return the merged,
   *  date-sorted events. Sources that throw contribute nothing. */
  collect(orgId: string, fromISO: string, toISO: string): Promise<CalendarEvent[]>;
  /** Kernel-mediated query: rows of `kind` whose date metadata field `field`
   *  falls in [fromISO, toISO]. The table is resolved from the kind's
   *  registerDateFieldSource spec, so a CALLER (e.g. lists surfacing grocery
   *  expiry) reads another module's dated rows WITHOUT naming its table. Returns
   *  [] when the kind isn't registered or its table is absent. (Audit burn-down:
   *  replaces lists' raw `from inventory_parts` reads.) */
  queryDateField(
    orgId: string,
    kind: string,
    field: string,
    fromISO: string,
    toISO: string,
  ): Promise<Array<{ id: string; name: string; value: string }>>;
  /** The rows of `kind` whose `field` holds a value that names no day (see
   *  field-day.ts). queryDateField leaves them out and hides nothing else;
   *  a reader that found nothing due asks here so it can SAY which record
   *  needs a person, rather than go quiet (#3279). */
  unreadableDateField(orgId: string, kind: string, field: string): Promise<Array<{ id: string; name: string; value: string }>>;
}

/** core-queue v0.1: persistent background work for modules.
 *  enqueue() defers a unit of work; registerWorker(name, fn) sets
 *  the handler that the api process's worker loop will invoke when
 *  the job's run_at has arrived. See api/src/platform/queue.ts. */
/** One thing a person can do about a notification, straight from the message. */
/** One line of a notification card and the actions that are about it. */
export interface NotificationCardRow {
  /** The line, plain text with light markdown (bold), e.g. "**Milk** — expires today". */
  text: string;
  /** Ids from the notification's `actions`, in the order to offer them. The
   *  first is the one a channel puts beside the line when it can hold only one. */
  actions?: string[];
}

export interface NotificationAction {
  /** Stable within one notification; this is what a client sends back. */
  id: string;
  label: string;
  /** The label when the button sits beside the line it is about (a card
   *  row), where the item's name is already on the line: "Used up" rather
   *  than "Used up · Baby Carrots". Falls back to `label`. */
  short?: string;
  /** A registered action id, e.g. "purchases:mark-arrived". Prefer an
   *  IDEMPOTENT action: a card can be pressed twice, from two devices, or
   *  long after the fact. */
  action: string;
  args?: Record<string, unknown>;
  /** A hint. Channels with no notion of emphasis ignore it. */
  style?: "primary" | "secondary" | "danger";
}

/**
 * WHERE A NOTIFICATION TAKES YOU — required, one way or the other.
 *
 * A notification is a thing that happened somewhere. Telling somebody about it
 * and then leaving them to find it is the failure this type exists to prevent:
 * five shipped notifications ("you hit your goal", "milk expires today",
 * "service is due") had no link at all, so the row was a dead sentence and the
 * only route to the thing was to remember where it lived (audit, 2026-09-06).
 *
 * A lint could only ever flag a link that is too SHALLOW, never one that is
 * absent, because nothing distinguishes "no link" from "not written yet". So
 * the destination is required by the TYPE, and a notification that genuinely
 * has nowhere to go says why in one line instead of being silent about it.
 */
export type NotificationDestination =
  | {
      /** Where the thing IS. Relative to the workspace ("/inventory/parts/123");
       *  the platform makes it absolute per channel. */
      link_url: string;
      no_link_reason?: never;
    }
  | {
      link_url?: never;
      /** Why this one has nowhere to go — a fact with no page behind it, a
       *  workspace-wide announcement. Not a TODO: if a destination exists, link
       *  it. Written down so the next reader knows it was decided, not
       *  forgotten. */
      no_link_reason: string;
    };

export interface DigestContribution { key: string; text: string; link?: string }
export type DigestContributor = (orgId: string, db: unknown) => Promise<DigestContribution[]>;
export interface PlatformNotifications {
  /** Adds a module's current needs to an existing digest, only while that module is enabled. */
  registerDigestContributor(eventType: string, module: string, read: DigestContributor): void;
  digestContributions(eventType: string, orgId: string, db: unknown): Promise<DigestContribution[]>;
  /** Fan a notification to one user across their enabled channels.
   *  Writes the row, looks up the user's per-event-type channel
   *  preferences, and delivers via every enabled channel. */
  dispatch(p: NotificationDestination & {
    idempotencyKey?: string;
    orgId: string;
    userId: string;
    eventType: string;
    message: string;
    module?: string;
    entityType?: string;
    entityId?: string;
    payload?: unknown;
    /**
     * The substance behind the one-line message, for a channel that can render
     * more than a sentence (a Discord DM becomes a card; the bell and email are
     * unaffected).
     *
     * Optional on purpose: a channel that cannot render it MUST still deliver,
     * so `message` has to stand alone and `link_url` reaches the same place.
     * Pass PLAIN TEXT — a body with entity tokens still in it will show a uuid
     * to whoever reads the notification.
     *
     * `rows` is the body as LINES, each naming the actions (by their id in
     * `actions`) that are about that line, for a channel that can put a
     * button beside the line it answers: a Discord DM lays each row out as a
     * section with its button as the accessory, and the in-app card renders
     * each row with its own buttons. A digest of fifteen groceries used to
     * arrive as a list and then fifteen buttons in a block beneath it, each
     * repeating the name so it could be matched back to its line (#3282).
     * `body` still stands alone for a channel that cannot pair them.
     */
    card?: { heading?: string; body?: string; context?: string; rows?: NotificationCardRow[] };
    /**
     * The message or card carries a person's private content: a personal
     * document, a secret field (#5243). A push to their phone or computer then
     * shows a generic line and the link, never the words, because a lock
     * screen is not private. The bell and the record still show it to them.
     */
    private?: boolean;
    /**
     * How urgent this is. Defaults to `normal`.
     *
     * It decides two separate things, and a module only has to think about the
     * second one: whether a channel hears about it at all (each subscription
     * carries a min_priority), and whether a channel with a DELIVERY WINDOW set
     * batches it into a digest or interrupts immediately. At or below `normal`
     * waits for the window; `high` and `urgent` do not.
     *
     * The dispatcher has always taken a priority; the module-facing contract did
     * not expose it, so every module notification was `normal` by omission. That
     * made the batching rule unable to see the difference it exists to make -
     * "your ice cream is in a cupboard" and "you are low on cumin" would have
     * arrived in the same morning digest.
     *
     * Reserve `high` for facts that stop being useful if they wait. A prediction
     * about shopping is not one.
     */
    priority?: "low" | "normal" | "high" | "urgent";
    /**
     * What CAUSED this: somebody doing something (`activity`, the default), or a
     * date arriving (`schedule`).
     *
     * A second dial beside priority, answering a different question. Priority is
     * "how much does this interrupt". This is "was it news, or was it the
     * calendar" — and people want those on different cadences on the SAME
     * channel: chat as it happens, everything due today as one morning list.
     * Priority cannot express that, because both are `normal`.
     *
     * Pass `schedule` when the notification exists because a date or threshold
     * was reached and was knowable in advance: expiring today, service due,
     * running low. Leave it alone for anything that just happened.
     *
     * `lint:dated-notifications` fails the build on a dispatch that carries a
     * dated payload and does not say which it is, because getting it wrong is
     * silent and backwards: a "milk expires today" that forgot to declare
     * itself interrupts at 03:00 when the sweep happened to run.
     */
    triggeredBy?: "activity" | "schedule";
    /** What the reader can DO about it, offered inside the message itself.
     *
     *  Channel-agnostic on purpose: a channel that can render them does
     *  (Discord as buttons), one that cannot delivers the message and its link
     *  unchanged. So `message` must still stand alone and must never say
     *  "press the button below".
     *
     *  Stored on the notification row. A press arrives from a client carrying
     *  only an id, and the action it maps to is read back from the row — so
     *  `action` and `args` here are the server's copy, never the wire's. */
    actions?: NotificationAction[];
  }): Promise<{ notificationId: string; deliveredVia: string[] }>;
  /** Convenience: every member of an org. Modules that want to
   *  broadcast a notification (e.g. "this task is now unblocked")
   *  iterate this and dispatch per-user. Prefer `audienceFor` for a
   *  workspace-wide kind: the dispatcher drops anyone outside the kind's
   *  audience anyway, so iterating everyone only composes messages that are
   *  then thrown away. */
  orgMemberIds(orgId: string): Promise<string[]>;
  /** The people a KIND of notification is for in this workspace, per the
   *  workspace's own setting (everyone by default, the owners, or a chosen
   *  few), intersected with live membership. What a sweep should iterate. */
  audienceFor(orgId: string, eventType: string): Promise<string[]>;
  /** The workspace's display name. Exists because a module has no other way to
   *  say WHERE something happened: the discussion room's notifications read
   *  "mentioned you in your workspace" from the action door, which is honest
   *  and worse than the name. Beside orgMemberIds for the same reason that
   *  lives here — workspace identity a notification needs, behind the contract
   *  instead of a meta read isolation forbids. Null when the org is gone. */
  orgName(orgId: string): Promise<string | null>;
}

// ── sync connectors (mirror external records into Cobblr entities) ──
// The typed runtime the sync engine drives. A declarative / AI-authored
// manifest layer can later compile down to this same shape.

export interface SyncFetchContext {
  orgId: string;
  baseUrl: string;
  credentials: Record<string, unknown>;
  /** SSRF-guarded fetch injected by the engine — use this, not global fetch. */
  fetch: typeof fetch;
}

export interface SyncRecord {
  externalId: string;
  parentExternalId?: string | null;
  fields: Record<string, unknown>;
  deleted?: boolean;
  /** Cross-section references: a target field that points at ANOTHER synced
   *  entity by its external id (e.g. a machine's location_id → a location). The
   *  engine resolves each through that section's id-map to the mirrored Cobblr
   *  entity id before writing — null if that entity hasn't been imported yet. */
  references?: Record<string, { section: string; externalId: string }>;
  /** Image fields to pull across: a target field (e.g. "image_path") → the source
   *  URL/path of an image. The engine fetches each (through the edge bridge),
   *  stores the bytes in core-files, and sets the field to the served file URL.
   *  Relative paths are resolved against the source base. */
  images?: Record<string, string>;
  /** Tag names to attach to the mirrored entity (by name; created if missing).
   *  Additive: a tag absent here is never detached. */
  tags?: string[];
  /** Per-record target instance (multi-instance modules) — the section's
   *  `instanceBy` routes each row to an instance by a field value, so ONE section
   *  fans a single endpoint out to several instances. Overrides the section's
   *  static `targetInstance` when set. */
  instance?: string | null;
}

export interface SyncEntityType {
  key: string;
  label: string;
  targetKind: string;
  /** Where the source's own id lands on the target record (a column, or a key
   *  inside `metadata`), when the mapping stores it. The engine uses it to
   *  ADOPT a record that already carries that id, one made by hand or by an
   *  assistant before the sync ran, instead of creating a second one (#3836).
   *  A declarative source derives it from its map; absent means no adoption. */
  keyField?: { field: string; metadata: boolean } | null;
  /** The source's display name ("My Shop"), for the activity rows the sync
   *  writes ("via automation “My Shop sync”"). Falls back to the connector id. */
  sourceLabel?: string | null;
  /** For a multi-instance target module: the instance slug to write into (e.g.
   *  "3d-printers"), so imported rows land under that instance's nav entry rather
   *  than the base. The engine passes it to the writer as the `instance` field. */
  targetInstance?: string | null;
  fetchAll: (ctx: SyncFetchContext) => Promise<SyncRecord[]>;
  fetchOne?: (ctx: SyncFetchContext, externalId: string) => Promise<SyncRecord | null>;
  /** Fetch a binary asset (image) from the source through the same transport as
   *  fetchAll — used by the engine to pull `SyncRecord.images` across. Returns the
   *  raw bytes + mime type, or null on any non-2xx / empty body. */
  fetchBinary?: (ctx: SyncFetchContext, urlOrPath: string) => Promise<{ bytes: Uint8Array; mimeType: string } | null>;
}

export interface SyncWebhookHit {
  entityType: string;
  externalId: string;
  deleted?: boolean;
  record?: SyncRecord;
}

export interface SyncConnector {
  id: string;
  label: string;
  describeCredentials: () => Record<string, { label: string; secret: boolean }>;
  describeConfig?: () => Record<string, { label: string; placeholder?: string }>;
  entityTypes: SyncEntityType[];
  testConnection?: (ctx: SyncFetchContext) => Promise<{ ok: boolean; error?: string }>;
  parseWebhook?: (
    body: unknown,
    headers: Record<string, string | string[] | undefined>,
  ) => SyncWebhookHit | null;
}

/** What a reconcile WOULD do to one source record, computed without writing —
 *  the unit of an import preview. 'link' = merge into an existing same-name
 *  Cobblr entity instead of creating a duplicate. */
export interface ImportPlanItem {
  externalId: string;
  name: string;
  action: "create" | "update" | "link" | "unchanged" | "delete";
  /** The existing Cobblr entity this row touches (link / update / delete). */
  cobblrId?: string | null;
  /** The mapped source fields this row would WRITE — what data comes over. */
  fields?: Record<string, unknown>;
  /** For link/update/delete: the existing Cobblr entity, so the preview can show
   *  the match both-sides (its name + current fields, when the writer can read). */
  match?: { id: string; name: string; fields?: Record<string, unknown> | null } | null;
}

export interface ImportPlan {
  entityType: string;
  targetKind: string;
  counts: {
    create: number;
    update: number;
    link: number;
    unchanged: number;
    delete: number;
    total: number;
  };
  items: ImportPlanItem[];
}

export interface PlatformIntegrations {
  /** Register an outbound connector. */
  registerConnector(c: {
    id: string;
    label: string;
    describeCredentials: () => Record<string, { label: string; secret: boolean }>;
    actions: Array<{
      id: string;
      label: string;
      description?: string;
      argsSchema?: Record<string, { label: string; type: "text" | "number" | "boolean" | "list" | "json"; required?: boolean; oneOf?: string }>;
      undoable?: boolean;
    }>;
    invoke: (
      ctx: {
        orgId: string;
        connectorId: string;
        rowId: string;
        credentials: Record<string, unknown>;
        args: Record<string, unknown>;
        rendered?: string;
        event?: { name: string | null; payload: Record<string, unknown> };
      },
      actionId: string,
    ) => Promise<unknown>;
    testConnection?: (credentials: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
  }): void;
  /** Register an inbound webhook handler. */
  registerInboundHandler(h: {
    id: string;
    label: string;
    describeWebhookConfig: () => Record<string, { label: string; secret: boolean }>;
    emits: string[];
    handle: (
      req: { headers: Record<string, string | string[] | undefined>; body: unknown; rawBody?: string },
      ctx: {
        orgId: string;
        inboundRowId: string;
        config: Record<string, unknown>;
        emit: (eventName: string, payload: unknown) => Promise<void>;
      },
    ) => Promise<{ status: number; body?: unknown }>;
  }): void;
  /** Register a SYNC connector — mirrors external records into a Cobblr
   *  entity kind. The typed runtime the sync engine drives. */
  registerSyncConnector(c: SyncConnector): void;
  /** Resolve a registered sync connector by id (the engine needs its live
   *  fetch fns), or null. */
  getSyncConnector(id: string): SyncConnector | null;
  /** List registered sync connectors for the "Add connection" picker
   *  (metadata only — no live fns). */
  listSyncConnectors(): Array<{
    id: string;
    label: string;
    credentials: Record<string, { label: string; secret: boolean }>;
    config: Record<string, { label: string; placeholder?: string }>;
    entityTypes: Array<{ key: string; label: string; targetKind: string }>;
  }>;
  /** List registered outbound connectors. Used by the connector
   *  catalogue endpoint to render the "Add connector" picker. */
  listConnectors(): Array<{
    id: string;
    label: string;
    credentials: Record<string, { label: string; secret: boolean }>;
    actions: Array<{
      id: string;
      label: string;
      description?: string;
      argsSchema?: Record<string, { label: string; type: "text" | "number" | "boolean" | "list" | "json"; required?: boolean; oneOf?: string }>;
      undoable?: boolean;
    }>;
  }>;
  /** List registered inbound handlers. */
  listInboundHandlers(): Array<{
    id: string;
    label: string;
    config: Record<string, { label: string; secret: boolean }>;
    emits: string[];
  }>;
  /** Resolve a registered connector by id, or null. Modules use this
   *  to validate a user-supplied connector_id before persisting. */
  getConnector(id: string): {
    id: string;
    label: string;
    actions: Array<{
      id: string;
      label: string;
      description?: string;
      argsSchema?: Record<string, { label: string; type: "text" | "number" | "boolean" | "list" | "json"; required?: boolean; oneOf?: string }>;
      undoable?: boolean;
    }>;
    testConnection?: (credentials: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
  } | null;
  /** Encrypt credentials with the per-org master key. */
  encryptCredentials(orgId: string, plaintext: Record<string, unknown>): Promise<string>;
  /** Decrypt credentials with the per-org master key. */
  decryptCredentials(orgId: string, ciphertext: string): Promise<Record<string, unknown>>;
  /** Invoke a registered connector. Returns the connector's result,
   *  or throws on failure. Audit logging is the caller's
   *  responsibility — the platform layer is intentionally stateless
   *  here so per-workspace audit rows live in the module's tenant
   *  DB. */
  invokeConnector(
    connectorId: string,
    ctx: {
      orgId: string;
      rowId: string;
      credentials: Record<string, unknown>;
      args?: Record<string, unknown>;
      rendered?: string;
      event?: { name: string | null; payload: Record<string, unknown> };
    },
    actionId: string,
  ): Promise<unknown>;
  /** Dispatch a request to a registered inbound handler. Used by
   *  the unauthenticated webhook receiver. */
  dispatchInbound(
    handlerId: string,
    req: { headers: Record<string, string | string[] | undefined>; body: unknown; rawBody?: string },
    ctx: {
      orgId: string;
      inboundRowId: string;
      config: Record<string, unknown>;
      emit: (eventName: string, payload: unknown) => Promise<void>;
    },
  ): Promise<{ status: number; body?: unknown }>;
}

// ──────────────────────── core-ai provider registry ───────────────
//
// Providers register at module load time (openai, anthropic, ollama
// ship built-in). The PlatformAi facade exposes a unified `invoke`
// that picks a provider + model based on the workspace's capability
// defaults, calls the provider, writes an audit row, returns the
// shaped result.

export const AiCapabilities = [
  "classify-image",
  "identify-image",
  "extract-text",
  "summarise",
  "embed-text",
  "chat",
  "match-to-catalog",
  // Multi-image: shown N candidate photos of one item, pick the best catalog
  // shot (product-only, correct colour, no people). The only capability that
  // sends more than one image in a call. See rank-images-prompt.ts.
  "rank-images",
  // One photo of SEVERAL things: list each distinct item with a bounding box,
  // so the scan inbox can split a group shot into children. It rode
  // identify-image with a caller-supplied prompt for a long time, and that cost
  // two separate bugs (adapters ignoring the prompt; a cache collision with the
  // identify call on the same photo) before it was given its own id. Its own
  // id is also what lets a workspace put splitting on a cheaper model than
  // identification and see its cost apart. The prompt itself is owned by the
  // caller (core-scan), which owns the output shape it parses.
  "split-image",
  // The FIRST LOOK at a photo: name + category + confidence, nothing else, so
  // it can come back in a second or two on a small model and be put to the
  // person as a question ("we think it's X - yes / no?") while the full
  // identify-image read runs, or is skipped because they answered. Its own id
  // because it asks a smaller question with a smaller answer, which is what
  // makes it fast; it is not identify-image with less context.
  "identify-glance",
  // Turning a sentence into a workspace: the bundle builder, the refine pass
  // and the template match. Its own id for the reason split-image has one, and
  // more so - it is the rarest call the platform makes and the one with the
  // most riding on it. Somebody describes what they keep, once, and either
  // recognises what comes back or gives up on the product.
  //
  // Rare and heavy is a different shape from chat, and a workspace should be
  // able to spend differently on it. On the free Google tier the fuller model
  // allows 20 requests a day against Lite's 500 (measured, see the preset):
  // hopeless for chat, exactly right for a handful of builds. Sharing chat's
  // id meant that trade could not be made at all.
  "design-workspace",
  // Reading a DOCUMENT: a bill of sale, an invoice, a receipt read as
  // paperwork, a warranty, a title, a form. Its own id because what rides on
  // it is a value somebody keeps (a VIN, a total, every line), so it goes to
  // each provider's fuller model, never its light one: Flash on Google's free
  // tier, not Lite, which stays for a quick glance at a photo (the owner,
  // 2026-10-02: "a document should get Flash, not Lite, since it's a more
  // serious item"). The caller sends its own prompt (what to read), and the
  // page as image_b64 with image_media_type; the answer is the model's text.
  // When the fuller model is busy the read waits for it rather than going to
  // a weaker one: a provider's busyAlternates are told the job, and answer
  // none lighter for this one.
  "document-read",
  "personal-document-read",
  // Planning a CHANGE in the chat: a turn that deletes a record or reshapes
  // the workspace (a feature off, a bundle removed, a list made, a field's
  // choices edited). The same conversation, tools and answer shape as `chat`,
  // and its own id so it goes to each provider's fuller model: a plan that
  // deletes or removes something is a serious action (the owner, 2026-10-02:
  // Flash, not Lite, on the same busy ladder). A turn starts on it when the
  // message asks for such a change, and moves to it the round the model
  // proposes one (modules/core-ai/src/api/plan-tier.ts). Never swapped down
  // to a lighter sibling when busy.
  "plan-changes",
  // Reading the TEXT of a document into fields: a receipt or invoice that came
  // as text (an email, a PDF with a text layer), the materials a pattern
  // lists. Its own id because it rode `chat` for a long time, so a person's
  // order for Cobb's chat read every receipt (the owner, 2026-10-10: choosing
  // Sonnet for Cobb read every receipt with Sonnet). It is thorough reading,
  // with documents and the scan inbox. The caller sends its own messages and
  // parses its own shape; a provider that does not declare it answers through
  // its chat, the same call as before.
  "read-document-text",
  // Naming a thing from TEXT evidence rather than a photo: a barcode's web
  // results, a product description checked against a photo's read. Thorough
  // reading, for the scan inbox; its own id for the reason above.
  "identify-from-text",
  // Organising what is already in the workspace: grouping pending scans into
  // themes, matching scans to records, planning a tidy-up, naming a sheet's
  // columns, laying out a floor plan's places. The caller's own prompt and
  // shape; a provider that does not declare it answers through its chat.
  "organise",
] as const;

export type AiCapability = (typeof AiCapabilities)[number];

/** How much of a conversation the assistant is given with each message: the
 *  newest this many. ONE number for both ends. The panel sends the newest
 *  part and the server keeps the newest part, so a long conversation never
 *  becomes a request the server refuses. The panel keeps the whole scrollback
 *  on the device; this bounds only what is sent and read. Forty messages of
 *  history was a server-side limit alone, and the twenty-first exchange in a
 *  conversation was a red "Bad request body" until the panel was cleared. */
export const CHAT_HISTORY_MESSAGES = 40;

/** A job an OLDER job can serve when nothing declares the new one.
 *
 *  A capability id is a promise to every provider that already exists, and
 *  they cannot all be updated at once: a third-party or user-installed
 *  provider written before `design-workspace` declares `chat` and nothing
 *  else. Without this, splitting a job out of another one takes the feature
 *  away from those workspaces entirely - a thing disappearing because of a
 *  refactor nobody asked them about.
 *
 *  So splitting a job is ADDITIVE. A provider that declares the new id is used
 *  for it; one that does not still answers through the job it always answered
 *  through, and the workspace's own choice comes first either way. It lives in
 *  the contract rather than in the resolver because it is part of the
 *  vocabulary: it says what a capability id MEANS to a provider that has never
 *  heard of it. */
export const AI_CAPABILITY_FALLBACK: Partial<Record<AiCapability, AiCapability>> = {
  "design-workspace": "chat",
  // A provider written before documents had their own job still reads one,
  // the way it reads any picture it is handed a prompt for.
  "document-read": "identify-image",
  "personal-document-read": "document-read",
  // A provider written before planning had its own job plans in its chat.
  "plan-changes": "chat",
  // Split out of chat (2026-10-10): every provider that read these through its
  // chat still does, with no change, until it declares them.
  "read-document-text": "chat",
  "identify-from-text": "chat",
  "organise": "chat",
};

/** A turn of the conversation, with tools and the chat answer shape: `chat`
 *  itself, or a planning turn on the fuller model. Every adapter asks this
 *  instead of comparing to "chat", so a planning turn is never handed the
 *  plain-text path (no tools, no tool_calls back). */
export function isChatTurn(capability: AiCapability | string): boolean {
  return capability === "chat" || capability === "plan-changes";
}

/** A model id that names whatever the provider currently points it at: the
 *  AI page says so beside it. Kept with the rest of what a model id means. */
export { isFloatingModel };

/** The capabilities to try, in order, for one requested job. */
export function aiCapabilityChain(capability: AiCapability): AiCapability[] {
  const next = AI_CAPABILITY_FALLBACK[capability];
  return next ? [capability, next] : [capability];
}

/** The jobs a person arranges AI by, and the capabilities each stands for.
 *  ONE list for the router (a person's own defaults are kept per job) and
 *  the pages that show the jobs, so the two cannot disagree about which job
 *  a capability belongs to. Every capability sits in exactly one job.
 *  `shows` is the capability whose chain stands for the job on a page and
 *  whose models a person picks from. */
export const AI_JOBS = [
  { id: "personal", phrase: "personal documents", title: "Personal documents", shows: "personal-document-read", capabilities: ["personal-document-read"] },
  // The owner (2026-10-10): "Identifying scans/photos in the moment needs to
  // be quick. Identifying things more thoroughly in the scan inbox can take
  // longer. Documents might fit in here. Cobb chat is separate."
  { id: "glance", phrase: "a quick look", title: "Quick look", shows: "identify-glance", capabilities: ["identify-glance"] },
  {
    id: "reading",
    phrase: "thorough reading",
    title: "Thorough reading",
    shows: "identify-image",
    capabilities: ["identify-image", "split-image", "rank-images", "classify-image", "extract-text", "document-read", "read-document-text", "identify-from-text"],
  },
  { id: "chat", phrase: "Cobb chat", title: "Cobb chat", shows: "chat", capabilities: ["chat", "plan-changes", "design-workspace"] },
  { id: "text", phrase: "organising and text", title: "Organising and text", shows: "organise", capabilities: ["summarise", "match-to-catalog", "organise"] },
  { id: "search", phrase: "search", title: "Search", shows: "embed-text", capabilities: ["embed-text"] },
] as const satisfies ReadonlyArray<{ id: string; title: string; /** The job inside a sentence: "for a quick look", "for Cobb chat". */ phrase: string; shows: AiCapability; capabilities: readonly AiCapability[] }>;

export type AiJobId = (typeof AI_JOBS)[number]["id"];
export const AI_JOB_IDS: readonly AiJobId[] = AI_JOBS.map((j) => j.id);

/** The job a capability belongs to. */
export function aiJobOf(capability: AiCapability): (typeof AI_JOBS)[number] {
  return AI_JOBS.find((j) => (j.capabilities as readonly string[]).includes(capability)) ?? AI_JOBS.find((j) => j.id === "chat")!;
}

/** One credential field an AI provider asks for. `choices` renders as a
 *  select (generic in every credential form) — e.g. the `transit` field on
 *  URL-based providers: direct fetch vs via the user's edge bridge. */
export interface AiCredentialField {
  label: string;
  secret: boolean;
  choices?: Array<{ value: string; label: string }>;
}

/** One numbered instruction on the way to a working connection. `href` turns it into a
 *  link, because "go to aistudio.google.com/apikey" as plain text is a URL somebody has
 *  to retype by hand, and that is where non-technical people give up. */
export interface AiSetupStep {
  text: string;
  href?: string;
}

/** How a person GETS the credentials this provider wants.
 *
 *  Without this the only place to explain "sign in, click Create API key, paste it here"
 *  was inside a field label, which renders as one long unclickable parenthetical. The
 *  fields say WHAT to paste; this says HOW to get it. */
export interface AiProviderSetup {
  /** One line on what this provider is and what it costs, before the steps. */
  summary: string;
  /** Ordered. Short enough to follow while switching between two tabs. */
  steps: AiSetupStep[];
  /** Anything true that a person should know before choosing it, e.g. what the free
   *  tier does with their data. Rendered as a caveat, not buried in a step. */
  caveat?: string;
}

export type AiPrivacy = "personal" | "normal";
export const AI_JOB_PRIVACY: Record<AiCapability, AiPrivacy> = {
  "classify-image": "normal",
  "identify-image": "normal",
  "extract-text": "normal",
  "summarise": "normal",
  "embed-text": "normal",
  "chat": "normal",
  "match-to-catalog": "normal",
  "rank-images": "normal",
  "split-image": "normal",
  "identify-glance": "normal",
  "design-workspace": "normal",
  "document-read": "normal",
  "personal-document-read": "personal",
  "plan-changes": "normal",
  "read-document-text": "normal",
  "identify-from-text": "normal",
  "organise": "normal",
};

/** The jobs a person may set their OWN default AI for (#5404): every job but
 *  a personal one. Personal documents are read by a local model only, by the
 *  workspace's own rule, so a person's defaults never reach them. */
export const AI_DEFAULT_JOBS = AI_JOBS.filter((j): j is Exclude<(typeof AI_JOBS)[number], { id: "personal" }> => AI_JOB_PRIVACY[j.shows] !== "personal");
export type AiDefaultJobId = (typeof AI_DEFAULT_JOBS)[number]["id"];

/** The job a person's own defaults answer a capability with, or null when
 *  they never do (personal documents). */
export function aiDefaultJobOf(capability: AiCapability): AiDefaultJobId | null {
  const id = aiJobOf(capability).id;
  return AI_DEFAULT_JOBS.find((j) => j.id === id)?.id ?? null;
}

export interface AiProviderDef {
  locality?: "local" | "cloud";
  id: string;
  label: string;
  /** The company a call is sent to, as a person consents to it: "Anthropic",
   *  "Google". Named in the consent to read personal documents in the cloud
   *  (#5621); the label stands in when it is not set. */
  company?: string;
  describeCredentials: () => Record<string, AiCredentialField>;
  /** Step-by-step, shown in the UI when this provider is picked. Optional: a provider
   *  needing no credentials (a managed one) has nothing to instruct. */
  setup?: AiProviderSetup;
  /** Where this sits in the picker. Lower sorts first, and the FIRST entry is what the
   *  add form defaults to, so this decides what someone with no AI at all is offered.
   *  Unset sorts last.
   *
   *  Explicit because it used to be import order in one file, which meant the default
   *  provider could change as a side effect of adding an unrelated `register()` line
   *  and nothing would say so. */
  rank?: number;
  /** Map capability → models the provider supports for it. */
  capabilities: Partial<Record<AiCapability, { models: string[]; defaultModel?: string }>>;
  /** What a model is CALLED and what it costs, for a picker a person reads.
   *  "gemini-flash-lite-latest" means nothing at a glance; "Flash Lite - 500
   *  free a day" is a decision. Optional; an id with no entry shows as its id. */
  modelNotes?: Record<string, { label: string; note?: string; short?: string }>;
  /** How this provider's models are LISTED rather than written down (#5417):
   *  its own models endpoint, family and version per id, a rule per job, and
   *  the one fallback list for when it cannot be asked. A provider with a
   *  catalog offers "latest" per family, resolved before every call. */
  modelCatalog?: import("@cobblr/platform-contract/ai-models").AiModelCatalog;
  /** Whether a workspace that has configured NO provider may have this one
   *  auto-selected by the zero-config fallback. Default true — a managed,
   *  credential-less provider (instance key) is ready to use. A provider that
   *  needs per-user setup before it works — e.g. the edge bridge needs a
   *  connected agent + a personal Connection — sets `false`, so it's used only
   *  when explicitly chosen/routed and a missing-provider case stays a clean
   *  "no provider configured" rather than an error from the unset provider. */
  autoSelectable?: boolean;
  freeBackground?: boolean;
  freeBackgroundModel?: string;
  /** This backend RUNS tools itself and cannot hand `tool_calls` back (a
   *  `claude -p`-style agent). Cobb's tools reach it as a read-only MCP relay
   *  instead: the platform mints a short-lived, workspace-pinned grant and puts
   *  it on `input.mcp` for the adapter to forward.
   *
   *  A BYO connection declares the same thing per-connection through the
   *  `mcp_relay: "bridge"` credential field. This is the declaration for a
   *  provider that is ALWAYS such a bridge and has no credentials to carry a
   *  flag — a managed one, say. Without it, that provider silently receives no
   *  tools at all: every read tool and every action invisible, the model left
   *  saying "I don't have that tool", and nothing logged. (Found on staging
   *  2026-08-15: the assistant's whole tool surface was dark on the managed
   *  bridge, and it read like a plausible refusal rather than a fault.) */
  relaysToolsViaMcp?: boolean;
  /** Its connection test shows it a known picture (AiConnectionTest.photos),
   *  because whether its backend looks at an image is in doubt (a bridge to an
   *  agent). Until that test has run, the AI page says "not checked with a
   *  photo" about it; a provider that reads images natively is not in doubt
   *  and is never flagged. */
  checksPhotosInTest?: boolean;
  /**
   * A fingerprint of the PROMPT this provider will actually send for
   * (capability, input) — i.e. the part of the request that the caller's `input`
   * does NOT already contain.
   *
   * The AI cache keys on `{capability, provider, model, input}`. For most image
   * capabilities the prompt is NOT in `input`: it's a constant the adapter injects
   * (`IDENTIFY_PROMPT`, and the extract-text / match-to-catalog / summarise
   * literals). So **editing one of those prompts changed nothing about the cache
   * key, and every already-seen image kept returning the answer generated by the
   * OLD prompt — forever, because cache rows have no TTL.**
   *
   * The worst victim was the prompt-eval harness: the one tool whose entire job is
   * to measure whether a prompt change helped was scoring stale replies.
   *
   * Returning a hash of the built prompt folds it into the key, so a prompt edit
   * invalidates exactly the entries it should and nothing else. Omit it and the
   * old (broken) behaviour stands — which is why every first-party adapter
   * implements it, and why a lint fails a new one that doesn't.
   *
   * MUST NOT hash the image bytes: they are already in `input` and therefore
   * already in the key. Hashing megabytes on every call to re-derive something the
   * key has would be pure waste.
   */
  promptFingerprint?: (capability: AiCapability, input: Record<string, unknown>) => string | null;
  /** The model this provider will ACTUALLY send for a call, and whether a
   *  person chose it (a model typed on the connection, or a workspace's choice
   *  for the job) rather than it being the provider's own default. The call
   *  log records this model: an adapter that resolves a placeholder such as
   *  "default" internally used to leave the log naming the placeholder, so the
   *  model that failed was the one thing a failure line never said (#3819).
   *  Omit it and the log records the model the router handed over. */
  resolveModel?: (ctx: {
    capability: AiCapability;
    model: string;
    credentials: Record<string, unknown>;
  }) => { model: string; chosen: boolean };
  /** Other models on the SAME key to try, in order, when this one stays busy
   *  after its retries, before the router tries another provider. Only used
   *  for a model nobody chose (see resolveModel): a person's explicit model is
   *  never swapped behind their back. For a provider whose default is a
   *  floating alias that can be overloaded for an hour while its sibling
   *  answers. Told the job, because a sibling fit for one job is not for
   *  another: a document is never handed to a lighter model (document-read). */
  busyAlternates?: (model: string, capability: AiCapability) => string[];
  /** Run a single inference. The platform handles caching + audit
   *  before/after. */
  invoke: (ctx: {
    privacy?: AiPrivacy;
    orgId: string;
    rowId: string;
    capability: AiCapability;
    model: string;
    credentials: Record<string, unknown>;
    input: Record<string, unknown>;
    config: Record<string, unknown>;
    /** Called with each piece of the answer as it arrives, when the caller
     *  wants to show words appearing rather than a spinner. Optional on both
     *  sides: a caller may not care, and an adapter whose provider cannot
     *  stream simply never calls it and returns the whole thing as before. */
    onDelta?: (text: string) => void;
  }) => Promise<{
    result: unknown;
    input_tokens?: number;
    output_tokens?: number;
    cost_cents?: number;
    /** The model the provider's response says answered, as it said it
     *  (Anthropic's and an OpenAI-compatible `model`, Ollama's `model`).
     *  A provider can serve another model than the one asked for, silently
     *  (a deprecated model redirected to its successor), so the ledger
     *  keeps both. Absent or null when the response did not say: never a
     *  copy of the requested id. */
    served_model?: string | null;
  }>;
  /** Optional health/test ping.
   *
   *  `models` is what the provider says it can serve. The check for "is this key any
   *  good" is usually a model-list request anyway, so the list comes back free with the
   *  answer — and it is what lets the UI offer a dropdown instead of asking someone to
   *  type an exact model name they have no way to know. */
  testConnection?: (credentials: Record<string, unknown>) => Promise<AiConnectionTest>;
  /** The models THIS connection serves, asked of it live (an Ollama's
   *  /api/tags, an OpenAI-compatible /models, a bridge's own list). A
   *  provider whose models depend on the endpoint implements it, so a menu
   *  offers what the connection has rather than the type's suggestions; a
   *  hosted service with a curated list leaves it out. Throws when the
   *  connection cannot be asked. */
  listModels?: (credentials: Record<string, unknown>) => Promise<string[]>;
}

/** What a connection reported it serves (platform().ai.modelsReportedBy),
 *  with the model typed on the connection itself always among them: a pinned
 *  entry the person added stays choosable even when the list cannot be read. */
export type AiReportedModels =
  | {
      ok: true;
      models: string[];
      /** For a provider with a model catalog: the picker's entries for the
       *  job asked about, "latest" per family first, then pins. */
      choices?: import("@cobblr/platform-contract/ai-models").AiModelChoice[];
      /** The listing could not be read and these came from the provider's
       *  fallback list: why, for a "Refresh models" beside them. */
      fallback?: string;
    }
  | { ok: false; error: string; models: string[] };

export interface AiConnectionTest extends ConnectionTestOutcome {
  error?: string;
  /** Why it failed, as the provider said it (provider-reason.ts): a bad key,
   *  a quota, a missing model, or a provider that did not answer. */
  reason?: import("./provider-reason.js").ProviderReason;
  /** Human-readable extra, e.g. a few model names. */
  detail?: string;
  /** Every model id the provider reported, unfiltered and in its own order. */
  models?: string[];
  /** Said instead of a verdict when the provider implements no test at all. */
  note?: string;
  /** A provider that can be handed an image but whose backend may or may not
   *  look at it (a bridge to an agent) is shown a known picture as part of
   *  its test: `read` is whether its answer named what is in it. Absent when
   *  the test did not try. */
  photos?: { read: boolean; said?: string };
}

/** A pluggable entitlement guard. Called by invoke() AFTER the provider +
 *  model are resolved but BEFORE caching/inference. Returning { allow:false }
 *  makes invoke() refuse exactly like "no provider configured" — so every
 *  caller's existing degrade path (the ai:false contract) handles it.
 *
 *  Open core ships NO guard (everything is allowed — self-host runs free).
 *  The hosted overlay registers one that denies the managed providers unless
 *  the org's plan/allowance permits it. This is the seam the proprietary
 *  cloud layer plugs into; the billing logic itself is NOT in the open core.
 *  See business-models/docs/09. */
export interface AiEntitlementGuard {
  (ctx: {
    orgId: string;
    capability: AiCapability;
    providerId: string;
    model: string;
  }): Promise<{ allow: boolean; reason?: string }>;
}

/** SSRF policy for AI providers that fetch a workspace-supplied URL
 *  (e.g. the ollama `base_url`). "lan" allows RFC1918 (a self-hosted
 *  Ollama lives on the LAN); "strict" blocks all private/loopback/
 *  metadata (a cloud tenant's "home" endpoint is reached over the
 *  public internet). Open core defaults to "lan"; the hosted overlay
 *  sets "strict" at boot. See docs/operations/security-audit.md §10. */
export type AiEndpointPolicy = "lan" | "strict";

/** One AI in the order a call would ask them (platform().ai.chainFor). */
export interface AiChainStep {
  position: number;
  /** Within the providers one call may ask. */
  asked: boolean;
  provider_id: string;
  /** The connection's own name for a personal one or a workspace provider
   *  with a label; the provider's otherwise. */
  label: string;
  model: string;
  /** What a person reads for the model ("Haiku · latest (5.5)"), when the
   *  provider lists its models. */
  model_label?: string;
  floating: boolean;
  source: "yours" | "shared" | "workspace" | "managed";
  credential_id?: string;
  owner_user_id?: string;
  provider_row_id?: string;
  /** One of the caller's own default steps for the job (#5404): set on Your
   *  account, Connections, not ordered from a workspace's page. */
  your_default?: true;
}

export interface PlatformAi {
  registerProvider(p: AiProviderDef): void;
  /** Register the (single) entitlement guard. Last registration wins;
   *  open core never calls this — only the hosted overlay does. */
  registerEntitlementGuard(g: AiEntitlementGuard): void;
  /** SSRF policy for workspace-supplied provider URLs. Defaults to
   *  "lan"; the hosted overlay sets "strict" at boot. Providers that
   *  fetch a user URL read this via getEndpointPolicy(). */
  getEndpointPolicy(): AiEndpointPolicy;
  setEndpointPolicy(p: AiEndpointPolicy): void;
  listProviders(): Array<{
    id: string;
    label: string;
    // AiCredentialField, not a narrower inline copy: `choices` was already missing here
    // while the UI reads it, so the type was quietly lying about the payload.
    credentials: Record<string, AiCredentialField>;
    capabilities: Partial<Record<AiCapability, { models: string[]; defaultModel?: string }>>;
    /** What each model is called and costs, for a picker a person reads. */
    modelNotes?: Record<string, { label: string; note?: string; short?: string }>;
    setup?: AiProviderSetup;
    /** Position in the picker; lower first, and FIRST IS THE DEFAULT. The list
     *  is returned already sorted by it — carried as well as applied, so a
     *  consumer that re-merges these with another registry can re-sort. */
    rank?: number;
    locality?: "local" | "cloud";
  }>;
  getProvider(id: string): AiProviderDef | null;
  /** Every AI a call for `capability` by `userId` would ask, in the order it
   *  asks them: the router's own walk (#3842), so a surface that lists
   *  choices cannot offer one the router would never reach or leave out one
   *  it would. A person's own "Just me" connection is in it; somebody else's
   *  is only when shared with the workspace. */
  chainFor(orgId: string, userId: string | null, capability: AiCapability, opts?: { limit?: number; privacy?: AiPrivacy }): Promise<{ steps: AiChainStep[] }>;
  /** The models a connection serves, asked of it (briefly cached), for a menu
   *  or a setting that must offer only what it has. Names the workspace's own
   *  provider (`providerId`) or a personal connection routed here
   *  (`credentialId`). Null when the provider keeps a curated list instead
   *  (no listModels), or the connection is not one this caller may use. */
  modelsReportedBy(
    orgId: string,
    userId: string | null,
    ref: { providerId?: string; credentialId?: string },
    opts?: { fresh?: boolean; capability?: AiCapability },
  ): Promise<AiReportedModels | null>;
  /** The models a connection's calls asked for and were answered by
   *  another model (requested id to served id): a provider redirecting a
   *  deprecated model, learned from each call's served model. Any provider,
   *  a curated list's too. Null when none, or when the caller may not use
   *  the connection. */
  modelRedirects(orgId: string, userId: string | null, ref: { providerId?: string; credentialId?: string }): Promise<Record<string, string> | null>;
  /** Single entry point for any module to use AI. Picks provider +
   *  model from the workspace's capability defaults, calls the
   *  cache, calls the provider, writes audit + cache rows, returns
   *  the result. */
  invoke(req: ({ privacy: "personal"; provider_id?: never } | { privacy?: "normal"; provider_id?: string }) & {
    orgId: string;
    capability: AiCapability;
    input: Record<string, unknown>;
    /** Override provider + model from workspace defaults. */
    model?: string;
    /** A PERSONAL connection routed into this workspace, chosen for this call
     *  (cobblr_meta.user_credentials.id). The chat's model pill sets it per
     *  user; a workspace's per-job default sets it per workspace. Wins over
     *  the workspace's own providers, the way naming a provider_id does. */
    credential_id?: string;
    /** Per-call provider knobs (max_tokens, temperature, …) merged OVER the
     *  workspace capability-default config. A surface that knows its own
     *  needs (the matchmaker's 2-candidate JSON never fits 1024 tokens)
     *  states them here instead of relying on an ops-set DB row. */
    config?: Record<string, unknown>;
    /** Skip cache lookup AND skip cache write. Useful for
     *  match-to-catalog after a user rejects a suggestion. */
    bypass_cache?: boolean;
    /** REPLAY ONLY — serve from cache, and if there's no cached reply, fail
     *  instead of calling the provider. Costs nothing and spends no tokens.
     *
     *  This is what makes a "re-run without AI" possible: every AI stage already
     *  degrades to a deterministic path when a call fails (identify → null, the
     *  matchmaker → its keyword heuristic), so replaying the model's PREVIOUS
     *  answers through TODAY's parsers and heuristics exercises a fix to them
     *  without buying a single token. The miss throws in the "no provider" error
     *  family precisely so those existing degrade paths handle it unchanged.
     *
     *  It cannot test a PROMPT change: the cache key hashes the input (the image),
     *  not the prompt, so a cached reply answers whatever prompt was live when it
     *  was bought. Mutually exclusive with bypass_cache; bypass_cache wins. */
    cache_only?: boolean;
    costPolicy?: "free";
    source?: { kind: string; id: string };
    /** The user who initiated this call (for the AI activity log). Null/absent
     *  for system-initiated calls (e.g. a wire). */
    userId?: string | null;
    /** Show the answer as it is written. Passed to the adapter, which streams
     *  when its provider can and ignores it when it cannot — so a caller may
     *  always pass it and simply see nothing until the end. A cached reply
     *  never streams: there is nothing to watch, it is already written. */
    onDelta?: (text: string) => void;
  }): Promise<{
    /** The adapter's answer as it gave it: tool calls, a vector, the message. */
    result: unknown;
    /** The words of the answer, whichever key the adapter put them under
     *  (`content` for chat, `text` for the rest, or a bare string), and "" for
     *  an answer with none. Read this, never `result.text` or
     *  `result.content` (@cobblr/platform-contract/ai-answer). */
    text: string;
    provider_id: string;
    model: string;
    cached: boolean;
    input_tokens?: number;
    output_tokens?: number;
    cost_cents?: number;
    duration_ms: number;
    /** The model the provider said answered, when it said; `model` is the
     *  one asked for (servedModelDiffers in ai-models says whether they are
     *  different models). */
    served_model?: string | null;
    /** The providers asked first that did not answer (busy, unreachable, a
     *  limit, a key), oldest first, when this answer came from the next
     *  provider the workspace lists (#3819). Absent when the first answered. */
    answered_after?: Array<{ provider_id: string; label: string; model: string; reason: string }>;
    /** What a person reads for the connection that answered: its own name
     *  ("Claude bridge (Sam)") when it has one, else the provider's. */
    provider_label?: string;
    /** The kind of AI it is ("Local AI (via edge bridge)"), a secondary hint
     *  beside the name. */
    provider_kind_label?: string;
  }>;
}

// ───────────────────────────── Edge channel seam ─────────────────────────────
// A workspace can have a live OUTBOUND connection from a user-run edge agent
// (the Cobblr edge-bridge dialing the cloud). The agent dials out and holds the
// pipe open, so the cloud reaches a device behind NAT / on a private network /
// tailnet WITHOUT that user exposing a public URL — the inverse of an SSRF-
// guarded fetch. Open core defines the registry + request/response contract;
// the hosted relay server (proprietary overlay) authenticates edge connections
// and registers them here. Consumers (e.g. the "Local AI via edge bridge"
// provider) route a request to a workspace's edge via send().
//
// The registry is keyed by orgId and lives in-process — single-instance only
// for now (the socket lives on whichever api process the agent dialed). Scaling
// out to multiple replicas needs a shared backplane; that swaps THIS impl while
// keeping the seam, so providers + the agent never change.

/** The HTTP methods a relayed call may use. */
export type EdgeMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";

/** Which of a bridge's lanes a call runs in. A bridge caps the slow lanes and
 *  keeps slots for printer status and control, so a burst of service or AI
 *  calls never makes the farm read offline. Unset: derived by `edgeLaneOf`. */
export type EdgeLane = "device" | "control" | "service" | "ai" | "sync";

/** No bridge is there to take the call: none set up, or offline. `message` is
 *  the sentence for the person (it names the bridge and what to check). */
export class EdgeOffline extends Error {
  readonly code = "edge_offline";
  readonly key: string;
  constructor(key: string, message: string) {
    super(message);
    this.name = "EdgeOffline";
    this.key = key;
  }
}

/** The bridge cannot do what the call needs (it has not reported the feature,
 *  usually because it has not updated itself yet). `feature` names it; a
 *  caller with an older way to do the same thing falls back to it. */
export class EdgeUnsupported extends Error {
  readonly code = "edge_unsupported";
  readonly key: string;
  readonly feature: string;
  constructor(key: string, feature: string, message: string) {
    super(message);
    this.name = "EdgeUnsupported";
    this.key = key;
    this.feature = feature;
  }
}

/** The bridge is online but the call got no answer within its time. */
export class EdgeTimeout extends Error {
  readonly code = "edge_timeout";
  readonly key: string;
  constructor(key: string, message: string) {
    super(message);
    this.name = "EdgeTimeout";
    this.key = key;
  }
}

/** A fetch-shaped call performed by a bridge on its own network. */
export interface EdgeFetchInit {
  privacy?: "personal" | "normal";
  /** The service's base URL on the bridge's network. The call is held to its origin. */
  baseUrl: string;
  path: string;
  method?: EdgeMethod;
  headers?: Record<string, string>;
  /** A JSON value, or a string sent as is. */
  body?: unknown;
  /** This hop's budget. The bridge stops the request to the service when it runs out. */
  timeoutMs?: number;
  lane?: EdgeLane;
  requiredFeatures?: readonly string[];
  /** Send this file as the request body, on the bridge's streamed file channel
   *  (no size limit, sha256 checked on the bridge before it is handed on). */
  bodyFile?: { path: string; sha256: string; size: number };
  /** The answer is a file: it comes back on the file channel, checked against
   *  the sha256 the bridge computed, and the Response body streams from disk.
   *  Its `x-cobblr-sha256` header carries the hash. */
  download?: boolean;
}

/** A relayed call's body or answer that is a file on the blob channel. */
export interface EdgeBlobRef {
  id: string;
  direction: "down" | "up";
  sha256?: string;
  size?: number;
}

export interface EdgeRequest {
  privacy?: "personal" | "normal";
  /** Path on the edge's local target, e.g. "/api/chat". */
  path: string;
  method?: EdgeMethod;
  body?: unknown;
  /** Per-request budget (ms). The relay rejects if the edge doesn't answer. */
  timeoutMs?: number;
  /** Dynamic-config edge bridge: the machine this call targets, carried WITH the
   *  request so the bridge configures the driver on the fly — no static
   *  BRIDGE_CONFIG, no restart. The bridge installs with just a token; machines
   *  are added in Cobblr and ride down with each call. Absent for the AI channel
   *  and for a statically-configured bridge. */
  instance?: { id: string; driver: string; config: Record<string, unknown> };
  /** Generic local-source proxy (sync connectors): instead of a driver, the
   *  bridge performs a plain HTTP request to `baseUrl + path` with `headers` and
   *  returns the result. Lets a hosted sync connector reach a LAN source (e.g.
   *  a private LAN system) over the dial-out relay — the cloud never touches the private
   *  address. Mutually exclusive with `instance`. */
  source?: { baseUrl: string; headers?: Record<string, string> };
  lane?: EdgeLane;
  /** The origin a source call is held to, checked on the bridge as well as here. */
  scope?: string;
  blob?: EdgeBlobRef;
  /** Send this file on the bridge's blob channel (a machine upload, a service
   *  input): `send` offers it, carries only its id, and withdraws the offer
   *  once answered. Throws EdgeUnsupported for a bridge without "blobs". */
  bodyFile?: { path: string; sha256: string; size: number };
}

export interface EdgeResponse {
  status: number;
  body: unknown;
  /** The response headers a caller acts on (content-type, content-length,
   *  etag, retry-after, last-modified), from a bridge that carries them. */
  headers?: Record<string, string>;
}

/** A live edge connection's send function — supplied by the hosted relay when
 *  an agent connects, removed (via the returned unregister fn) when it drops. */
export type EdgeChannelSender = (req: EdgeRequest) => Promise<EdgeResponse>;

/** One queued relay request as delivered to a polling bridge. */
export interface EdgeRelayItem {
  id: string;
  path: string;
  method: EdgeMethod;
  body?: unknown;
  instance?: EdgeRequest["instance"];
  source?: EdgeRequest["source"];
  /** The bridge's own deadline for this call, a little under Cobblr's wait so
   *  its answer (a 504 that says why) arrives before Cobblr gives up. */
  timeoutMs?: number;
  lane: EdgeLane;
  scope?: string;
  blob?: EdgeBlobRef;
}

/** A connected relay agent, as reported by the pane of glass. */
export interface EdgeAgentInfo {
  /** Named bridge id, or null for the workspace's default bridge. */
  bridge: string | null;
  last_seen_ms: number;
  queued: number;
  in_flight: number;
  /** A long-poll is parked = healthy idle bridge waiting for work. */
  parked: boolean;
}

/** A module that can attach things to an edge bridge. Registered at module api
 *  load; the generic Edge-bridges page renders one card per consumer, so the
 *  kernel page never hardcodes module names. */
export interface EdgeConsumer {
  /** The registering module's name — the page greys the card + offers Enable
   *  when the module isn't enabled in the viewing workspace. */
  module: string;
  label: string;
  description: string;
  /** In-app route where the attach/manage flow lives (e.g. "/digifab"). */
  href: string;
}

/** One of a workspace's bridges, as a person would recognise it. */
export interface EdgeBridgeRecord {
  /** Its channel id; null for the workspace's first (default) bridge. Never
   *  shown to a person: `name` is. */
  bridge: string | null;
  /** What a person calls it (the name typed when it was installed, or set
   *  since); null when it was installed before bridges had names. */
  name: string | null;
  connected: boolean;
  last_seen: string;
  first_seen: string;
  version: string | null;
  hostname: string | null;
  /** The addresses the bridge says it will reach (BRIDGE_ALLOW on the box);
   *  null when it reaches whatever the workspace points it at. */
  allowlist: string[] | null;
  /** Whether Cobblr knows the key it registers with, so it can be cut off. */
  can_disconnect: boolean;
}

export interface PlatformEdge {
  /** Hosted relay: register a live channel for a workspace. Returns an
   *  unregister fn. One channel per workspace — a newer connection replaces an
   *  older one (the relay reaps the stale socket). */
  registerChannel(orgId: string, send: EdgeChannelSender): () => void;
  /** Is there a live edge channel for this workspace right now? */
  /** Async: presence is shared state in cobblr_meta, not this process's memory,
   *  so any api process can answer for any bridge. */
  hasChannel(key: string): Promise<boolean>;
  /** Send a request to the workspace's edge; rejects if none is connected. */
  send(orgId: string, req: EdgeRequest): Promise<EdgeResponse>;
  /** Fetch-shaped call to a service on a bridge's network: the bridge performs
   *  `baseUrl + path` there and the answer comes back as a Response, with its
   *  status, body and headers. Throws `EdgeOffline` when no bridge is there to
   *  take it (after one short retry across a bridge's poll gap) and
   *  `EdgeTimeout` when the bridge took it and nothing came back in time. Every
   *  module that reaches a LAN service through a bridge goes through here. */
  fetch(key: string, init: EdgeFetchInit): Promise<Response>;
  /** The bridge's file channel, GET/HEAD/PUT <relay>/blobs/:id, for the bridge
   *  whose channel is `key`. Every relay door mounts this one handler. */
  serveBlob(key: string, id: string, req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<void>;

  // ── HTTP relay primitives — the queue mechanics behind the dial-out tunnel.
  // The kernel owns the state; routers (the kernel /orgs/:slug/edge wire and
  // any module-mounted legacy alias) are thin HTTP shims over these, so every
  // path lands on the SAME channels and modules stay isolated. Keys follow
  // edgeChannelKey: `orgId` for the default bridge, `orgId::<name>` for a
  // named one, or a bare userId for a personal (account-scoped) agent.

  /** Announce/refresh a bridge: registers the channel on first touch and
   *  bumps its liveness clock. At /register the bridge's own report rides
   *  along (its version and machine, and the token it installed with, whose
   *  name becomes the bridge's first name). */
  relayTouch(key: string, report?: { version?: string | null; hostname?: string | null; tokenId?: string | null; allow?: string[] | null; features?: string[] | null }): Promise<void>;
  /** Every bridge this workspace has, online or not, by the name a person
   *  recognises. */
  listBridges(orgId: string): Promise<EdgeBridgeRecord[]>;
  /** Rename a bridge; false when this workspace has no such bridge. */
  renameBridge(orgId: string, bridge: string | null, name: string): Promise<boolean>;
  /** Revoke the key a bridge registers with and remove it; null when the
   *  workspace has no such bridge. */
  disconnectBridge(orgId: string, bridge: string | null): Promise<{ alsoCut: string[] } | null>;
  /** Long-poll for the next queued request; resolves null on keep-alive
   *  timeout or when the poller hangs up (pass an abort signal). */
  relayPoll(key: string, opts?: { signal?: AbortSignal; lanes?: EdgeLane[] | null }): Promise<EdgeRelayItem | null>;
  /** Deliver a polled request's result. Returns false if the id is unknown
   *  (already timed out). */
  relayRespond(key: string, r: { id: string; status: number; body?: unknown; headers?: Record<string, string> }): Promise<boolean>;
  /** Connected agents for a workspace (default + named bridges). */
  relayAgents(orgId: string): Promise<EdgeAgentInfo[]>;
  /** One bridge's liveness — `bridge` null = the default channel. */
  relayInfo(orgId: string, bridge?: string | null): Promise<{ connected: boolean; last_seen: number | null }>;

  // ── Consumer registry — modules declare "I can use a bridge" here.
  registerConsumer(c: EdgeConsumer): void;
  listConsumers(): EdgeConsumer[];

  // ── Bridge release — the self-update artifact the bridge downloads.
  getRelease(): { version: string; sha256: string };
  getReleaseBundle(): string;
  /** Registry-free bootstrap: a stock node image fetches this loader from
   *  /release/loader and runs it — it pulls the bundle and self-updates. */
  getReleaseLoader(): string;
}

/** One provider a user can connect under /me/connections — their own key, or
 *  a service of theirs a bridge reaches. `kind` groups providers by what they
 *  are FOR ("ai-provider", "tracking"); a consumer resolves by kind and never
 *  needs to know which providers exist. */
export interface ConnectionProviderDef {
  id: string;
  kind: string;
  label: string;
  /** The fields to ask for. `secret: true` is write-only — stored encrypted and
   *  never returned, so the edit form shows "set" rather than the value. */
  credentials: Record<string, { label: string; secret: boolean; format?: "uri"; choices?: Array<{ value: string; label: string }> }>;
  /** Position in the picker; lower first, and FIRST IS THE DEFAULT. Optional:
   *  unranked providers sort after the ranked ones in registration order. */
  rank?: number;
  /** One line under the picker, for a kind whose purpose isn't self-evident. */
  blurb?: string;
  /** What Remove changes and what it deliberately leaves alone. The generic
   *  connections page says both before deleting the credential, so a provider
   *  with durable links or copied data can describe their different fates. */
  disconnect?: {
    stops: string;
    keeps: string;
  };
  /** A provider whose credentials come from a consent screen, not a form: a
   *  mailbox, a calendar, anything OAuth. The page renders a Connect button
   *  that opens `start` (a route of the provider's own, which redirects to
   *  the consent screen and stores the grant on the way back); the typed
   *  credential fields are the non-secret ones the card may edit afterwards
   *  (an allowlist, a label), never the grant itself. */
  connect?: {
    kind: "oauth";
    /** API path the Connect button posts to with `{ org_id }`; answers `{ url }`. */
    start: string;
  };
  /** Called with the decrypted credentials before a connection of this
   *  provider is deleted, so a grant is revoked at its issuer and not merely
   *  forgotten here. A failure is logged and the delete proceeds: the
   *  person asked for it gone, and a revoke that cannot reach its issuer is
   *  not a reason to keep the secret. */
  onDelete?: (credentials: Record<string, unknown>) => Promise<void>;
  /** The cheapest call that says whether these credentials work: what a save
   *  and the Test button run, and what becomes the connection's verification
   *  (connection-verification.ts). A kind without one is saved "unverified"
   *  and says so. Credentials arrive decrypted, with `__connection_user_id`
   *  (the owner) so a bridge transit reaches their own bridge. */
  testConnection?: (credentials: Record<string, unknown>, ctx: ConnectionTestContext) => Promise<AiConnectionTest>;
  /** The capability ids this connection can be ranked for, per workspace
   *  ("who does what, in order"). Absent: the kind is ranked only as a whole. */
  capabilities?: (credentials: Record<string, unknown>, ctx: ConnectionTestContext) => Promise<string[]>;
  /** This definition answers for EVERY connection of its kind whose
   *  provider_id no other definition claims (or every one the predicate
   *  accepts). A service is named by its own manifest id, which nobody can
   *  register ahead of time. */
  anyProviderOfKind?: boolean | ((providerId: string) => boolean);
  /** Turn what a person typed into the connection that is stored, before it
   *  is probed or saved: a service reads its manifest here, refuses one that
   *  does not validate (naming the field), and is stored under the manifest's
   *  own id. Also what the form's preview shows. Absent: stored as typed. */
  prepare?: (credentials: Record<string, unknown>, ctx: ConnectionTestContext) => Promise<PreparedConnection>;
}

/** What `ConnectionProviderDef.prepare` made of a connection being added. */
export type PreparedConnection =
  | {
      ok: true;
      /** The provider_id to store (a service: its manifest id). */
      providerId: string;
      /** A label to use when the person gave none. */
      label?: string;
      /** The credentials to probe and store. */
      credentials: Record<string, unknown>;
      /** What the form shows before saving (a service: its name and capabilities). */
      preview?: unknown;
      /** Run once the connection has an id (a service caches its manifest). */
      afterSave?: (credentialId: string) => Promise<void>;
    }
  | {
      ok: false;
      /** 400 for something the person can fix, 502 for a service that did not answer. */
      status: 400 | 502;
      code: string;
      message: string;
      details?: unknown;
    };

/** Who a test or a capability read is for. */
export interface ConnectionTestContext {
  /** The person the connection belongs to. */
  userId: string;
  /** The stored connection, when it is one; absent for credentials being typed. */
  credentialId?: string;
}

/** A personal connection that applies to a call, with the secret decrypted. */
export interface ResolvedConnection {
  credentialId: string;
  providerId: string;
  credentials: Record<string, unknown>;
  label: string;
  /** The user who OWNS this connection. A personal bridge is keyed by user, so
   *  this is what routes a call down THEIR tunnel — even when the caller is
   *  someone else (a shared connection) or nobody (a sweep). */
  ownerUserId: string;
}

/** Personal (user-scoped) connections: a credential its USER owns and routes to
 *  workspaces, rather than one a workspace owns.
 *
 *  AI was the first kind and for a while the only one, so the surface hardcoded
 *  it. Nothing about the routing, the share-approval flow or the precedence
 *  rules was ever AI-specific — so a second kind is a registration, not a
 *  second copy of any of it. */
export interface PlatformConnections {
  /** Offer a provider under /me/connections. Call at module load. */
  registerProvider(p: ConnectionProviderDef): void;
  listProviders(kind?: string): ConnectionProviderDef[];
  getProvider(id: string): ConnectionProviderDef | null;
  /** The connection that applies to (workspace, caller) for this kind, or null
   *  when the user has connected nothing — in which case the caller falls back
   *  to whatever the workspace itself is configured with.
   *
   *  Precedence is the caller's OWN connection first, then one shared into the
   *  workspace and approved by its owner. */
  resolve(kind: string, orgId: string, callerUserId: string | null): Promise<ResolvedConnection | null>;
  /** The connections of this kind routed INTO the workspace, so a workspace
   *  surface can CHOOSE between them. Distinct from resolve(), which answers
   *  "which one serves this call" - this answers "which ones may it name". */
  routedTo(kind: string, orgId: string): Promise<RoutedConnectionSummary[]>;
  /** Run the provider's own probe on these credentials. A provider with no
   *  probe answers `{ ok: true, note }`: nothing was checked, and it says so. */
  testConnection(providerId: string, kind: string | null, credentials: Record<string, unknown>, ctx: ConnectionTestContext): Promise<AiConnectionTest>;
  /** The capability ids a stored connection can be ranked for, from its
   *  provider; [] for a kind ranked only as a whole. */
  capabilities(credentialId: string): Promise<string[]>;
  /** A connection made for a workspace with no person at the form (a heal
   *  moving an older store onto connections). It belongs to the workspace's
   *  first owner, shared into that workspace and live there when nothing of
   *  its kind is, exactly as the owner sharing it themselves would be. Saved
   *  unverified, never probed: a heal must not fail on a device that is off
   *  right now. Idempotent on `originKey`: again, it returns the same one. */
  createWorkspaceConnection(input: {
    orgId: string;
    kind: string;
    providerId: string;
    label: string;
    credentials: Record<string, unknown>;
    originKey: string;
    note?: string;
  }): Promise<{ credentialId: string; created: boolean }>;
}

/** One connection a workspace may name, from PlatformConnections.routedTo. */
export interface RoutedConnectionSummary {
  credentialId: string;
  providerId: string;
  label: string;
  ownerUserId: string;
  approved: boolean;
  active: boolean;
}

/** The single per-tenant egress policy every external-HTTP path routes through —
 *  consistent SSRF posture across sync connectors, device drivers, webhooks, and
 *  module polls (replaces the historic divergent per-module guards). */
export interface PlatformEgress {
  /** SSRF-guarded outbound fetch for a tenant. Link-local/metadata is always
   *  blocked. On a HOSTED instance (COBBLR_HOSTED=true) a private/internal target
   *  is blocked UNLESS a registered allow-provider permits it for this org (the
   *  tenant's own registered edge endpoint); a self-hosted instance allows LAN.
   *  `redirect: "manual"` hands back each redirect, still validated, for a
   *  caller that walks the chain itself carrying a cookie. */
  guardedFetch(orgId: string, input: string | URL | Request, init?: RequestInit): Promise<Response>;
  /** Register a per-tenant allow-provider — e.g. the edge module exposing the
   *  org's registered bridge endpoints. Returns true to permit a private target. */
  registerAllow(provider: (orgId: string, ip: string, url: URL) => boolean | Promise<boolean>): void;
}

/** Cross-tenant key/value cache in cobblr_meta. For data that is the SAME for
 *  every workspace and is NOT tenant-private — public catalog lookups are the
 *  motivating case: a UPC resolves to the same product for everyone, so on a
 *  multi-tenant host you want to resolve each barcode ONCE globally instead of
 *  re-spending a shared rate-limited API quota per tenant. Never put
 *  tenant-identifying or tenant-private data here. */
export interface PlatformSharedCache {
  /** The stored JSON value, or null if absent or expired. */
  get<T = unknown>(namespace: string, key: string): Promise<T | null>;
  /** Upsert a value. `ttlSeconds` omitted ⇒ never expires (stable reference
   *  data like a resolved product). */
  put(namespace: string, key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  /**
   * Forget a key.
   *
   * There was no way to do this — which is a real gap for a cache shared across
   * EVERY workspace. When an entry turns out to be wrong, the only options were to
   * overwrite it with another guess, or leave it poisoning everyone.
   *
   * Eviction is the honest third option: "we no longer believe this." It's what a
   * disproved barcode resolution needs — drop it, let the next scan take a fresh
   * look, and route the correction through the reviewable channel rather than
   * silently making one workspace's photo into the whole instance's truth.
   */
  del(namespace: string, key: string): Promise<void>;
}

export interface PlatformQueue {
  enqueue(p: {
    orgId: string;
    queue: string;
    payload?: Record<string, unknown>;
    runAt?: Date;
    maxAttempts?: number;
    /** What this job is: while one with the same key on the same queue is
     *  queued or running, enqueueing again returns it instead of a second. */
    idempotencyKey?: string;
  }): Promise<string>;
  registerWorker(
    queue: string,
    handler: (job: {
      id: string;
      orgId: string;
      payload: Record<string, unknown>;
      attempts: number;
    }) => Promise<void> | void,
  ): void;
  /** "Does this org already have a non-finished job on this queue?"
   *  Returns the set of org_ids (out of the input set) that have at
   *  least one job in the given statuses on the named queue. Used
   *  by recurring-job seeders to avoid double-queuing on boot — a
   *  cleaner replacement for hand-rolled `SELECT … FROM
   *  core_queue_jobs` against another module's tables. */
  hasPendingJob(args: {
    orgIds: string[];
    queue: string;
    statuses?: Array<"queued" | "running" | "done" | "failed">;
  }): Promise<Set<string>>;
}

/** Authorization helpers exposed to modules. Today only one: a
 *  user-has-capability check for per-action grants. Modules that
 *  want a route gated by a specific verb (e.g. `inventory:create-
 *  part`) ask `platform().auth.userHasCapability(...)`. Admins/owners
 *  pass implicitly; members/guests need an explicit grant in
 *  workspace_capability_grants. See
 *  docs/modules/member-portal-and-permissions.md. */
export interface PlatformAuth {
  /** Checks workspace membership against the same ranked roles as REST guards. */
  userHasRole(args: { orgId: string; userId: string; minRole: import("./org-roles.js").OrgRoleName }): Promise<boolean>;
  userHasCapability(args: {
    orgId: string;
    userId: string;
    role: string;
    actionId: string;
  }): Promise<boolean>;
  /** The refusal, explained: what `userHasCapability` said no to, in words,
   *  with whether asking is a remedy for this person and who would decide.
   *  A capability gate puts this on its 403 as `error.blocked`, so the one
   *  blocked-action sheet in the app can offer the ask (blocked-action.ts).
   *  Kernel-owned; a module never writes its own refusal sentence. */
  describeBlockedCapability(args: {
    orgId: string;
    userId: string;
    role: string;
    actionId: string;
  }): Promise<BlockedAction>;
  /** The same explanation for any set of remedies: a table in an app that is
   *  off (`module`), a bundle to install (`install`), a capability. For a
   *  refusal that is not a capability gate, so it still carries the ask
   *  instead of a dead end (#3610). */
  describeBlock(args: {
    orgId: string;
    userId: string;
    role: string;
    remedies: ReadonlyArray<{ kind: "capability" | "install" | "module"; key: string }>;
    doing?: string;
  }): Promise<BlockedAction>;
  /** Mint a SHORT-LIVED, capability-scoped token carrying `userId`'s
   *  own identity + an `app:<slug>` audience (H1 Tier B). It verifies
   *  as a normal session, so it acts AS the member — bounded by their
   *  capabilities + field-read-scope; it can never exceed them. The
   *  App Player uses it to mediate reads for a sandboxed custom
   *  frontend, so the untrusted bundle never holds the real session. */
  mintAppToken(args: {
    userId: string;
    appSlug: string;
  }): Promise<{ token: string; expires_in: number }>;
  /** Mint a NORMAL member session JWT for `userId` — a full session (NOT
   *  app-scoped), as if they had logged in. For TRUSTED in-process callers that
   *  have already authenticated a real member through another channel and need
   *  to act AS them against the internal API: an inbound integration (a verified
   *  Slack message, a forwarded receipt email) routing a capture into the
   *  member's workspace. Mirrors what core's receipt-ingest does directly; this
   *  seam exposes it to the trusted overlay. In-process only (platform seams are
   *  never HTTP-reachable); the resulting session is still bounded by the
   *  member's role + capabilities at every endpoint it hits. */
  mintSession(args: { userId: string }): Promise<string>;
  /** How the CURRENT request was made: its auth method, how it acts (the
   *  in-app assistant, an assistant over MCP) and the API token's name. For a
   *  door that records who added a thing (the inbox's "Added by Claude").
   *  Null outside a request. */
  requestSource(): Promise<{ auth_method: "session" | "api_token" | "system"; via: string | null; token_name: string | null } | null>;
  /** Register the platform-level auth-email sender (verify / reset / magic
   *  link). A self-hoster wires their own; the overlay injects a managed
   *  sender. Open core registers none — magic-link falls back to the inline
   *  dev link, reset to admin-managed. A sender the instance configured
   *  itself (COBBLR_AUTH_EMAIL_PROVIDER) is not replaced by an overlay's unless
   *  COBBLR_AUTH_EMAIL_ALLOW_OVERRIDE=true; any replacement is logged with both
   *  names. `name` labels this sender in that log and in /auth/config. */
  registerEmailSender(sender: AuthEmailSender, opts?: { name?: string }): void;
  /** True if an auth-email sender is registered (so the auth routes know
   *  whether real delivery is available vs. the dev-link fallback). */
  hasEmailSender(): boolean;
  /** Deliver an auth email through the registered sender. No-op (returns
   *  false) if none is registered. */
  sendEmail(msg: AuthEmailMessage): Promise<boolean>;
}

/** Reads + writes against entity_pairings, the polymorphic
 *  relationship table. Modules use this instead of SELECTing the
 *  table directly so we have one chokepoint for org-scoping +
 *  validation. See B1 in 2026-05-25-audit.md. */
/** A polymorphic entity reference — `(kind, id)`. Used by placement (and
 *  handy anywhere a bare "which entity" pointer is needed without the full
 *  ResolvedEntity). */
export interface EntityRef {
  kind: string;
  id: string;
}

/** Placement — the platform containment primitive
 *  (docs/design-decisions/placement-and-containment.md). "A containee lives
 *  inside a container." One relationship for the whole platform: a part
 *  installed in a machine, a component in a server (asset), an item filed into a
 *  location — a Location is just one KIND of container. Org-scoped; the caller
 *  passes orgId.
 *
 *  Invariants enforced here (not the schema): a containee is in AT MOST ONE
 *  container (`place` upserts); `place` is trait-gated (container must be
 *  physical / `canContain`, containee `canBeContained`) and rejects a placement
 *  that would form a containment cycle. */
/** Where a thing sits inside its container, in millimetres from the
 *  container's top-left corner (a pin on a floor plan or a shelf drawing). */
export interface PlacementPosition {
  x_mm: number;
  y_mm: number;
}

export interface PlacementExpectation {
  container: EntityRef | null;
  slot?: string | null;
  position?: PlacementPosition | null;
}

export interface PlatformPlacement {
  /** Database expressions for a grouped list's reserved room and stock values.
   *  Canonicalizes the kind before reading placement; no records leave SQL. */
  groupValues(args: { orgId: string; kind: string }): Promise<Pick<GroupPlan, "values" | "numbers">>;
  /** Put `containee` inside `container` (moving it if already placed). Throws on
   *  a self-placement, an ineligible kind, or a cycle.
   *
   *  `position` pins it inside the container. Moving to ANOTHER container
   *  without one drops the old pin (it measured a different room); placing in
   *  the same container without one keeps it; `null` clears it.
   *  `via` says what moved it ("floor plan"), and makes the move an activity
   *  row on the thing, in the person's words. */
  place(args: {
    expected?: PlacementExpectation;
    /** Keep this record distinct for a durable undo journal. */
    preserveIdentity?: boolean;
    orgId: string;
    containee: EntityRef;
    container: EntityRef;
    slot?: string | null;
    placedBy?: string | null;
    position?: PlacementPosition | null;
    via?: string;
    /** The slot holds one thing (a printer's filament slot): whatever is
     *  already in `slot` of this container goes back where it came from, or
     *  out of the container when it came from nowhere. Needs a `slot`. */
    oneToASlot?: boolean;
    /** Put only this many in (2 of 4 sticks). The kind's module splits the
     *  record (registerQuantity) and the part placed is a record of its own;
     *  without a registered quantity the whole thing goes in. Refused when
     *  there are fewer than that. */
    qty?: number;
  }): Promise<void | {
    displaced: Array<EntityRef & { to: EntityRef | null }>;
    /** The record that ended up inside: the one asked, a split-off part of it,
     *  or the record it joined there. */
    placed?: EntityRef;
  }>;
  /** Send a thing back to the container it was in before its current one
   *  (a spool off a printer, back to its shelf); out of its container when
   *  there is no such place. Resolves with where it went. */
  returnHome(args: { orgId: string; containee: EntityRef; placedBy?: string | null; via?: string }): Promise<(EntityRef & { placed?: EntityRef }) | null>;
  /** Take `containee` out of whatever container it's in (no-op if unplaced). */
  remove(args: { orgId: string; containee: EntityRef; expected?: PlacementExpectation }): Promise<void>;
  /** The container a containee currently lives in, or null. */
  containerOf(args: { orgId: string; containee: EntityRef }): Promise<EntityRef | null>;
  /** Everything directly inside a container (one level; not recursive), with
   *  its slot and pin where it has them. */
  contents(args: { orgId: string; container: EntityRef }): Promise<Array<EntityRef & { slot?: string | null; position?: PlacementPosition | null }>>;
  /** Where each thing is, innermost first: its container, that container's
   *  container, up to the top, each with its name. A thing in a Backpack that
   *  sits in a Desk drawer reads [Backpack, Desk drawer, ...]. Empty for a
   *  thing that is nowhere. Follows placement for any container, and a kind's
   *  registered parent where its nesting lives elsewhere (a place inside a
   *  place). One answer per containee, keyed `kind:id` as asked. */
  pathsOf(args: { orgId: string; containees: EntityRef[] }): Promise<Map<string, PlacePathStep[]>>;
  /** Every record holding something now that is not a place by nature (its
   *  kind's traits do not make it a container): a Backpack, a toolbox. What a
   *  place picker offers beside the places, with how many things each holds.
   *  includePlaces also returns natural containers for occupancy checks. */
  holders(args: { orgId: string; includePlaces?: boolean }): Promise<Array<EntityRef & { holds: number }>>;
  /** How a container kind knows its own parent, when that nesting is not a
   *  placement (a Location's parent place). The kind's own module registers it. */
  registerParent(kind: string, parentOf: (orgId: string, id: string) => Promise<EntityRef | null>): void;
  /** A kind counted in quantities says how to split some off and how two of
   *  its records in one container become one again. place({qty}) splits;
   *  every place() settles, so two sticks installed one at a time are one row
   *  inside the computer, and a part taken out to the shelf it came from joins
   *  the spares there. */
  registerQuantity(kind: string, quantity: PlacementQuantity): void;
  /** What one record of a kind is worth, in the workspace's currency. Given
   *  ids, those; given "all", every active record of the kind that counts,
   *  including unpriced records with null. Empty holdings are left out. */
  registerValue(
    kind: string,
    valueOf: (orgId: string, ids: string[] | "all") => Promise<Map<string, number | null | DatedMoney>>,
    /** The capability a viewer needs to see these values (a part's value
     *  reveals its cost). A viewer without it gets them withheld, said so. */
    opts?: { readScope?: string; insuranceDetails?: (orgId: string, ids: string[]) => Promise<Map<string, { serial?: string | null; date?: string | null }>> },
  ): void;
  /** Private serial/date fields for a kind with no value provider. Read
   *  only for insurance exports by a viewer allowed to see costs. */
  registerInsuranceDetails(kind: string, reader: (orgId: string, ids: string[]) => Promise<Map<string, { serial?: string | null; date?: string | null }>>): void;
  /** A thing built from parts: its own value (what is not itemized), what is
   *  installed in it (and in those, all the way down) and the total. Each
   *  part counted once. `other` is null when its kind keeps no value. */
  builtValue(args: { orgId: string; container: EntityRef; viewer?: ValueViewer }): Promise<BuiltValue>;
  /** What everything is worth, each record counted once: the workspace, or
   *  only what is in `within` at any depth. A computer's installed parts count
   *  as themselves, never again inside the computer's own value. */
  worth(args: { orgId: string; within?: EntityRef | null; viewer?: ValueViewer; insurance?: boolean }): Promise<PlacementWorth>;
  /** What a kind calls the things inside one of its records ("Parts" for a
   *  computer, "In the bag" for a backpack): the workspace's word, else a
   *  bundle's, else null (say "Contents"). Per kind, a collection's kind
   *  (`<instance>:item`) keeping its own. */
  contentsWord(args: { orgId: string; kind: string }): Promise<ContentsWord>;
  /** Set the workspace's word for a kind; null puts the default back. A
   *  bundle update never changes it. */
  setContentsWord(args: { orgId: string; kind: string; word: string | null }): Promise<ContentsWord>;
}

export interface PlacementWorth {
  currency?: string;
  excluded?: Record<string, number>;
  conversions?: import("@cobblr/platform-contract/money").MoneyConversion[];
  total: number;
  records: number;
  unpriced: number;
  withheld: boolean;
  items: Array<EntityRef & { value: number | null; serial?: string | null; date?: string | null }>;
}

/** A kind's word for what is inside its records (placement.contentsWord). */
export interface ContentsWord {
  /** The word to show: the workspace's, else the bundle's; null means "Contents". */
  word: string | null;
  /** The workspace's own word, when it set one. */
  custom: string | null;
  /** The bundle's word, when one declared it. */
  default_word: string | null;
}

/** The word, ready to show: the kind's, else "Contents". */
export function contentsWordText(w: Pick<ContentsWord, "word"> | null | undefined): string {
  return w?.word?.trim() || "Contents";
}

/** Who is asking for values: a kind whose values need a capability is
 *  withheld from a viewer without it. Absent = the system, who sees all. */
export interface ValueViewer {
  userId: string;
  /** Their role here; looked up when absent (an action knows only the person). */
  role?: string;
}

/** How a kind counted in quantities splits and rejoins (registerQuantity). */
export interface PlacementQuantity {
  /** How many this record stands for, or null when it is not counted. */
  quantityOf(orgId: string, id: string): Promise<number | null>;
  /** Take `qty` off this record into a new one of the same thing, still where
   *  this one is. Resolves with the new record's id. */
  split(args: { orgId: string; id: string; qty: number; userId: string | null }): Promise<string>;
  /** This record has just been put in `container`: when the same thing is
   *  already there as another record, make them one. Resolves with the id of
   *  the record that remains. */
  settle(args: { orgId: string; id: string; container: EntityRef; userId: string | null }): Promise<string>;
}

/** One part of a thing built from parts. */
export interface BuiltPart extends EntityRef {
  name: string;
  /** How many, for a counted kind. */
  qty: number | null;
  /** The part's own value, null when its kind keeps none. */
  value: number | null;
  /** What is installed in this part in turn, counted into `value_total`. */
  built: number;
  /** value + built. */
  value_total: number;
}

export interface BuiltValue {
  currency?: string;
  excluded?: Record<string, number>;
  conversions?: import("@cobblr/platform-contract/money").MoneyConversion[];
  /** The thing's own value: what is not itemized. Null when its kind keeps none. */
  other: number | null;
  parts: BuiltPart[];
  /** The parts, all the way down. */
  built: number;
  /** other + built. */
  total: number;
  /** Some values were not shown to this viewer (a part's cost), so the
   *  total leaves them out. */
  withheld: boolean;
  /** What this thing's kind calls its parts ("Parts"), or null for "Contents". */
  word: string | null;
}

/** Inside a thing tracked one by one that is not a place: an asset, a machine.
 *  That is installed, not on hand. A box, a bin, a stock record used as a
 *  container, or a place, keeps what is in it on hand. Read from the
 *  container kind's resolved traits, so a new kind follows on its own. */
export function isInstallHolder(traits: Record<string, unknown> | null | undefined): boolean {
  const axis = (k: string): string | null => {
    const v = traits?.[k];
    if (typeof v === "string") return v;
    const t = (v as { trait?: unknown } | null | undefined)?.trait;
    return typeof t === "string" ? t : null;
  };
  return axis("tangibility") === "physical" && axis("identity") === "unique" && axis("containment") !== "container";
}

/** For each of these rows of a kind, the thing it is installed in (the first
 *  step of its path, when that is an install holder), or nothing. */
export async function installedIn(orgId: string, kind: string, ids: string[]): Promise<Map<string, PlacePathStep>> {
  const out = new Map<string, PlacePathStep>();
  if (!ids.length) return out;
  const paths = await platform().placement.pathsOf({ orgId, containees: ids.map((id) => ({ kind, id })) });
  const holder = new Map<string, boolean>();
  for (const id of ids) {
    const first = paths.get(`${kind}:${id}`)?.[0];
    if (!first) continue;
    if (!holder.has(first.kind)) {
      const rec = await Promise.resolve(platform().entities.getKind(first.kind)).catch(() => null);
      holder.set(first.kind, isInstallHolder((rec?.traits ?? null) as Record<string, unknown> | null));
    }
    if (holder.get(first.kind)) out.set(id, first);
  }
  return out;
}

/** One step of where a thing is: the container, and what it is called. */
export interface PlacePathStep extends EntityRef {
  name: string;
}

/** Where a thing is, as a person reads it: "Backpack, in Desk drawer". The
 *  one wording every surface uses, so a list, a record and a search agree. */
export function placeLine(path: ReadonlyArray<{ name: string }>): string {
  return path.map((p) => p.name).join(", in ");
}

/** Where each of these records is when it is not in a place of its own but
 *  inside another thing (headphones in a Backpack that sits in a Desk
 *  drawer), as a line: "Backpack, in Desk drawer". location_id only ever
 *  names a place, so a thing put inside a record read "No place set"
 *  everywhere a place is shown. Records with a place, or in nothing, are
 *  absent from the map. One rule for every module that shows a place. */
export async function heldInLines(
  orgId: string,
  kind: string,
  rows: ReadonlyArray<{ id: string; location_id?: string | null }>,
): Promise<Map<string, string>> {
  const ids = rows.filter((r) => !r.location_id).map((r) => r.id);
  const out = new Map<string, string>();
  if (!ids.length) return out;
  try {
    const paths = await platform().placement.pathsOf({ orgId, containees: ids.map((id) => ({ kind, id })) });
    for (const id of ids) {
      const path = paths.get(`${kind}:${id}`) ?? [];
      if (path.length) out.set(id, placeLine(path));
    }
  } catch (err) {
    console.warn(`[${kind}] where-it-is read failed:`, (err as Error).message);
  }
  return out;
}

/** Where each of these records is, by name, for a resolver's location_name:
 *  its place's name, or what it is inside and where that is ("Backpack, in
 *  Desk drawer"). One batched lookup for the places, one placement read for
 *  the rest. A name is a nicety, so a failed read leaves the id to speak. */
export async function placeNames(
  orgId: string,
  kind: string,
  rows: ReadonlyArray<{ id: string; location_id?: string | null }>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(rows.map((r) => r.location_id).filter((id): id is string => !!id))];
  if (ids.length) {
    try {
      const found = await platform().entities.lookupMany(orgId, ids.map((id) => ({ kind: "core-locations:location", id })));
      const byId = new Map(found.map((l) => [l.id, l.title]));
      for (const r of rows) if (r.location_id && byId.has(r.location_id)) out.set(r.id, byId.get(r.location_id)!);
    } catch {
      /* the id is still there */
    }
  }
  for (const [id, line] of await heldInLines(orgId, kind, rows)) out.set(id, line);
  return out;
}

/** Resolved records with `fields.location_name` set from placeNames, for a
 *  resolver whose rows carry location_id among their fields. */
export async function withPlaceNames(orgId: string, kind: string, items: ResolvedEntity[]): Promise<ResolvedEntity[]> {
  if (!items.length) return items;
  const names = await placeNames(
    orgId,
    kind,
    items.map((e) => ({ id: e.id, location_id: typeof e.fields?.location_id === "string" ? e.fields.location_id : null })),
  );
  return items.map((e) => ({ ...e, fields: { ...e.fields, location_name: names.get(e.id) ?? null } }));
}

/** Fields as a platform seam, for a module that owns a field a bundle
 *  declared and has folded into another: `retire` removes that field's
 *  definition from one kind (values already recorded stay on the records, as
 *  a hand-removed field's do). The one door so a module never reaches the
 *  field-def table itself. Resolves with how many definitions went. */
export interface PlatformFields {
  retire(args: { orgId: string; kind: string; name: string }): Promise<number>;
  /** The names of a kind's fields that carry `role` (its own and the ones a
   *  trait scope puts on it, "@physical"), so a module reads a meaning
   *  without guessing a field's name: a thing's outer size, say. */
  withRole(args: { orgId: string; kind: string; role: FieldRole }): Promise<string[]>;
}

/** Tags as a platform seam. core-tags OWNS the tables and the HTTP surface;
 *  this is the in-process way for a background writer with no request bearer
 *  (the sync engine) to attach a tag to an entity it just wrote, without
 *  reaching into core-tags' tables or looping through HTTP. Attach-by-name,
 *  created on first use, idempotent on (tag, entity). Org-scoped; the caller
 *  passes orgId. `target.kind` is "<module>:<type>", the same spelling the
 *  entity-kind registry uses. */
export interface PlatformTags {
  /** Attach `tagName` to `target`, creating the tag if it does not exist.
   *  `created` says whether a NEW assignment was made (false = already there);
   *  `tagCreated` whether the tag itself is new, so an undo knows whether the
   *  tag is its to take away. */
  attach(args: { orgId: string; tagName: string; target: EntityRef }): Promise<{ tagId: string; created: boolean; tagCreated?: boolean }>;
  /** Take a tag away when nothing carries it: the inverse of the create inside
   *  `attach`, for an undo. A tag still on anything stays. */
  withdraw(args: { orgId: string; tagName: string }): Promise<"withdrawn" | "in-use" | "absent">;
  /** Remove `tagName` from `target`. No-op if absent; never deletes the tag. */
  detach(args: { orgId: string; tagName: string; target: EntityRef }): Promise<void>;
  /** The tag names on `target`. */
  of(args: { orgId: string; target: EntityRef }): Promise<string[]>;
}

/** Where a kind's grouping axis is stored, and so where a chosen value goes.
 *
 *  The discriminator lives HERE and nowhere else: a caller ranks against
 *  `values`, presses `commit`, and applies what comes back. Nothing outside
 *  this seam asks which storage a kind uses, which is the whole point of it
 *  (#3223: a value written to one store is invisible to the feature reading
 *  the other). */
export type CategoryAxisSlot =
  /** A custom field def on the kind; the value is the label itself. */
  | { kind: "extras"; name: string; defId: string }
  /** A column on the record pointing at the module's own taxonomy; the value
   *  written is a record id, never the label. */
  | { kind: "native"; column: string; entityKind: string }
  /** A native text field on the record (a kind's `categoryField`); the value
   *  is the label itself. */
  | { kind: "field"; column: string };

export interface CategoryAxis {
  /** What to call it on screen ("Category", "Scan category"). */
  label: string;
  /** What to RANK against: every value the store holds now, deduplicated by
   *  `normaliseCategory` so one key never appears twice.
   *
   *  NOT "what exists": a caller may rank against this list PLUS proposals of
   *  its own that are in no store yet (the scan batch's sibling proposals,
   *  which is what stops five monitors in one run becoming three categories).
   *  `commit` therefore has to accept a value that was never in this list. */
  values: string[];
  /** Where a chosen value is written. */
  slot: CategoryAxisSlot;
}

/** What to write for a chosen value, or null when there is nothing to write.
 *  `value` is the label for an `extras` slot and a record id for a `native`
 *  one, which is why a caller must apply it through `applyAxisValue` rather
 *  than reading the slot itself. */
export interface CategoryAxisAssignment {
  slot: CategoryAxisSlot;
  value: string;
}

export interface PlatformCategoryAxis {
  /** The axis for a kind, or null when it has none.
   *
   *  Memoised briefly per (org, kind, instance): a menu assembly asks once per
   *  kind per row, and a native read is a taxonomy listing rather than a column
   *  on a def. `commit` invalidates the entry it grew, so a value confirmed a
   *  moment ago is in the next caller's `values`. */
  for(args: { orgId: string; kind: string; instance?: string | null }): Promise<CategoryAxis | null>;
  /** Grow the vocabulary if this value is new, and return what to write.
   *
   *  NEVER throws and never fails the operation that called it: a value that
   *  cannot be stored (the kind has no axis, the taxonomy refuses the create,
   *  the value normalises to nothing) comes back as null and is dropped, which
   *  is what the scan confirm has always done with a field-def PATCH that came
   *  back non-ok. Filing the thing matters more than filing it under a name. */
  commit(args: {
    orgId: string;
    kind: string;
    value: string;
    instance?: string | null;
  }): Promise<CategoryAxisAssignment | null>;
  /** What to write for the value the record's slot ALREADY holds (read with
   *  `readAxisValue`), which is a name on a choice-backed axis and a record
   *  id on a native one. `commit` takes names only; handing it a slot's id
   *  made a category named after the id. The caller never says which it
   *  has, because the slot it came from does.
   *
   *  A name is committed as `commit` would (and kept as typed if it cannot
   *  be stored). An id is kept when a record has it; one in no store (deleted
   *  since the form loaded, or read off the wrong kind) is logged and comes
   *  back null, and the caller empties the slot and files under a name
   *  instead. Never throws. */
  keep(args: {
    orgId: string;
    kind: string;
    value: string;
    instance?: string | null;
  }): Promise<CategoryAxisAssignment | null>;
  /** Take a value back out of the vocabulary: the inverse of `commit`, for an
   *  undo that grew it. Only when no record of the kind files under it; a
   *  value somebody has used since stays, and the answer says so, because the
   *  undo is taking back what IT did, not what a person did afterwards.
   *
   *  `withdrawn` it went; `in-use` a record still files under it; `absent`
   *  it was not there (already gone is the state the caller wanted);
   *  `unsupported` the kind has no axis. Never throws. */
  withdraw(args: {
    orgId: string;
    kind: string;
    value: string;
    instance?: string | null;
  }): Promise<"withdrawn" | "in-use" | "absent" | "unsupported">;
}

export interface PlatformPairings {
  /** Insert a pairing. Returns the new row id. Org-scoped: the
   *  caller passes orgId; the function inserts with that org_id. */
  create(args: {
    orgId: string;
    sourceKind: string;
    sourceId: string;
    targetKind: string;
    targetId: string;
    relationshipKind: string;
    createdBy?: string | null;
    /** What the link is, in words, for a target that is not a record here
     *  (a document in a document system): what a reader of the links sees
     *  beside its id. */
    notes?: string | null;
    /** How to name and open a target that has no Cobblr detail route. */
    presentation?: import("./pairing-presentation.js").PairingResultPresentation;
  }): Promise<{ id: string }>;
  /** Add or refresh the presentation of one exact relationship. Existing
   * metadata owned by other features is preserved. */
  present(args: {
    orgId: string;
    sourceKind: string;
    sourceId: string;
    targetKind: string;
    targetId: string;
    relationshipKind: string;
    presentation: import("./pairing-presentation.js").PairingResultPresentation;
  }): Promise<{ updated: number }>;
  /** Remove the pairing(s) matching this exact relationship. Returns how many
   *  rows went; removing something that is not there is a no-op, not an error
   *  (the same shape placement.remove has).
   *
   *  The inverse of `create`, and it was missing: modules could make a link and
   *  never unmake one, so a module whose links are DERIVED from something
   *  editable — a mention inside a comment, say — had no way to reconcile when
   *  the thing that justified the link was edited away. The only alternatives
   *  were leaving stale links forever or deleting from `entity_pairings`
   *  directly, and that table has one chokepoint on purpose.
   *
   *  Matched on the whole tuple INCLUDING relationshipKind, so a caller can
   *  only ever remove links of a kind it created. Removing every link between
   *  two entities regardless of rel would let one module quietly delete
   *  another's, or a user's own hand-made one. */
  remove(args: {
    orgId: string;
    sourceKind: string;
    sourceId: string;
    targetKind: string;
    targetId: string;
    relationshipKind: string;
  }): Promise<{ removed: number }>;
  /** Insert many pairings at once. Used by bricklink.disassemble-kit
   *  to write hundreds of "matches" / "derived-from" rows efficiently. */
  createMany(
    rows: Array<{
      orgId: string;
      sourceKind: string;
      sourceId: string;
      targetKind: string;
      targetId: string;
      relationshipKind: string;
      createdBy?: string | null;
    }>,
  ): Promise<{ inserted: number }>;
  /** Bulk pairing lookup. "Given these N target entities, which
   *  source-side entities point at them via `relationshipKind`?"
   *  Returns { sourceId, sourceKind, targetId } so the caller can group
   *  by target. `sourceKind` narrows it to one kind; left out, every
   *  kind counts, because the pairing is what makes a row a match, not
   *  the table it is on: a brick on the Lego bundle's Bricks table
   *  (bricks:item) is matched to a part as surely as one on Parts
   *  (#5434). Used by bricklink-connector's wanted-list diff to fan out
   *  from N catalog entries to every record matched to them in one
   *  query. */
  findByTargets(args: {
    orgId: string;
    sourceKind?: string;
    targetKind: string;
    targetIds: string[];
    relationshipKind: string;
  }): Promise<Array<{ sourceId: string; sourceKind: string; targetId: string }>>;
  /** The inverse of findByTargets. "Given these N source entities,
   *  which target-side entities of `targetKind` do they point at via
   *  `relationshipKind`?" One SQL round-trip; caller groups by
   *  sourceId. Used by inventory's parts-list endpoint to
   *  batch-resolve the matched catalog entry for every part on the
   *  page (so the inventory row can fall back to the catalog's
   *  image when image_path is empty). */
  findBySources(args: {
    orgId: string;
    sourceKind: string;
    sourceIds: string[];
    targetKind: string;
    relationshipKind: string;
  }): Promise<Array<{ sourceId: string; targetId: string }>>;
  /** Aggregate the pairings pointing AT each target: how many, and when the
   *  newest was made. The counting twin of findByTargets — which returns a row
   *  per pairing, so counting through it means hauling every row back to count
   *  them in JS.
   *
   *  One query however many targets. That matters: the reconciliation surfaces
   *  (a serialized model's `units_count`, and the stability window deciding
   *  whether its numbers have settled) read this for EVERY row of a list page,
   *  so a per-row version would be an N+1 on a hot path.
   *
   *  `latestCreatedAt` is max(created_at) over a target's current pairings — the
   *  "has this stopped changing?" signal. It only moves forward on an insert:
   *  deleting a pairing does not bump it, so a window built on it errs quiet
   *  rather than nagging. Targets with no pairings are simply absent from the
   *  result (the caller reads them as zero). See
   *  docs/design-decisions/serialized-rollup-and-stock-adjust.md. */
  countByTargets(args: {
    orgId: string;
    targetKind: string;
    targetIds: string[];
    relationshipKind: string;
  }): Promise<Array<{ targetId: string; count: number; latestCreatedAt: string }>>;
}

/** Read-only access to core-catalogs from other modules. Modules
 *  used to SELECT directly from `core_catalogs_*` tables, which
 *  violated module-layers.md §"What modules canNOT do." This
 *  surface gives the few operations modules legitimately need
 *  (semantic-type lookup, BOM-style entry filter, name+payload
 *  hydration) without the table-type leak. See B1 in
 *  2026-05-25-audit.md. */
export interface PlatformCatalogs {
  /** Find a catalog by its declared semantic_type. Returns null
   *  when no catalog in the workspace declares the type. */
  findBySemanticType(
    orgId: string,
    semanticType: string,
  ): Promise<{ id: string; name: string; schema: Record<string, unknown> } | null>;
  /** Find a catalog by its bundle_external_id (suffix match). Used
   *  during a bundle uninstall to delete the right catalogs. */
  findByBundleExternalIdSuffix(
    orgId: string,
    suffix: string,
  ): Promise<{ id: string; name: string } | null>;
  /** Query entries within a catalog. JSON path filter is restricted
   *  to payload->>'<key>' = '<value>' equality — no arbitrary SQL.
   *  The kernel handles the org-scoping + table access. */
  queryEntries(args: {
    orgId: string;
    catalogId: string;
    /** Equality filters on payload JSONB keys. `{ set_num: "75192-1" }`
     *  → `payload->>'set_num' = '75192-1'`. */
    payloadEq?: Record<string, string>;
    externalIdIn?: string[];
    limit?: number;
  }): Promise<
    Array<{
      id: string;
      catalogId: string;
      externalId: string;
      payload: Record<string, unknown>;
    }>
  >;
  /** Fuzzy-search entries in a catalog by trigram similarity against
   *  `payload->>'name'` (or a caller-supplied payload key). Returns
   *  top-K candidates with their similarity score (0..1, higher =
   *  more similar). Caller-side LLMs use this to pull candidates
   *  before running a structured match. Uses Postgres `pg_trgm` —
   *  the kernel owns the SQL so modules don't reach across schemas. */
  similaritySearch(args: {
    orgId: string;
    catalogId: string;
    queryText: string;
    /** payload key to match against. Defaults to "name". */
    payloadKey?: string;
    /** top-K cap. Defaults to 10, max 100. */
    limit?: number;
  }): Promise<
    Array<{
      id: string;
      externalId: string;
      payload: Record<string, unknown>;
      score: number;
    }>
  >;
}

/** Which stored rendition to read. Images have medium/thumb; other
 *  files only have `original`. */
export type FileVariant = "original" | "medium" | "thumb";

/** A stored file's bytes + just-enough metadata to forward it on
 *  (e.g. upload to a print farm, send to a vision model). */
export interface FileBytes {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
}

/** The byte-reading function a file-storage module (core-files)
 *  registers with the platform. */
export type FileReader = (
  orgId: string,
  fileId: string,
  variant: FileVariant,
) => Promise<FileBytes | null>;

/** Result of storing a file through the write seam. */
export interface FileWriteResult {
  fileId: string;
  mimeType: string;
  sizeBytes: number;
  kind: string;
  /** The workspace already held these exact bytes: this is that file, and
   *  nothing new was stored. */
  existed?: boolean;
}
/** Stores bytes as a file in `orgId` (its own variants + DB row) and returns
 *  its id; bytes the workspace already holds return the file holding them
 *  (`existed: true`) rather than a second copy. core-files registers it; the kernel calls it to
 *  COPY a file across workspaces (e.g. the graduation import duplicating a
 *  photo into the new workspace). */
/** What a file is written from: bytes in hand, or a file already on disk (an
 *  upload the door streamed there, with the hash it took as it arrived), which
 *  the store moves in without reading it into memory. */
export type FileSource = Uint8Array | { path: string; size: number; sha256?: string };

export type FileWriter = (
  orgId: string,
  source: FileSource,
  opts: { filename?: string; mimeType?: string; photoSource?: import("./photo-source.js").PhotoSource },
) => Promise<FileWriteResult>;

/** "This file is the <role> of that entity" - the same row POST
 *  /attachments writes, for a module that is acting server-side with no
 *  request to carry a bearer (an event handler reacting to an upload). */
export interface FileAttachSpec {
  fileId: string;
  source_module: string;
  source_type: string;
  source_id: string;
  role?: string | null;
  sort_order?: number;
}
export interface FileAttachResult {
  attachmentId: string;
  /** True when the (file, entity, role) row already existed and was returned
   *  rather than created - the seam is idempotent. */
  existed: boolean;
}
/** One attachment on an entity, as the list seam reports it. */
export interface FileAttachmentRow {
  id: string;
  fileId: string;
  role: string | null;
  sort_order: number;
  filename: string;
  mimeType: string;
  kind: string;
  width: number | null;
  height: number | null;
  createdAt: Date;
  /** Where the picture came from, when that was stored with it. */
  photoSource?: import("./photo-source.js").PhotoSource | null;
}
/** What a stored file is, for a person reading about it: its name, size,
 *  shape and (for a picture) where it came from. */
export interface FileDescription {
  fileId: string;
  filename: string;
  mimeType: string;
  kind: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  photoSource: import("./photo-source.js").PhotoSource | null;
}
export type FileDescriber = (orgId: string, fileIds: string[]) => Promise<FileDescription[]>;
/** Attaches a stored file to an entity. core-files registers it; it emits the
 *  same core-files.attachment.created event the HTTP route does, so wires see
 *  no difference between a user's upload and a module's server-side attach. */
export type FileAttacher = (orgId: string, spec: FileAttachSpec) => Promise<FileAttachResult>;
/** Removes one attachment by id (the file itself stays). Resolves false when
 *  there was no such row. Emits core-files.attachment.deleted like the route. */
export type FileDetacher = (orgId: string, attachmentId: string) => Promise<boolean>;
/** Lists what is attached to one entity, oldest first (sort_order, then
 *  created_at) - the server-side twin of GET /attachments. */
export type FileAttachmentLister = (
  orgId: string,
  source: { source_module: string; source_type: string; source_id: string },
) => Promise<FileAttachmentRow[]>;
/** Where one file is attached: the reverse of FileAttachmentLister. What
 *  lets "each dropped file becomes a record" refuse to make a second record
 *  for a file a record already owns. Live attachments of a live file only. */
export interface FileAttachedTo {
  attachmentId: string;
  source_module: string;
  source_type: string;
  source_id: string;
  role: string | null;
}
export type FileAttachmentsOfFile = (orgId: string, fileId: string) => Promise<FileAttachedTo[]>;
/** Folders, server-side (#3753): a module that keeps a set of files together
 *  (a Make's model, G-code and renders) makes a place for them the way a
 *  person would, by name under a path. */
export interface FileFolders {
  /** The folder at this path of names, made as needed ("Makes" / "Round
   *  spacer"). Names match case-insensitively, as the folder list does. */
  ensure(orgId: string, path: string[]): Promise<string>;
  /** Put a file in a folder, but only a file still at the top: bytes are
   *  kept once, so a file already somewhere a person (or another record)
   *  put it stays there. Returns whether it moved. */
  file(orgId: string, fileId: string, folderId: string): Promise<boolean>;
}

/** A table's file intake, declared by its bundle: each file dropped on the
 *  table becomes one of its records, the file attached with `role` (Yarn's
 *  Patterns: every PDF is a pattern). Files arrive through core-files' one
 *  intake and land in `folder`; a zip's top folder fills `folder_field` when
 *  it names one of that field's choices; `ask` is asked once per batch. The
 *  server side is POST /orgs/:slug/instances/:instance/file-intake. */
/** A table's "Import from <service>" button (Yarn: Import from Ravelry).
 *  `connector` is a sync connector's id; `sections` maps each of its entity
 *  types to the table (instance) its rows land in ("stash" → "yarn",
 *  "projects" → "designs"). A section whose table the workspace lacks is left
 *  out. The first press asks for the service's keys once; every press after
 *  that re-imports, updating what is already here (TableConnectorImport). */
/** What a maker's notions are called, one list for the pattern reader, the
 *  pattern page and the Yarn bundle's Notions table (its Type choices), so a
 *  pattern's "2 St markers" and the stash's "Stitch markers" are one word. */
export const NOTION_NAMES = [
  "Stitch markers",
  "Stitch holders",
  "Yarn needle",
  "Cable needle",
  "Safety eyes",
  "Stuffing",
  "Buttons",
  "Row counter",
] as const;
export type NotionName = (typeof NOTION_NAMES)[number];

export interface ConnectorImportDecl {
  connector: string;
  label?: string;
  sections: Record<string, string>;
}

/** How to get files out of somewhere, shown on an import when the batch
 *  question is answered with that place (Source: Ribblr). The bundle knows the
 *  place; the import only knows to show what the bundle wrote. */
export interface FileIntakeGuide {
  when: { field: string; equals: string };
  title: string;
  steps: string[];
}

export interface FileIntakeDecl {
  accept: string[];
  role: string;
  folder?: string;
  folder_field?: string;
  ask?: string[];
  label?: string;
  guides?: FileIntakeGuide[];
}

/** One owner per named job, across every api process sharing this database.
 *
 *  A module's periodic loop is started by EVERY api process, and this platform
 *  now runs more than one against a single database (the canary channel; a
 *  rolling deploy). An unguarded loop therefore does its side effects twice on
 *  real user data - which is how one workspace's printer posted its progress
 *  to Discord twice, every time, for weeks (2026-08-29).
 *
 *  `run` returns true when THIS process did the work and false when another
 *  process held the job. A false is the normal outcome, never an error.
 *
 *  It prevents CONCURRENT runs, which is not the same as "runs once": the
 *  loser's next tick may find the job free. Work that must not repeat has to
 *  claim what it acts on (compare-and-set the row, delete the bucket) inside
 *  the callback. */
/** What became of a run under the exclusive lock. Not a boolean on purpose:
 *  "someone else held it" is a normal answer for a timer tick and a wrong
 *  one to report as done to a person or a test, and a bare `false` was read
 *  as "nothing to do" (a Sync now that said "sent 0" while a change still
 *  waited). The caller says which it is (lint:exclusive-answer-read). */
export type ExclusiveRun = { ran: true } | { ran: false; heldElsewhere: true };

export interface PlatformExclusive {
  run(name: string, work: () => Promise<void>): Promise<ExclusiveRun>;
}

// ── Cross-tenant sweeps: one walk of the workspaces, one budget ─────────────
//
// Every self-healing or periodic pass used to walk all workspaces on its own
// timer with its own pool discipline; six of them started within minutes of
// boot on a box with 352 workspaces against a 100-connection Postgres and
// refused 811 connections in six hours (#3036). A pass registers here
// instead: the kernel walks the workspaces ONCE for every pass that is due,
// opens a workspace's pool at most once per visit, evicts it on the way out,
// bounds how many are open at a time, and spreads each pass's first visit
// over its cadence so nothing storms at boot.

/** What one visit of one pass reports. */
export interface TenantSweepVisitResult {
  /** This workspace still had a full page waiting: visit it again after
   *  `drainMs` rather than the full cadence. */
  backlog?: boolean;
  /** Stop this pass's walk here for this round (an engine said no; the rest
   *  of the round would be the burst again): no further workspace is
   *  started for it; visits already in flight under the budget finish.
   *  Other passes continue. */
  stop?: boolean;
  /** Anything the pass wants counted; `run()` hands every visit's value
   *  back, so a test or an admin door can total it. */
  [key: string]: unknown;
}

export interface TenantSweepPass {
  /** Unique across the process: `<module>.<pass>`. Also the advisory-lock
   *  name, so two api processes never walk the same pass at once. */
  name: string;
  /** How often each workspace is visited. */
  everyMs: number;
  /** While a visit reported a backlog, the next round comes after this
   *  instead of `everyMs` (a page a minute while there is work). */
  drainMs?: number;
  /** The first round comes this long after the scheduler starts instead of
   *  at a random point inside `everyMs`; for a pass whose first visit cannot
   *  wait a cadence (a boot-time discovery). */
  firstAfterMs?: number;
  /** Only workspaces with this module enabled. */
  module?: string;
  /** A meta-side gate: given the workspaces in scope, the ones worth opening
   *  a pool for this round, or null for all of them. Answering from what the
   *  process already knows costs zero tenant connections on a round with
   *  nothing to do (#3034). `named` is true when the caller asked for these
   *  workspaces by id (an operator or a test running the pass on one
   *  workspace): a gate that skips what it already visited must not skip a
   *  workspace somebody asked for. */
  candidates?: (orgIds: string[], opts: { named: boolean }) => Promise<string[] | null>;
  /** One workspace, its db open (a Kysely instance, cast to the module's
   *  schema). Throwing fails this visit only; the walk continues. */
  visit: (ctx: TenantSweepVisit) => Promise<TenantSweepVisitResult | void>;
  /** What a workspace needs from this pass the moment its `module` is
   *  enabled there, so it is born with it instead of waiting for its first
   *  round (docs/architecture/platform-spec.md §8.1, BORN WITH). Run once by enableModuleForOrg, with
   *  the workspace's db open. Keep it cheap: no network, no long work; set
   *  up state and leave the work to the rounds. Only a pass that names its
   *  `module` has an enable to hook, so a pass without one never runs this.
   *  At boot, reconcileDefaultModules can enable a module before its onBoot
   *  has registered the pass; such a workspace gets the state from the
   *  pass's first round instead, so this holds for enables after boot. */
  onEnable?: (ctx: TenantSweepVisit) => Promise<void>;
}

export interface TenantSweepVisit {
  orgId: string;
  db: unknown;
  now: Date;
}

export interface TenantSweepRunResult {
  /** Workspaces visited by this pass. */
  visited: number;
  /** Visits that threw (logged), and workspaces whose pool could not open. */
  failed: number;
  /** Any visit reported a backlog. */
  backlog: boolean;
  /** The pass stopped its walk early. */
  stopped: boolean;
  /** Every visit's value, in visit order. */
  results: Array<{ orgId: string; result: TenantSweepVisitResult | void }>;
  /** Another api process held the pass's lock; nothing ran. */
  skipped: boolean;
  /** Which workspaces failed and why, the first few: a visit that threw, or
   *  a pool that would not open. `failed` used to be a bare count nothing
   *  read, so a workspace failing every hour was silent for as long as it
   *  liked (#3350); /healthz reports the last round's from here. */
  failures: Array<{ orgId: string; message: string }>;
}

export interface PlatformSweeps {
  /** Register a pass. Idempotent by name (a re-registration replaces). */
  register(pass: TenantSweepPass): void;
  /** Run one pass now, over every workspace in its scope or the ones given,
   *  under its lock: the door for tests and admin routes. */
  run(name: string, opts?: { orgIds?: string[]; now?: Date }): Promise<TenantSweepRunResult>;
}

/** Server-side access to stored file bytes, brokered so a module never
 *  imports core-files or touches its on-disk layout. core-files
 *  registers the reader at boot; everyone else just calls read(). */
export interface PlatformFiles {
  /** A file-storage module registers the byte reader once at boot. */
  registerReader(reader: FileReader): void;
  /** Read a stored file's bytes. Returns null if no reader is
   *  registered, the file doesn't exist, or the variant is missing. */
  read(
    orgId: string,
    fileId: string,
    variant?: FileVariant,
  ): Promise<FileBytes | null>;
  /** A file-storage module registers the byte writer once at boot. */
  registerWriter(writer: FileWriter): void;
  /** Store bytes as a file in `orgId` (variants + DB row). Returns its id, or
   *  null if no writer is registered. Bytes this workspace already holds
   *  return the existing file (`existed: true`), never a second copy. */
  write(
    orgId: string,
    source: FileSource,
    opts: { filename?: string; mimeType?: string; photoSource?: import("./photo-source.js").PhotoSource },
  ): Promise<FileWriteResult | null>;
  /** A file-storage module registers the attacher once at boot. */
  registerAttacher(attacher: FileAttacher): void;
  /** Attach a stored file to an entity with a role, server-side (no request,
   *  no bearer). Returns null if no attacher is registered. Idempotent: an
   *  attachment that already exists is returned with `existed: true`. */
  attach(orgId: string, spec: FileAttachSpec): Promise<FileAttachResult | null>;
  /** A file-storage module registers the detacher once at boot. */
  registerDetacher(detacher: FileDetacher): void;
  /** Remove one attachment server-side. Returns null if no detacher is
   *  registered, false if the row did not exist. */
  detach(orgId: string, attachmentId: string): Promise<boolean | null>;
  /** A file-storage module registers the attachment lister once at boot. */
  registerAttachmentLister(lister: FileAttachmentLister): void;
  /** A file-storage module registers the describer once at boot. */
  registerDescriber(describer: FileDescriber): void;
  /** What these files are (deleted ones left out). Null if no describer is
   *  registered. A record's history names a photo by this, never by its
   *  storage path (#4517). */
  describe(orgId: string, fileIds: string[]): Promise<FileDescription[] | null>;
  /** What is attached to one entity. Returns null if no lister is registered
   *  (distinct from [] - nothing attached). */
  listAttachments(
    orgId: string,
    source: { source_module: string; source_type: string; source_id: string },
  ): Promise<FileAttachmentRow[] | null>;
  /** A file-storage module registers the reverse lookup once at boot. */
  registerAttachmentsOfFile(lookup: FileAttachmentsOfFile): void;
  /** A file-storage module registers its folders once at boot. */
  registerFolders(folders: FileFolders): void;
  /** Make the folder at a path of names. Null if no folders are registered. */
  ensureFolder(orgId: string, path: string[]): Promise<string | null>;
  /** File a top-level file into a folder (see FileFolders.file). Null if no
   *  folders are registered. */
  fileInto(orgId: string, fileId: string, folderId: string): Promise<boolean | null>;
  /** Every entity one file is attached to. Null if no lookup is registered
   *  (distinct from [] - attached to nothing). */
  attachmentsOfFile(orgId: string, fileId: string): Promise<FileAttachedTo[] | null>;
  /** Override the blob-storage driver (the overlay injects S3/R2). If none is
   *  registered, core-files uses its built-in local-disk driver. */
  registerDriver(driver: FilesDriver): void;
  /** The registered driver, or null → core-files falls back to local disk. */
  getDriver(): FilesDriver | null;
  /** core-files says how a whole workspace's stored bytes are removed. */
  registerWorkspaceEraser(eraser: (orgId: string) => Promise<void>): void;
  /** Remove every byte a workspace ever stored, through whichever driver holds
   *  them. The kernel's workspace delete calls it while the workspace's
   *  database still exists (the file list lives there). Nothing registered
   *  resolves: nothing was stored. */
  eraseWorkspace(orgId: string): Promise<void>;
  /** core-files says how to list the per-workspace folders its storage holds. */
  registerWorkspaceFolderLister(lister: () => Promise<WorkspaceFolder[] | null>): void;
  /** Every workspace folder the file store holds, with its size and newest
   *  write, whether or not that workspace still exists. Null when the active
   *  storage cannot be listed this way (nothing registered, or a driver keyed
   *  only by file). Read-only. */
  listWorkspaceFolders(): Promise<WorkspaceFolder[] | null>;
}

/** One workspace's folder in the file store. */
export interface WorkspaceFolder {
  orgId: string;
  bytes: number;
  /** The newest write anywhere under it, ms since the epoch. */
  newestAt: number;
}

/** Multi-instance support hooks. A multi-instance module (inventory, assets,
 *  machines, …) registers a counter so the kernel can ask "how many primary
 *  items live in this (org, instance)?" without knowing the module's tables —
 *  used by the nav to hide an auto-created default instance that's empty once
 *  the workspace has named instances. */
/** A workspace's installed instance of a module — the org-scoped, user-named
 *  collection the navbar renders (e.g. machines → "3D Printers" + "Laser
 *  Cutters"). `is_default` marks the module's own auto-created instance
 *  (instance_name === module_name). `item_count` is the module's registered
 *  counter (null if it registered none). Lets a module enumerate what the
 *  workspace ACTUALLY has — enabled, instance-aware — instead of the global
 *  entity-kind registry. */
export interface InstanceInfo {
  module_name: string;
  instance_name: string;
  display_name: string;
  is_default: boolean;
  item_count: number | null;
}

/** How a module moves its own records between its own instances. Registering
 *  one is what makes "Move to..." appear for that module: a module that has
 *  not considered its instance-scoped foreign keys simply does not offer the
 *  action, which is the right default. */
export interface InstanceMoverContract {
  /** Flip the instance column for these ids and return the ids actually moved.
   *  MUST be a plain update. Never insert, never delete, never mint an id: the
   *  record keeps its uuid, which is what lets its printed QR label and every
   *  reference to it survive the move.
   *
   *  `db` is the platform's OPEN TRANSACTION on the tenant database, and the
   *  implementation must use it rather than fetching its own handle. Calling
   *  `tenants.getDb()` here would run the update on a different connection,
   *  outside the transaction, so a later failure would roll back the reference
   *  rewrites while leaving the records moved. */
  move(orgId: string, ids: string[], from: string, to: string, db: unknown): Promise<string[]>;
  /** The entity kind a record answers to in a given instance. Only the module
   *  knows its own default-instance rule (inventory's default is
   *  `inventory:part`; every named instance is `<instance>:item`). */
  kindFor(instance: string): string;
  /** The custom-field bag (`metadata`) of each of these records, so the move
   *  preview can say which values would render unlabeled in the target. Read
   *  through the module rather than the generic resolver because that projects
   *  fields through `exposableFields`, which can hide the very custom values
   *  this needs to count. */
  metadataFor(orgId: string, ids: string[]): Promise<Array<Record<string, unknown>>>;
  /** Which instance each of these records is in NOW.
   *
   *  Only the module knows where its own rows keep that, and without it a
   *  caller has to be TOLD the list a record is already in - which is asking a
   *  person to do the computer's arithmetic. "Put these in Tea" says
   *  everything that matters; the records know the rest.
   *
   *  Optional so a mover written before this keeps working: the platform then
   *  says it cannot work the source out and asks for it, rather than guessing. */
  instancesOf?(orgId: string, ids: string[]): Promise<string[]>;
}

export interface PlatformInstances {
  registerItemCounter(
    moduleName: string,
    counter: (orgId: string, instanceName: string) => Promise<number>,
  ): void;
  /** Opt this module into moving records between its instances. */
  registerMover(moduleName: string, mover: InstanceMoverContract): void;
  /** Every instance in the workspace (all enabled modules' default + named
   *  instances), each enriched with its item count. Org-scoped — only what
   *  this workspace has turned on. */
  list(orgId: string): Promise<InstanceInfo[]>;
  /** Shallow-merge a patch into an instance's platform-derived config — the
   *  meta-side `entity_kind_overrides` blob (target "instance",
   *  `<module>:<instance>`) that resolveInstance surfaces on req.instanceConfig.
   *  Read-modify-write, so existing keys (item_noun, qty_unit, the user's stock
   *  override) are preserved. Used for signals the PLATFORM latches on behalf of
   *  a module — e.g. inventory writing `stock_latched: true` the first time an
   *  instance shows stock data, so the sticky stock face survives a drain-to-zero
   *  and instance-kind synthesis can read the verdict without a tenant pool.
   *  See one-record-substrate.md. Creates the override row if absent. */
  patchDerivedConfig(
    orgId: string,
    moduleName: string,
    instanceName: string,
    patch: Record<string, unknown>,
  ): Promise<void>;
  /** One instance's config as its module sees it on a request
   *  (req.instanceConfig): the instance row's config under the presentation
   *  override its bundle wrote (item noun, qty unit, `parent`). For work
   *  outside a request, like a boot heal. Null when there is no such instance. */
  configOf(orgId: string, instanceName: string): Promise<Record<string, unknown> | null>;
}

// ─────────────────────── Hosted-overlay extension seams ─────────────────────
// Open core registers NONE of these → a self-hosted instance runs free and
// unrestricted. The proprietary cloud overlay registers implementations at boot
// (plan gating, usage metering, lifecycle/verification, abuse rate-limiting,
// object storage). See cloud/docs/cloud-offering-roadmap.md.

export interface EntitlementCtx {
  orgId: string;
  /** Dotted feature key, e.g. "workspaces.create", "members.add",
   *  "modules.enable", "sandbox.install", "files.store". */
  feature: string;
  /** Units requested (default 1) — e.g. bytes for files.store. */
  quantity?: number;
  /** Units the workspace already holds of the same thing (the bytes of its
   *  stored files, for files.upload), so a guard can judge a running total
   *  rather than one request at a time. Absent when the caller cannot say. */
  used?: number;
  userId?: string;
}
export type EntitlementGuard = (
  ctx: EntitlementCtx,
) => Promise<{ allow: boolean; reason?: string }>;
export interface PlatformEntitlements {
  /** Hosted overlay registers the plan guard (last wins). */
  registerGuard(g: EntitlementGuard): void;
  /** Core / modules ask whether a plan-limited action is allowed. No guard
   *  registered → always allowed; a guard that throws fails open. */
  check(ctx: EntitlementCtx): Promise<{ allow: boolean; reason?: string }>;
}

export interface MeterEvent {
  orgId?: string;
  /** e.g. "ai.tokens", "files.bytes_stored", "members.added". */
  kind: string;
  quantity: number;
  meta?: Record<string, unknown>;
}
export type MeterSink = (e: MeterEvent) => void;
export interface PlatformMetering {
  registerSink(s: MeterSink): void;
  /** Emit a billable/observable event. No sink → dropped. Never throws. */
  record(e: MeterEvent): void;
}

// ── Product telemetry seam ───────────────────────────────────────────────────
// Sparse, high-signal product events (a wall somebody hit, an adoption
// milestone such as the first scan) — the numbers the operator reads to learn
// whether people are getting anywhere. NOT the activity log (that is the
// mutation audit and shows in the user's own feed) and NOT metering (that is
// billing). Rule of thumb: if the event would not change what gets built next
// week, do not track it.
export interface TelemetryEvent {
  orgId: string;
  userId?: string | null;
  /** e.g. "scan_captured", "label_printed", "validation_rejected". */
  event: string;
  detail?: Record<string, unknown>;
}
export interface PlatformTelemetry {
  /** One row per occurrence. Best-effort, fire-and-forget, never throws. */
  track(e: TelemetryEvent): void;
  /** At most one row per workspace + user + event + UTC day, so a burst of
   *  the same thing (a Live Sort session, a batch print) is one fact: "they
   *  did this today". The right call for funnel milestones. */
  trackDaily(e: TelemetryEvent): void;
  /** Add `n` (default 1) to a workspace's count of `metric` for today (UTC).
   *  For things that happen many times and are only ever asked "how many":
   *  an identification served, a scan. Best-effort, never throws. */
  count(e: { orgId: string; metric: string; n?: number }): void;
}

export interface SignupLifecycleCtx { userId: string; email: string; orgId: string }
export interface AccountDeleteCtx { userId: string; email: string }
export interface LifecycleHooks {
  onSignup?: (ctx: SignupLifecycleCtx) => Promise<void> | void;
  onAccountDelete?: (ctx: AccountDeleteCtx) => Promise<void> | void;
}
export interface PlatformAccounts {
  registerLifecycleHooks(h: LifecycleHooks): void;
  /** The day it is WHERE THIS PERSON IS, for a module that is about to claim
   *  one ("dated today", "expires today"). From the zone they stated in their
   *  communication preferences; `said` (a day their client sent) wins; a
   *  person who never said gets the day that has arrived everywhere, which is
   *  late for somebody rather than early for anybody (#3351). The rule itself
   *  is `@cobblr/platform-contract/day`; this only knows where they are. */
  dayFor(userId: string | null | undefined, opts?: { said?: unknown; now?: Date }): Promise<string>;
  /** The names people go by in a workspace, for a module that recorded WHO
   *  did something ("Sam took 1") and must say it. Read at display time, so a
   *  rename shows everywhere at once, never a copy taken when it happened.
   *  Only members of `orgId`: an id that is not (someone who has left) is
   *  simply absent, and the caller says so in its own words. */
  displayNames(orgId: string, userIds: readonly string[]): Promise<Record<string, string>>;
  /** The account behind one entry on the workspace's People list (what a
   *  `person` field stores), or null: someone listed by name who has no
   *  account, or has left. What a module needs to notify the person a record
   *  names ("assigned to Robin") without reading the platform's tables. */
  userForPerson(orgId: string, personId: string): Promise<string | null>;
  /** A member's own entry on the People list (made if missing): what "mine"
   *  means for a record whose `person` field names who it is for. */
  personForUser(orgId: string, userId: string): Promise<string | null>;
  /** The person this request acts for, or null outside one (a wire on a
   *  timer, a boot pass, a sync). The same actor the activity log records,
   *  so a module that writes its own history names the same person. */
  currentUserId(): string | null;
}

export interface RequestGuardCtx { ip: string; path: string; method: string; userId?: string }
export type RequestGuard = (
  ctx: RequestGuardCtx,
) => Promise<{ allow: boolean; retryAfterSec?: number; reason?: string }>;
/** A delivery to a global, unauthenticated webhook endpoint
 *  (/api/v1/hooks/:id). `rawBody` is the exact transmitted bytes, captured so a
 *  handler can verify a provider signature (Stripe, GitHub, …) against them.
 *  `method` is "POST" for webhooks/interactivity or "GET" for OAuth callbacks. */
export interface PublicWebhookRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  rawBody?: string;
  query: Record<string, unknown>;
}
export interface PublicWebhookHandler {
  /** URL segment under /api/v1/hooks/, e.g. "stripe-billing". Last
   *  registration for an id wins. */
  id: string;
  /** Return `headers` + a 3xx `status` with a `Location` header to issue a
   *  redirect (an OAuth "Add to X" callback) instead of a JSON body. */
  handle: (
    req: PublicWebhookRequest,
  ) => Promise<{ status: number; body?: unknown; headers?: Record<string, string> }>;
}
export interface PlatformHttp {
  /** Hosted overlay registers a request guard (rate-limit / abuse). */
  registerRequestGuard(g: RequestGuard): void;
  /** Register a global, UNAUTHENTICATED webhook endpoint mounted at
   *  /api/v1/hooks/:id. For ACCOUNT-LEVEL provider webhooks (Stripe billing,
   *  GitHub app, …) that are NOT tenant-scoped — distinct from
   *  integrations.registerInboundHandler, which is the per-workspace,
   *  token-in-URL inbound receiver. The handler verifies its own signature and
   *  resolves any tenant from the payload; the platform mounts it before auth
   *  and captures rawBody for signature checks. Open core mounts the dispatch
   *  route regardless, 404-ing unregistered ids. */
  registerWebhook(h: PublicWebhookHandler): void;
  /** The one upload door (./upload): a multipart middleware for one file,
   *  streamed to a temporary file on disk and hashed as it arrives (read it
   *  with `uploadedFile(req)`), its limit by its kind unless the route sets
   *  one. A refusal (too large, too many files, the wrong field) answers
   *  413/400 with its code, the file's size and the limit, never a 500, and
   *  writes one log line of the facts. Every multer route goes through here
   *  (lint:uploads-through-one-door). */
  upload(opts: UploadOptions): UploadMiddleware;
  /** The size row a file falls in on this deployment (its design-file limit
   *  is a per-deployment setting): for a route judging files it unpacks
   *  itself, a zip's entries. */
  uploadSizeFor(filename: string, mimeType: string | null): UploadSizeRow;
  /** A route refusing an upload itself, after the door let it in (a full
   *  workspace, a type it does not take): the same log line as the door's
   *  own refusals. Never the file's name or bytes. */
  uploadRefused(req: unknown, refusal: UploadRefusal): void;
}

// ── Hosted settings panels ───────────────────────────────────────────────────
// Lets a module/overlay contribute a SETTINGS PAGE to the web app WITHOUT
// shipping any frontend code into the open-core web bundle. The overlay returns
// a small DECLARATIVE view (text / status / buttons / a select) + handles the
// actions; the open-core web app renders it with one generic renderer. Open core
// registers no panels, so a self-hoster sees nothing — none of the panel's
// labels, logic, or even its name exist in core. Used for the hosted-only
// billing + Slack panels, which therefore live entirely in the closed overlay.

export type HostedPanelBlock =
  | { kind: "text"; text: string; tone?: "muted" | "warning" }
  | { kind: "status"; label: string; value: string; active?: boolean }
  // A text field. Its current value is collected by `key` and submitted together
  // when a `kind:"button"` with `submit:true` is clicked (input values arrive on
  // runAction's `input.values`). `secret:true` renders a password field and the
  // panel should not echo the stored value back.
  | { kind: "input"; key: string; label: string; placeholder?: string; secret?: boolean; value?: string }
  | {
      kind: "button";
      label: string;
      action: string;
      style?: "primary" | "default" | "danger";
      confirm?: string;
      /** Gather every input block's value and pass them as `input.values`. */
      submit?: boolean;
    }
  | {
      kind: "select";
      label: string;
      action: string;
      value: string | null;
      options: Array<{ value: string; label: string }>;
      placeholder?: string;
      hint?: string;
    };
export interface HostedPanelView {
  blocks: HostedPanelBlock[];
}
/** What a button/select action returns: optionally redirect the browser (OAuth /
 *  checkout), re-fetch the view, and/or show a toast. */
export interface HostedPanelActionResult {
  redirect?: string;
  refresh?: boolean;
  toast?: string;
}
export interface HostedPanelContext {
  orgId: string;
  userId: string;
  slug: string;
  /** The caller's role in the workspace. The kernel has already refused
   *  anyone below the panel's `minRole`; a panel may narrow further. */
  role: string;
}
export interface HostedPanel {
  /** URL segment + key, e.g. "billing", "slack". */
  id: string;
  label: string;
  /** Generic icon NAME (e.g. "credit-card"); the web maps a small allowlist. */
  icon?: string;
  group?: "modules" | "data" | "access" | "extend" | "admin";
  /** The least role that may see and use the panel. Unset means owner or
   *  admin: a settings panel is configuration unless it says otherwise. */
  minRole?: Exclude<OrgRoleName, "guest">;
  getView(ctx: HostedPanelContext): Promise<HostedPanelView>;
  runAction(
    ctx: HostedPanelContext,
    action: string,
    input?: { value?: string | null; values?: Record<string, string> },
  ): Promise<HostedPanelActionResult>;
}
export interface HostedPanelSummary {
  id: string;
  label: string;
  icon?: string;
  group?: string;
}
export interface PlatformHostedPanels {
  /** Hosted overlay registers a settings panel. Last registration per id wins. */
  register(panel: HostedPanel): void;
  /** Summaries for building tiles/routes (no handlers). Empty in open core. */
  list(): HostedPanelSummary[];
  get(id: string): HostedPanel | undefined;
}

/** Blob persistence driver. core-files ships + falls back to a local-disk
 *  driver; the overlay registers an S3/R2 driver via platform().files. */
export interface FilesDriver {
  put(orgId: string, fileId: string, relPath: string, bytes: Uint8Array): Promise<void>;
  /** Store a file that is already on disk without reading it into memory (a
   *  link or copy on local disk, a streamed PUT to object storage). Optional:
   *  a driver without it is given the bytes through put(). */
  putFile?(orgId: string, fileId: string, relPath: string, srcPath: string): Promise<void>;
  getBytes(orgId: string, fileId: string, relPath: string): Promise<Uint8Array | null>;
  remove(orgId: string, fileId: string): Promise<void>;
  /** Local drivers return an absolute path (Express sendFile fast path);
   *  remote drivers return null and the route streams getBytes. */
  localPath(orgId: string, fileId: string, relPath: string): string | null;
  /** Remove whatever is left under a workspace once each of its files has
   *  been removed (an empty folder, a stray a crash left). Optional: a driver
   *  keyed purely by file needs nothing more. */
  removeWorkspace?(orgId: string): Promise<void>;
}

/** Platform-level (pre-workspace) auth email — verification, password reset,
 *  magic-link delivery. Open core registers no sender (dev returns the link
 *  inline; admin-reset is the fallback). A self-hoster OR the overlay registers
 *  one. */
export interface AuthEmailMessage {
  to: string;
  subject: string;
  text: string;
  /** Optional HTML body. Senders deliver multipart text+html when present (the
   *  text stays the plaintext fallback). Used for richer transactional emails
   *  (e.g. the feedback "your request is live" note). */
  html?: string;
  // `notification` = a platform-level transactional note to a known user (e.g.
  // "the feedback you reported is live"). Distinct from the pre-workspace auth
  // kinds; reuses the same registered sender (the overlay's managed mailer).
  kind: "magic_link" | "verify_email" | "password_reset" | "invite" | "notification";
  /** Optional Reply-To. Used for reply-by-email (a tokenized feedback address)
   *  so a recipient's reply can be routed back inbound instead of lost. */
  replyTo?: string;
  /** Optional From override — e.g. a per-workspace `receipts+<token>@` address so
   *  a receipt reply comes FROM the very address the user emailed (DKIM-aligned to
   *  the verified sending domain). A sender that can't set From for its domain
   *  falls back to its configured From. */
  from?: string;
  /** Threading: the Message-ID of the message this replies to. Senders set
   *  In-Reply-To + References so the recipient's client threads the reply under
   *  their original. */
  inReplyTo?: string;
  references?: string;
}
export type AuthEmailSender = (msg: AuthEmailMessage) => Promise<void>;

// ── Scan-URL resolvers ──────────────────────────────────────────────────
// A scanned QR is often a URL on a maker's site that encodes a SPECIFIC
// product (a Polar Filament spool → `3dqr.co/?i=<serial>`). Treated as a
// barcode it triggers the generic web-search path, which finds the maker's
// *marketing* page, not the product. So the platform exposes a registry via
// platform().scan.registerUrlResolver, and the scan pipeline asks
// platform().scan.resolveUrl(value). In practice the registered resolver is the
// DECLARATIVE vendor resolver, which consults a data manifest LIST (built-in +
// operator-added) — adding a maker is a data entry, not a code module. The
// kernel/core-scan never imports a vendor — the same modular seam as
// registerComputedContext / registerHandler.

export interface ScanUrlResolution {
  /** Provenance for the inbox row + cache, e.g. "polar-3dqr". */
  source: string;
  /** Product name, e.g. "Royal Blue PLA". */
  name: string;
  brand: string | null;
  /** Domain category, e.g. "filament" — routes the inbox item on commit. */
  category: string | null;
  /** Entity kind to create: "part" | "asset" | … */
  entityType: string | null;
  /** Custom fields seeded onto the created entity's metadata (e.g. a filament
   *  spool's size / batch_code). Unknown keys ride along harmlessly. */
  fields: Record<string, unknown>;
  imageUrl?: string | null;
}

export interface ScanUrlResolver {
  /** Stable id for de-dup + provenance, e.g. "polar-3dqr". */
  name: string;
  /** Cheap + synchronous: does this resolver claim the scanned value? */
  matches: (value: string) => boolean;
  /** Fetch + parse the value into a product, or null on any miss / parse
   *  failure (the caller then falls back to its generic barcode path).
   *  `opts.force` = a user-initiated re-run: bypass any resolver-side cache so
   *  the value is re-fetched + re-mapped fresh (otherwise a stale cached
   *  resolution survives the re-run). */
  resolve: (value: string, opts?: { force?: boolean }) => Promise<ScanUrlResolution | null>;
}

export interface PlatformScan {
  /** Register a vendor scan-URL resolver. Called from a connector module's
   *  api/index.ts at module-load. Idempotent per `name`. */
  registerUrlResolver(resolver: ScanUrlResolver): void;
  /** Resolve a scanned value through the registered vendor resolvers, in
   *  registration order. Returns the first hit, or null if none claim it.
   *  `opts.force` rides through to each resolver (re-run bypasses caches). */
  resolveUrl(value: string, opts?: { force?: boolean }): Promise<ScanUrlResolution | null>;
  /** The scan inbox's side of a share's hand-over (share-offer.ts). The
   *  module that owns the inbox registers it at load. */
  registerOfferIntake(intake: OfferIntake): void;
  offerIntake(): OfferIntake | null;
}

/** Shares between workspaces (docs/design-decisions/share-spaces.md): what a
 *  module may ask of them. */
export interface PlatformShares {
  recordOwnSendFiling?(orgId: string, offerId: string, inboxId: string, record: { kind: string; id: string }): Promise<void>;
  /** A person answered an offer that arrived in their scan inbox. Taking it
   *  keeps it (or, in a share space, moves it to `into`, a workspace of theirs
   *  on this Cobblr); passing removes it; maybe leaves it for later. The giver
   *  is told. */
  decideOffer(
    orgId: string,
    inboxId: string,
    decision: OfferDecision,
    opts: { userId: string; into?: string | null },
  ): Promise<{ ok: true; landed?: { orgId: string; inboxId: string } } | { ok: false; error: string }>;
  /** Offer things from this workspace's scan inbox to the person a share
   *  links it with (a share space offering back to its sharer). */
  offerInboxItems(orgId: string, inboxIds: string[], opts: { userId: string }): Promise<{ ok: true; offered: number } | { ok: false; error: string }>;
}

/** The resolvable registry seam. A module registers a provider for a value it
 *  owns (core-scan's QR rules) or asks "what could this value mean" for a
 *  surface. Types live in ./resolvables; the impl is api/src/platform. See
 *  docs/design-decisions/resolvable-registry.md. */
export interface PlatformResolvables {
  /** Register a provider. Idempotent by id; throws if a scan-serving provider is
   *  not an exact matcher (D3). Call at module load. */
  register(provider: ResolvableProvider): boolean;
  /** Run every provider serving `ctx.surface` and let the count decide. */
  resolve(orgId: string, value: string, ctx: ResolveContext): Promise<ResolveOutcome>;
}

/** A live control declaration plus the module that owns it (what the aggregation
 *  hands the Live box). */
export interface LiveControlPublic extends LiveControlDecl {
  module: string;
}

/** The Live box seam (docs/design-decisions/live-controls.md §3). A module
 *  registers the capability signals its live controls gate on; the aggregation
 *  returns, per workspace, the enabled-module live controls whose `requires`
 *  capability the workspace currently satisfies. */
export interface PlatformLive {
  /** Register a capability evaluator (`printer.connected`, `scanner.bridge`, …).
   *  Called per workspace, cheap, cached per aggregation. Idempotent by name. */
  registerCapability(name: string, evaluate: (orgId: string) => Promise<boolean>): void;
  /** The applicable live controls for a workspace (self-hiding = empty array). */
  applicable(orgId: string): Promise<LiveControlPublic[]>;
}

/**
 * A WORKSPACE'S OWN OUTBOUND EMAIL — the one door to somebody who is not a
 * member (a shop's customer), from the workspace's own address through the
 * provider it brought. `notifications` reaches members; this reaches everyone
 * else, and only when the workspace has set it up. Every send is logged by the
 * platform, and names the member who pressed send: there is no automated send
 * to a third party.
 */
export interface PlatformOutboundEmail {
  /** Whether the workspace can send, and from which address. */
  status(orgId: string): Promise<{ configured: boolean; from: string | null }>;
  send(
    orgId: string,
    message: {
      to: string;
      subject: string;
      text: string;
      /** The member who pressed send. */
      sentBy: string;
      replyTo?: string;
      source?: { kind: string; id: string };
    },
  ): Promise<
    | { ok: true; logId: string; messageId: string | null; status: "sent" | "skipped" }
    | { ok: false; logId: string | null; reason: "not_configured" | "no_sender" | "bad_address" | "failed"; message: string }
  >;
  /** The sends about one record, newest first. */
  log(
    orgId: string,
    source: { kind: string; id: string },
  ): Promise<Array<{ id: string; to: string; subject: string; sentBy: string | null; status: "sent" | "failed" | "skipped"; messageId: string | null; error: string | null; at: string }>>;
}

export interface DatedMoney {
  value: import("@cobblr/platform-contract/money").Money;
  day: string;
}
export interface PlatformMoney {
  currency(orgId: string): Promise<string>;
  total(orgId: string, values: readonly DatedMoney[], currency?: string): Promise<import("@cobblr/platform-contract/money").MoneyTotal>;
}

export interface Platform {
  deletedRecords: PlatformDeletedRecords;
  dispositions: PlatformDispositions;
  money: PlatformMoney;
  activity: PlatformActivity;
  events: PlatformEvents;
  tenants: PlatformTenants;
  orgs: PlatformOrgs;
  resolvables: PlatformResolvables;
  db: PlatformDb;
  /** `fetch` against this api's own routes, handled in-process by its app:
   *  the same middleware (auth, tenant, rules) from the same remote address a
   *  loopback call had, with no socket to be refused under load (#4901).
   *  Takes "/api/v1/…" or a loopback URL to its own port; any other URL is an
   *  ordinary fetch, so a caller can pass whatever base it was given. Code in
   *  the api process calls this,
   *  never 127.0.0.1:$API_PORT (lint:no-loopback-to-self). */
  selfFetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  entities: PlatformEntities;
  actions: PlatformActions;
  live: PlatformLive;
  templates: PlatformTemplates;
  wires: PlatformWires;
  health: PlatformHealth;
  recurrence: PlatformRecurrence;
  calendar: PlatformCalendar;
  queue: PlatformQueue;
  exclusive: PlatformExclusive;
  sweeps: PlatformSweeps;
  sharedCache: PlatformSharedCache;
  notifications: PlatformNotifications;
  outboundEmail: PlatformOutboundEmail;
  integrations: PlatformIntegrations;
  ai: PlatformAi;
  units: PlatformUnits;
  nav: PlatformNav;
  edge: PlatformEdge;
  connections: PlatformConnections;
  /** Outside work: services and their jobs (services.md §10). */
  services: PlatformServices;
  egress: PlatformEgress;
  auth: PlatformAuth;
  pairings: PlatformPairings;
  placement: PlatformPlacement;
  categoryAxis: PlatformCategoryAxis;
  tags: PlatformTags;
  fields: PlatformFields;
  catalogs: PlatformCatalogs;
  files: PlatformFiles;
  instances: PlatformInstances;
  scan: PlatformScan;
  shares: PlatformShares;
  devices: PlatformDevices;
  // Hosted-overlay seams (no-op / allow-all in open core):
  entitlements: PlatformEntitlements;
  tidy: PlatformTidy;
  metering: PlatformMetering;
  telemetry: PlatformTelemetry;
  accounts: PlatformAccounts;
  http: PlatformHttp;
  hostedPanels: PlatformHostedPanels;
}

// ── Device substrate seam ────────────────────────────────────────────────────
// Lets a device-touching consumer (the core-devices actuator today; core-print,
// other modules later) reach a DEVICE without owning the connection table or the
// driver registry. The owner of those (digifab today; core-devices after the
// connections move) REGISTERS a provider; consumers call getDriver(). This is the
// `platform().devices` half of the core-devices extraction
// (docs/architecture/core-devices-extraction.md §2) — start of the substrate move
// that doesn't require migrating the connections table.

/** The generic device contract — what EVERY connection can do. Fabrication
 *  drivers (digifab) extend this with file→job→status; a structural superset is
 *  assignable here, so a MachineDriver satisfies it. */
export interface DeviceDriver {
  testConnection?(): Promise<{ ok: boolean; detail?: string }>;
  listDevices?(): Promise<Array<{ id: string; name: string; state?: string | null; enabled?: boolean }>>;
  /** The actuator verb — fire a parameterised command-and-forget. */
  runCommand?(command: string, params: Record<string, unknown>): Promise<{ ok: boolean; ref?: string; detail?: string; data?: Record<string, unknown> }>;
  /** The sensor verb — a point reading. */
  readSensor?(deviceId: string): Promise<{ value: number; unit?: string; at?: string }>;
}

/** Build a driver from a connection ref (id OR label). null when unresolved. */
export type DeviceDriverProvider = (orgId: string, connectionRef: string) => Promise<DeviceDriver | null>;

/** A device connection as returned to clients — NEVER includes credentials. */
export interface DeviceConnectionPublic {
  id: string;
  type: string;
  label: string;
  base_url: string;
  /** WHETHER a credential is stored, never what it is. Callers need this to say
   *  "this needs a token and has none" without being handed the secret, and it
   *  cannot be inferred from `config`: credentials live encrypted in their own
   *  column, so `config` is empty on a connection that authenticates perfectly
   *  well. Reading `config.api_key` to answer this reports "no token" for every
   *  connection that has one. */
  has_credentials: boolean;
  config: Record<string, unknown>;
  enabled: boolean;
  capabilities: Record<string, unknown>;
  last_sync_at: string | Date | null;
  last_sync_status: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

/** Internal shape for building a driver — carries the encrypted credentials. */
export interface DeviceConnectionInternal {
  id: string;
  type: string;
  base_url: string;
  credentials_enc: string;
}

export interface DeviceConnectionCreate {
  type: string;
  label: string;
  base_url: string;
  /** Raw credential fields — the store encrypts them. */
  creds?: Record<string, unknown>;
  config?: Record<string, unknown>;
}

export interface DeviceConnectionPatch {
  label?: string;
  base_url?: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
  /** Raw credential fields to merge; a null value clears that field. */
  creds?: Record<string, unknown>;
}

/** The connection store — implemented by the owner of the connections table
 *  (core-devices); a connection-MANAGING consumer (digifab's CRUD routes) calls
 *  it so the table can live in one place without cross-module table access. */
export interface DeviceConnectionStore {
  list(orgId: string): Promise<DeviceConnectionPublic[]>;
  /** Public shape (no creds) by id. */
  get(orgId: string, id: string): Promise<DeviceConnectionPublic | null>;
  /** Internal shape (with creds) by id OR case-insensitive label — for driver building. */
  getInternal(orgId: string, ref: string): Promise<DeviceConnectionInternal | null>;
  create(orgId: string, input: DeviceConnectionCreate): Promise<DeviceConnectionPublic>;
  update(orgId: string, id: string, patch: DeviceConnectionPatch): Promise<DeviceConnectionPublic | null>;
  remove(orgId: string, id: string): Promise<boolean>;
  /** Stamp the cached probe result (capabilities + last_sync) after a test. */
  setProbe(orgId: string, id: string, capabilities: Record<string, unknown>, status: string): Promise<void>;
}

export interface MachineStationRequest { machine_kind: string; machine_id: string; purpose: "placement" | "reflow" | "inspection"; token: string }
export type MachineStationVerifier = (orgId: string, request: MachineStationRequest) => Promise<{ id: string; label: string }>;

export interface MachineRecordsProvider {
  list(orgId: string, userId?: string | null): Promise<Array<{ kind: string; record: ResolvedEntity }>>;
  get(orgId: string, kind: string, id: string, userId?: string | null): Promise<ResolvedEntity | null>;
}

export interface PlatformDevices {
  registerMachineRecords(provider: MachineRecordsProvider): void;
  machineRecords(orgId: string, userId?: string | null): ReturnType<MachineRecordsProvider["list"]>;
  machineRecord(orgId: string, kind: string, id: string, userId?: string | null): ReturnType<MachineRecordsProvider["get"]>;
  registerStationVerifier(verifier: MachineStationVerifier): void;
  authorizeAtStation(orgId: string, request: MachineStationRequest): Promise<{ id: string; label: string }>;
  /** The connection/driver owner registers this at boot (one provider). */
  registerDriverProvider(provider: DeviceDriverProvider, types?: readonly string[]): void;
  /** Resolve a connection ref to a driver via the registered provider. */
  getDriver(orgId: string, connectionRef: string): Promise<DeviceDriver | null>;
  /** The connections-table owner (core-devices) registers the store at boot. */
  registerConnectionStore(store: DeviceConnectionStore): void;
  /** The connection store, for a connection-managing consumer (digifab CRUD).
   *  Throws if no store is registered (core-devices always registers one). */
  connections(): DeviceConnectionStore;
}

// ── Units (vocabulary owner: core-units) ────────────────────────────────────
// Server-side unit resolution/conversion for modules + the kernel. The
// vocabulary AND the conversion math live in core-units (see
// scripts/lint-unit-conversion.ts — nothing else may hand-roll factors);
// this surface is how any consumer asks. A field def's declared `unit`
// resolved here is what gives a number machine-readable physical semantics
// (a length-category unit IS a length) — never the field's name.

/** A resolved unit: identity + category + the category-base factor when
 *  convertible (count-style units carry none). */
export interface PlatformUnitInfo {
  code: string;
  symbol: string;
  name: string;
  plural: string;
  category: string;
  factor?: number;
}

export interface UnitsService {
  /** Resolve a raw unit string ("mm", "grams") against the built-in
   *  vocabulary + the org's custom units. Null when unknown. */
  resolve(orgId: string, raw: string): Promise<PlatformUnitInfo | null>;
  /** Convert between raw unit strings (same category, both factored).
   *  Null when not convertible. */
  convert(orgId: string, value: number, fromRaw: string, toRaw: string): Promise<number | null>;
}

/** The shape of the navigation: the headings a workspace has grouped its
 *  sections under.
 *
 *  Here because it was the one thing the assistant could describe and not do.
 *  Asked to group two sections under a parent he answered correctly and then
 *  printed "[Take user to Presentation configuration screen]" — a stage
 *  direction, because nav lived in kernel routes with no action behind it and
 *  signposting was all he had. A capability the user can reach and Cobb cannot
 *  is a capability half-built. */
export interface PlatformNav {
  /** Every heading, with what sits under it. */
  listHeadings(orgId: string): Promise<
    Array<{
      id: string;
      name: string;
      members: Array<{ target_kind: string; target_id: string }>;
    }>
  >;
  createHeading(orgId: string, name: string, icon?: string | null): Promise<{ id: string }>;
  /** Move a nav entry under a heading. An entry belongs to at most one, so this
   *  takes it out of any other. */
  addMember(orgId: string, headingId: string, targetKind: string, targetId: string): Promise<void>;
  removeMember(orgId: string, targetKind: string, targetId: string): Promise<void>;
  deleteHeading(orgId: string, headingId: string): Promise<void>;
  /** What can go under a heading, with the names a person would use for them —
   *  so a request naming "Spices" can be resolved without the caller knowing
   *  what an instance id looks like. */
  listEntries(orgId: string): Promise<Array<{ kind: string; id: string; label: string }>>;
}

export interface PlatformUnits {
  /** The vocabulary owner (core-units) registers this at load. */
  registerService(svc: UnitsService): void;
  /** Null when unknown, or when no service is registered (core-units off) —
   *  consumers degrade to "no physical semantics", never guess. */
  resolve(orgId: string, raw: string): Promise<PlatformUnitInfo | null>;
  convert(orgId: string, value: number, fromRaw: string, toRaw: string): Promise<number | null>;
}

export { isPlatformSet, platform, setPlatform } from "@cobblr/platform-contract/platform-runtime";

/** A route's upload middleware through the one upload door
 *  (platform().http.upload), built on its first request so a module can
 *  declare its router before the platform is set. */
export function uploadOne(opts: UploadOptions): UploadMiddleware {
  let door: UploadMiddleware | null = null;
  return (req, res, next) => {
    door ??= platform().http.upload(opts);
    door(req, res, next);
  };
}

// ── AI-reply JSON hygiene ────────────────────────────────────────────────────
// Every AI surface that asks a model for JSON (scan matchmaker, the bundle
// builder's intent-match + describe-it→bundle, barcode/photo identify) hits the
// same problem: cheaper / smaller models (Haiku, local Ollama) garble strict
// JSON — markdown fences, trailing commas, smart quotes, truncated output,
// unescaped quotes in a string. A single garble used to drop the whole result.
// These pure helpers recover the structured object from imperfect output, so
// ONE source of truth serves every module (modules can't import each other; they
// all import this contract). Each caller keeps its own thin wrapper for its
// shape (the matchmaker's `candidates`, core-authoring's `bundle`).

/** The wire engine's source-entity payload-key convention, in ONE place so
 *  emitters and the engine agree without anyone hardcoding a foreign kind.
 *  An emitter that references another entity puts its id under the key derived
 *  from that entity's kind: the suffix after `:` , camelCased, + "Id". So
 *  "inventory:part" → "partId", "purchases:order_item" → "orderItemId". The
 *  wire engine derives the same key from a binding's source_kind to read it
 *  back. (Lets `lists` restock whatever seeded a checked line without a
 *  `kind === "inventory:part"` branch — audit 2026-06-26 burn-down.) */
export function sourceIdKey(kind: string): string {
  const suffix = kind.split(":")[1] ?? "";
  const camel = suffix.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  return `${camel}Id`;
}

/** Extract the first BALANCED `{…}` object from a model reply, tolerant of
 *  ```fences``` + leading/trailing prose. Brace-matches OUTSIDE strings; returns
 *  the object substring, or — if the output was truncated mid-object — from the
 *  first `{` to the end (repairJson then closes it). null if there's no `{`. */
export function extractJsonObject(s: string): string | null {
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1]! : s;
  const start = body.indexOf("{");
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return body.slice(start, i + 1);
  }
  return body.slice(start);
}

/** Best-effort repair of common cheap-model JSON breakage, applied only AFTER a
 *  clean parse fails: curly "smart quotes" used as delimiters → straight, drop
 *  trailing commas, terminate an unclosed string, and balance unclosed `{`/`[`
 *  (truncation). Quote/bracket tracking skips characters inside strings. A
 *  structural/semantic error survives untouched for the caller's validator. */
export function repairJson(s: string): string {
  let out = s.replace(/[“”]/g, '"').replace(/,(\s*[}\]])/g, "$1");
  const stack: string[] = [];
  let inStr = false, esc = false;
  for (let i = 0; i < out.length; i++) {
    const ch = out[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }
  if (inStr) out += '"';
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i] === "{" ? "}" : "]";
  return out;
}

/** Parse a model JSON reply into an object, recovering from fences/prose/
 *  commas/smart-quotes/truncation. Layered: as-is → repaired. Returns the parsed
 *  value (typed by the caller) or null when nothing salvageable — the caller may
 *  then retry the model or fall back. */
export function parseJsonReply<T = unknown>(content: string): T | null {
  const obj = extractJsonObject(content);
  if (!obj) return null;
  for (const candidate of [obj, repairJson(obj)]) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      /* try the next repair */
    }
  }
  return null;
}

// Facts tagged by ROLE, landed on whatever the workspace calls those things.
//
// TWO rules, and the second one is the one that keeps getting broken:
//
//   1. Never match on a field's NAME. A mapper looking for `acquired_from`
//      works in exactly the workspace that inspired it and silently does
//      nothing in every other.
//   2. Never enumerate the CONCEPTS either. An earlier version of this had one
//      branch per role and a four-property input type, so adding a fifth fact
//      meant editing the mapper. That is the same hardcoding as rule 1, moved
//      one level up and easier to miss, because the field names were generic
//      and it therefore looked finished.
//
// So this layer knows nothing about receipts, vendors, or prices. It is a
// matcher: role-tagged facts in, metadata keys out. Adding a fact means adding
// a role to the vocabulary and teaching the EXTRACTOR to produce it. Nothing
// here changes.
//
// Pure: no db, no platform(), no module imports.
// Lives in the contract because the scan inbox owns the confirm path and a
// module may not import api internals.
//
// See docs/design-decisions/arrivals.md.

/** What was found, keyed by what it MEANS. The extractor owns every judgment
 *  about which fact is which; this layer owns only where each one lands. */
export type RoledFacts = Partial<Record<FieldRole, string | number>>;

/** The subset of a field def the matcher needs. Structural so callers can pass
 *  their own rows without a conversion step. */
export interface RoledField {
  name: string;
  field_role?: string | null;
  type?: string | null;
  choices?: string[] | null;
  /** A column of the kind's own (a vehicle's Paid, Purchased at), written
   *  through the kind's writer, never into metadata. */
  native?: boolean;
  /** How a native money column stores its amount; a fact's money is put in
   *  that unit (cents) before it is written. */
  money?: "cents" | "amount" | null;
  /** The list is open: a value off it is still this field's value (field-choices
   *  `choiceLearns`, decided by whoever hands the field over). A parser's value
   *  is written but never added to the list. Absent = a closed list. */
  learns?: boolean | null;
}

/** One workspace-defined field on a kind, as `fieldsFor` reports it. */
export interface DefinedField extends RoledField {
  ref_kind?: string | null;
  display_label: string;
  type: string;
  /** The declared unit of a number field ("m", "g"), when it has one. */
  unit?: string | null;
  /** A computed field's template ("{{ length_per_skein }}"). */
  template?: string | null;
  /** Once filled, an update may not empty it. A create may leave it empty:
   *  capture comes before structure, and the record then shows what it needs. */
  required?: boolean;
  /** The owner marked it private: shares and public pages leave it out unless
   *  they show private notes (@cobblr/platform-contract/share-scope). */
  private?: boolean;
}

export interface MappedValue {
  /** The key to write: a metadata key, or a native column when `native`. */
  key: string;
  /** A column of the kind's own: written through the kind's writer. */
  native?: boolean;
  value: string | number;
  /** Which role put it there, so a confirm UI can explain itself. */
  role: FieldRole;
  /** True when this rode in as a clarifier beside another field's value rather
   *  than as a value in its own right. */
  isNote?: boolean;
  /** Set when the value is not in that field's `choices` yet, so the UI can
   *  OFFER to add it rather than adding it silently. */
  unlistedChoice?: boolean;
}



/**
 * Land each fact on the field that declares its role.
 *
 * A workspace declaring no roles gets an empty result, which is today's
 * behaviour and stays correct: nothing is invented and no field is created.
 */
export function mapRoledFacts(
  facts: RoledFacts,
  fields: readonly RoledField[],
): MappedValue[] {
  const byRole = new Map<string, RoledField>();
  for (const f of fields) {
    if (f.field_role && !byRole.has(f.field_role)) byRole.set(f.field_role, f);
  }

  const out: MappedValue[] = [];
  for (const [r, value] of Object.entries(facts)) {
    const role = r as FieldRole;
    if (value == null || value === "") continue;

    const field = byRole.get(role);
    if (field) {
      const unlisted = field.learns !== true && typeof value === "string" && (field.choices?.length ?? 0) > 0 && !isListedChoice(value, field.choices!);
      // A money fact is an amount; a column that keeps cents gets cents.
      const stored = field.money === "cents" && typeof value === "number" ? centsFromAmount(value) : value;
      out.push({ key: field.name, value: stored, role, ...(field.native ? { native: true } : {}), ...(unlisted ? { unlistedChoice: true } : {}) });
      continue;
    }

    // No field of its own. If this role clarifies another, ride along there.
    const hostRole = ROLE_CLARIFIES[role];
    const host = hostRole ? byRole.get(hostRole) : undefined;
    if (host) out.push({ key: fieldNoteKey(host.name), value, role, isNote: true });
  }
  return out;
}

/** The metadata patch, for a caller that just wants to write it. Values the UI
 *  must confirm first (an unlisted choice) are EXCLUDED: offering to add a
 *  choice and then adding it anyway would make the offer decorative. A value
 *  for a native column is not metadata and is left out: `roledNativePatch`
 *  has it. */
export function roledFactsPatch(mapped: readonly MappedValue[]): Record<string, string | number> {
  const patch: Record<string, string | number> = {};
  for (const m of mapped) {
    if (m.unlistedChoice || m.native) continue;
    patch[m.key] = m.value;
  }
  return patch;
}

/** The writes for the kind's own columns (a vehicle's Paid, Purchased at,
 *  Bought from), for the kind's writer. */
export function roledNativePatch(mapped: readonly MappedValue[]): Record<string, string | number> {
  const patch: Record<string, string | number> = {};
  for (const m of mapped) {
    if (m.unlistedChoice || !m.native) continue;
    patch[m.key] = m.value;
  }
  return patch;
}

// ── Putting a row back exactly as it was ────────────────────────────────────
//
// Undo means the workspace returns to the state it held, not that an opposite
// operation is performed. Those differ where it matters: a delete undone by
// CREATING a lookalike gives the record a new id, so every child location,
// every label and every part that pointed at it now points at nothing. And a
// re-create runs the forward-write rules again, so a restore can be refused by
// a rule the original write predates — undoing a deleted "Shelf 1" fails
// because a "Shelf 1" exists, which is precisely the state being restored.

/** Keep only the columns a table actually has. An image is a RESOLVED record
 *  and may carry computed or joined keys the table would reject. */
export function restorableColumns<T extends string>(
  image: Record<string, unknown>,
  columns: readonly T[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of columns) if (image[c] !== undefined) out[c] = image[c];
  return out;
}

/** The id an image is for, or null when it carries none — nothing to restore
 *  TO, so the caller recreates and says that is what it did. */
export function imageId(image: Record<string, unknown>): string | null {
  const id = (image as { id?: unknown }).id;
  return typeof id === "string" && id ? id : null;
}

export function registerRowHistoryWriter(kind: string, table: string): void {
  const prefix = `${kind.split(":")[0]!.replace(/-/g, "_")}_`;
  platform().activity.registerHistoryWriter(kind, {
    table,
    snapshotDeletion: async (orgId, id) => snapshotRowTree(await platform().tenants.getDb(orgId), table, id, prefix),
    restoreDeletion: async (orgId, snapshot) => restoreRowTree(await platform().tenants.getDb(orgId), table, snapshot, prefix),
    snapshot: async (orgId, id) => snapshotRow(await platform().tenants.getDb(orgId), table, id),
    restore: async (orgId, image) => restoreRow(await platform().tenants.getDb(orgId), table, image),
  });
}

/** The whole of a module's `snapshot`: every column of one row, by id. */
export async function snapshotRow(
  db: unknown,
  table: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const q = db as { selectFrom: (t: string) => any };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const row = await q.selectFrom(table).selectAll().where("id", "=", id).executeTakeFirst();
  return (row as Record<string, unknown> | undefined) ?? null;
}

/** The whole of a writer's `findByKey`: the id of the row whose column, or
 *  `metadata` key, equals `value`, oldest first; null when none. One copy for
 *  every sync target, so a sync adopts a record the same way whichever module
 *  owns it (#3836). The field name is an identifier and is checked as one:
 *  it comes from a sync mapping, which a workspace can author. */
/** A writer's `mergeMetadata`, the same for every module's table: these
 *  keys set (a null removes one), every other key as the live row holds it,
 *  in one statement (`platform().db.mergeJsonb`). */
export async function mergeRowMetadata(db: unknown, table: string, id: string, fields: Record<string, unknown>): Promise<void> {
  if (Object.keys(fields).length === 0) return;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const q = db as { updateTable: (t: string) => any };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  await q
    .updateTable(table)
    .set({ metadata: platform().db.mergeJsonb("metadata", fields), updated_at: new Date() })
    .where("id", "=", id)
    .execute();
}

/** A writer's `version`: the row's version (`platform().db.rowVersion`). */
export async function rowVersionOf(db: unknown, table: string, id: string): Promise<string | null> {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const q = db as { selectFrom: (t: string) => any };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const row = (await q.selectFrom(table).select(platform().db.rowVersion()).where("id", "=", id).executeTakeFirst()) as { row_version?: string } | undefined;
  return row?.row_version ?? null;
}

/** A writer's `updateIf`: the same patch its `update` writes, only while the
 *  row is at `version`, in one statement. The new version, or null when the
 *  row moved on (or is gone) and nothing was written. */
export async function updateRowAt(db: unknown, table: string, id: string, patch: Record<string, unknown>, version: string): Promise<string | null> {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const q = db as { updateTable: (t: string) => any };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const row = (await q.updateTable(table).set(patch).where("id", "=", id).where(platform().db.atVersion(version)).returning(platform().db.rowVersion()).executeTakeFirst()) as { row_version?: string } | undefined;
  return row?.row_version ?? null;
}

/** A writer's `adoptAxisValues` for a kind whose category is a native text
 *  field (`categoryField`): the scan placeholder's value under
 *  `metadata[field]` moves into `column` when the record has nothing there
 *  (a value somebody typed stays), then the key is dropped. A placeholder
 *  word ("unknown", "n/a") moves nowhere. Idempotent; `remaining` counts the
 *  records still holding the key, and the platform removes the field at 0. */
export async function adoptAxisValuesIntoField(
  db: unknown,
  table: string,
  args: { field: string; column: string },
): Promise<{ moved: number; remaining: number }> {
  if (!/^[a-z_][a-z0-9_]*$/i.test(args.column) || !/^[a-z_][a-z0-9_]*$/i.test(args.field)) return { moved: 0, remaining: 0 };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const q = db as { selectFrom: (t: string) => any; updateTable: (t: string) => any };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const rows = (await q.selectFrom(table).select(["id", args.column, "metadata"]).execute()) as Array<Record<string, unknown>>;
  let moved = 0;
  let remaining = 0;
  for (const row of rows) {
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    if (!(args.field in meta)) continue;
    const raw = meta[args.field];
    const value = typeof raw === "string" ? raw.trim() : "";
    const current = typeof row[args.column] === "string" ? String(row[args.column]).trim() : "";
    const set: Record<string, unknown> = { metadata: platform().db.mergeJsonb("metadata", { [args.field]: null }) };
    if (!current && value && !isJunkCategory(value)) {
      set[args.column] = value;
      moved++;
    }
    try {
      await q.updateTable(table).set(set).where("id", "=", row.id).execute();
    } catch {
      remaining++;
    }
  }
  return { moved, remaining };
}

export async function findRowIdByKey(
  db: unknown,
  table: string,
  key: { field: string; metadata: boolean },
  value: string,
): Promise<string | null> {
  if (!/^[a-z_][a-z0-9_]*$/i.test(key.field) || !value) return null;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const q = db as { selectFrom: (t: string) => any };
  let query = q.selectFrom(table).select("id");
  query = key.metadata
    ? query.where((eb: any) => eb(eb.ref("metadata", "->>").key(key.field), "=", value))
    : query.where(key.field, "=", value);
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const row = await query.orderBy("created_at", "asc").limit(1).executeTakeFirst();
  return (row as { id?: string } | undefined)?.id ?? null;
}

/** The whole of a module's `restore`, so four modules do not keep four copies
 *  of it in step — and so a column added by a migration is restored the day it
 *  exists, instead of the day someone remembers to add it to a list here.
 *
 *  Idempotent by id (insert, or overwrite what is there), because a batch undo
 *  that stopped halfway has to be pressable again. */
export async function restoreRow(
  // Structurally a Kysely instance. Typed loosely on purpose: the contract must
  // not take a dependency on any module's generated DB types, and every caller
  // hands it whatever `tenants.getDb` returned.
  db: unknown,
  table: string,
  image: Record<string, unknown>,
): Promise<void> {
  const id = imageId(image);
  if (!id) throw new Error("that change has no record to put back");
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const q = db as { selectFrom: (t: string) => any; insertInto: (t: string) => any };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const all: Array<{ column_name: string; data_type: string; is_generated: string; identity_generation: string | null }> = (
    await q
      .selectFrom("information_schema.columns")
      .select(["column_name", "data_type", "is_generated", "identity_generation"])
      .where("table_name", "=", table)
      .execute()
  ) as Array<{ column_name: string; data_type: string; is_generated: string; identity_generation: string | null }>;
  if (all.length === 0) throw new Error(`unknown table ${table}`);
  // A column the database computes (a search vector generated from the name,
  // an always-identity) is not part of the state to put back, and Postgres
  // refuses any value for it: restoring a part failed on `search_blob` until
  // these were left to the database.
  const cols = all.filter((c) => c.is_generated !== "ALWAYS" && c.identity_generation !== "ALWAYS");
  const json = new Set(cols.filter((c) => /json/i.test(c.data_type)).map((c) => c.column_name));
  const row: Record<string, unknown> = {};
  for (const c of cols) {
    const v = image[c.column_name];
    if (v === undefined || c.column_name === "id") continue;
    // A jsonb column arrives from an image as a parsed object; hand the driver
    // text and let Postgres cast it, or it stores the string "[object Object]".
    row[c.column_name] = json.has(c.column_name) && v !== null && typeof v === "object" ? JSON.stringify(v) : v;
  }
  await q
    .insertInto(table)
    .values({ ...row, id })
    .onConflict((oc: { column: (c: string) => { doUpdateSet: (r: unknown) => unknown } }) =>
      oc.column("id").doUpdateSet(row),
    )
    .execute();
}

// ── text search over a list's columns ─────────────────────────────────────
// Lives here rather than in its own file: the contract is loaded buildless by
// node at boot (lint:node-resolves), which does not rewrite a "./x.js"
// re-export the way tsc and tsx do.
// One meaning for `q` on a list: "any text this record carries contains it".
//
// Every module used to hand-roll the where clause, and each one chose its own
// columns: machines matched the name only, sales matched the name only, tags
// the name, purchase lines the description. To a person "the Bambu one" is a
// manufacturer and "my deltas" is a type, and to the assistant `q` is a text
// search, so a name-only resolver answered "you have no Bambu" about a
// workspace with one (2026-08-27). The clause is the same in every module;
// only the column list differs, and that is all a resolver should have to say.
//
// Structurally typed on purpose: this package has no kysely dependency, and a
// resolver hands in its own `eb`. The shape used here (`eb(lhs, op, rhs)`,
// `eb.fn`, `eb.or`, `eb.cast`) is Kysely's expression builder from 0.26 on.

/** The slice of Kysely's ExpressionBuilder this helper needs.
 *
 *  Typed with `any` on purpose: the real builder's parameters are
 *  ReferenceExpression<DB, TB> for the caller's own tables, which this package
 *  cannot name without depending on kysely and on every module's schema. The
 *  caller's `eb` is fully typed at the call site; this interface only has to
 *  accept it, and the SQL it produces is what the api tests check. */
export interface LikeFnModule {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (name: "lower" | "jsonb_path_exists" | "jsonb_path_query_array", args: any[]): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  coalesce(...args: any[]): any;
}
export interface LikeBuilder {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (lhs: any, op: "like", rhs: any): any;
  fn: LikeFnModule;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  or(exprs: any[]): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cast(expr: any, to: "text"): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  val(value: any): any;
  /** Every one of these (Kysely's builder has it; a hand-written fake may
   *  not, and then a search runs without reading values). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  and?(exprs: any[]): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  not?(expr: any): any;
}

/** The column names the caller's Kysely expression builder accepts: its
 *  `ref()` parameter, i.e. the columns of the table(s) being queried. A name
 *  the table does not have is a TYPE error here, not a `column "…" does not
 *  exist` in production. That is how a search on orders named `description`
 *  and a search on projects named `title` shipped and failed every search on
 *  every surface for weeks (#3824): these lists used to be plain strings.
 *  A builder with no `ref` (a hand-written fake) falls back to string. */
export type ColumnOf<EB> = EB extends { ref: (reference: infer R) => unknown } ? Extract<R, string> : string;

export interface TextSearchColumns<EB = unknown> {
  /** Plain text columns. A NULL never matches and never breaks the OR. */
  text: readonly ColumnOf<EB>[];
  /** jsonb columns searched as text (custom fields live in `metadata`). */
  json?: readonly ColumnOf<EB>[];
  /** A jsonb array of the record's measured values read off its text
   *  (`measureReadings`), so a value still typed as text is found by value. */
  readings?: ColumnOf<EB>;
}

/** A set of column names checked against a table's row type, for the lists a
 *  resolver keeps at module scope (what may be sorted by, filtered on,
 *  compared). `columnSet<PurchasesDB["purchases_orders"]>()(["ordered_at"])`:
 *  a column the row type does not have fails typecheck (#3824). */
export function columnSet<Row>() {
  return <C extends keyof Row & string>(columns: readonly C[]): ReadonlySet<string> => new Set<string>(columns);
}

/** What a person typed, made literal inside a LIKE pattern: `%` and `_` are
 *  wildcards to Postgres and a backslash is its escape, so "50%" matched every value
 *  holding "50" and "a_b" matched "axb". A pattern built from a person's text
 *  goes through here (lint:like-needles-are-escaped). */
export function likeEscape(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** The needle a person typed, as the like pattern every resolver uses:
 *  lower-cased, escaped, and matched anywhere. */
export function likeNeedle(q: string): string {
  return `%${likeEscape(q.toLowerCase())}%`;
}

/**
 * The where-expression for `q` over the listed columns, or null when `q` is
 * empty (so a resolver can write `const w = textSearchWhere(...); if (w) query =
 * query.where(w)`). Case-insensitive, substring, every column OR-ed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function textSearchWhere<EB extends LikeBuilder>(eb: EB, q: string | undefined, columns: TextSearchColumns<EB>): any {
  const needle = (q ?? "").trim();
  if (!needle) return null;
  const empty = eb.val("");
  const anywhere = (text: string): any[] => {
    const like = likeNeedle(text);
    return [
      ...columns.text.map((c: string) => eb(eb.fn("lower", [eb.fn.coalesce(c, empty)]), "like", like)),
      ...(columns.json ?? []).map((c: string) => eb(eb.fn("lower", [eb.cast(eb.fn("jsonb_path_query_array", [c, eb.val("$.* ? (!exists(@.__cobblr_secret))")]), "text")]), "like", like)),
    ];
  };
  const exprs = anywhere(needle);
  if (exprs.length === 0) return null;
  const hasValues = !!(columns.json?.length || columns.readings);
  const read = hasValues && eb.and && eb.not ? measureTokens(needle) : null;
  if (!read) return eb.or(exprs);
  return valueSearchWhere(eb, read, {
    text: anywhere,
    fields: (columns.json ?? []) as readonly string[],
    readings: columns.readings as string | undefined,
  });
}

/**
 * A search that names values ("10k", "100 nF 16V ceramic"): every word has to
 * be found somewhere, and each VALUE is found by value (±1%, in its unit) in a
 * measure field or a reading, or else as text, but never as the text of a
 * record that holds that number in another unit. So 4k7 finds the resistor
 * typed "4.7 kΩ" and 10k never finds the 10 kHz crystal, even one titled
 * "10kHz". `text` is the caller's own text match for one word.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function valueSearchWhere<EB extends LikeBuilder>(
  eb: EB,
  read: NonNullable<ReturnType<typeof measureTokens>>,
  opts: { text: (word: string) => any[]; fields?: readonly string[]; readings?: string },
): any {
  const at = (column: string, path: string, vars: string) =>
    // Untyped parameters: Postgres reads them as jsonpath and jsonb from the
    // function's own signature.
    eb.fn("jsonb_path_exists", [column, eb.val(path), eb.val(vars)]);
  const holds = (m: Measure, which: "same" | "other"): any[] => {
    const paths = measurePaths(m);
    const p = paths[which];
    if (!p) return [];
    return [
      ...(opts.fields ?? []).map((c) => at(c, p.fields, paths.vars)),
      ...(opts.readings ? [at(opts.readings, p.readings, paths.vars)] : []),
    ];
  };
  const every = [
    ...read.words.map((w) => eb.or(opts.text(w))),
    ...read.values.map((v) => {
      const asText = eb.or(opts.text(v.text));
      const elsewhere = holds(v.measure, "other");
      return eb.or([...holds(v.measure, "same"), elsewhere.length ? eb.and!([asText, eb.not!(eb.or(elsewhere))]) : asText]);
    }),
  ];
  return eb.and!(every);
}

export interface TidyRecord { kind: string; id: string; name: string; url?: string }
export interface TidyCandidate {
  id: string;
  kind: string;
  records: TidyRecord[];
  action: { route: string; bundle_id?: string; action_id?: string; args?: Record<string, unknown>; steps?: Array<{ action_id: string; args: Record<string, unknown> }> };
  why: string;
  priority: number;
}
export interface TidyFinderContext {
  orgId: string;
  now: Date;
  lastRun: Date | null;
  shapeChanged: boolean;
  as: { userId: string; orgSlug: string };
  memo<T>(key: string, fingerprint: string, compute: () => Promise<T>): Promise<T>;
  classify(item: Record<string, unknown>, collections: Array<{ name: string; label: string; noun: string }>): Promise<string | null>;
}
export interface PlatformTidy {
  registerFinder(finder: { id: string; module?: string; find(ctx: TidyFinderContext): Promise<TidyCandidate[]> }): void;
}

export interface DeletedRowTree {
  rows: Array<{ table: string; row: Record<string, unknown> }>;
  cleared: Array<{ table: string; column: string; row: Record<string, unknown> }>;
}

/** Single-column foreign keys in the public schema that point at `table`
 *  and cascade or clear on delete: the child table and column, the parent
 *  column, and the rule. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function foreignKeysInto(q: any, table: string): Promise<Array<{ table: string; column: string; parentColumn: string; rule: string }>> {
  const parent = await q.selectFrom("pg_catalog.pg_class as p").innerJoin("pg_catalog.pg_namespace as n", "n.oid", "p.relnamespace")
    .select("p.oid").where("n.nspname", "=", "public").where("p.relname", "=", table).executeTakeFirst() as { oid: number } | undefined;
  if (!parent) return [];
  const cons = await q.selectFrom("pg_catalog.pg_constraint as c").innerJoin("pg_catalog.pg_class as child", "child.oid", "c.conrelid")
    .innerJoin("pg_catalog.pg_namespace as cn", "cn.oid", "child.relnamespace")
    .select(["child.relname as table", "c.conrelid", "c.conkey", "c.confkey", "c.confdeltype"])
    .where("c.contype", "=", "f").where("c.confrelid", "=", parent.oid).where("cn.nspname", "=", "public").where("c.confdeltype", "in", ["c", "n"])
    .execute() as Array<{ table: string; conrelid: number; conkey: number[] | string; confkey: number[] | string; confdeltype: string }>;
  const nums = (v: number[] | string) => (Array.isArray(v) ? v : String(v).replace(/[{}]/g, "").split(",").filter(Boolean)).map(Number);
  const single = cons.filter((c) => nums(c.conkey).length === 1 && nums(c.confkey).length === 1);
  if (!single.length) return [];
  const attrs = await q.selectFrom("pg_catalog.pg_attribute").select(["attrelid", "attnum", "attname"])
    .where("attrelid", "in", [...new Set([parent.oid, ...single.map((c) => c.conrelid)])]).where("attnum", ">", 0).execute() as Array<{ attrelid: number; attnum: number; attname: string }>;
  const name = (rel: number, num: number) => attrs.find((a) => Number(a.attrelid) === Number(rel) && Number(a.attnum) === num)?.attname;
  return single.flatMap((c) => {
    const column = name(c.conrelid, nums(c.conkey)[0]!);
    const parentColumn = name(parent.oid, nums(c.confkey)[0]!);
    return column && parentColumn ? [{ table: c.table, column, parentColumn, rule: c.confdeltype === "c" ? "CASCADE" : "SET NULL" }] : [];
  });
}

export async function snapshotRowTree(db: unknown, table: string, id: string, prefix: string): Promise<DeletionSnapshot | null> {
  const image = await snapshotRow(db, table, id);
  if (!image) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q = db as any;
  const related: DeletedRowTree = { rows: [], cleared: [] };
  const seen = new Set<string>();
  // The foreign keys pointing at a table, read once per table per snapshot
  // from pg_catalog. information_schema answered the same in tens of
  // milliseconds a row, more on a loaded box and in a workspace with many
  // tables, and a send or its Undo snapshots every record it touches.
  const keys = new Map<string, Promise<Array<{ table: string; column: string; parentColumn: string; rule: string }>>>();
  const childKeys = (parentTable: string) => {
    let got = keys.get(parentTable);
    if (!got) keys.set(parentTable, (got = foreignKeysInto(q, parentTable)));
    return got;
  };
  const visit = async (parentTable: string, row: Record<string, unknown>): Promise<void> => {
    const key = `${parentTable}:${String(row.id ?? JSON.stringify(row))}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (parentTable !== table || row.id !== id) related.rows.push({ table: parentTable, row });
    const fks = await childKeys(parentTable);
    for (const fk of fks) {
      if (!fk.table.startsWith(prefix) || row[fk.parentColumn] == null) continue;
      const children = await q.selectFrom(fk.table).selectAll().where(fk.column, "=", row[fk.parentColumn]).execute() as Array<Record<string, unknown>>;
      for (const child of children) {
        if (fk.rule === "CASCADE") await visit(fk.table, child);
        else related.cleared.push({ table: fk.table, column: fk.column, row: child });
      }
    }
  };
  await visit(table, image);
  return { image, related };
}

export async function restoreRowTree(db: unknown, table: string, snapshot: DeletionSnapshot, prefix: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q = db as any;
  const related = snapshot.related as DeletedRowTree | undefined;
  const insert = async (t: string, image: Record<string, unknown>) => {
    if (!t.startsWith(prefix)) throw new Error("That saved row belongs to another app.");
    const cols = await q.selectFrom("information_schema.columns").select(["column_name", "data_type", "is_generated", "identity_generation"])
      .where("table_schema", "=", "public").where("table_name", "=", t).execute() as Array<{ column_name: string; data_type: string; is_generated: string; identity_generation: string | null }>;
    const row: Record<string, unknown> = {};
    for (const c of cols) {
      if (c.is_generated === "ALWAYS" || c.identity_generation === "ALWAYS" || image[c.column_name] === undefined) continue;
      const v = image[c.column_name];
      row[c.column_name] = /json/i.test(c.data_type) && v !== null && typeof v === "object" ? JSON.stringify(v) : v;
    }
    await q.insertInto(t).values(row).onConflict((oc: { doNothing(): unknown }) => oc.doNothing()).execute();
  };
  await insert(table, snapshot.image);
  for (const r of related?.rows ?? []) await insert(r.table, r.row);
  for (const r of related?.cleared ?? []) {
    if (!r.table.startsWith(prefix) || !r.row.id) continue;
    await q.updateTable(r.table).set({ [r.column]: r.row[r.column] }).where("id", "=", r.row.id).where(r.column, "is", null).execute();
  }
}

export function canPurgeDeletedRecord(role: string, deletedBy: string | null, userId: string): boolean {
  // role-gate: exact. Permanent removal of someone else's deletion belongs to
  // workspace owners and admins; editors may remove only their own deletions.
  return role === "owner" || role === "admin" || deletedBy === userId;
}
