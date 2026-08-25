// The platform contract — types and validators that modules import
// when registering with cobblr-core. Modules MUST NOT import from
// @cobblr/api directly; everything they need crosses through here.
//
// Phase 0 ships the stub: the typed manifest schema, defineModule(),
// and intent declaration shape. Module loading wires onto these in
// later phases.

import { z } from "zod";
import type { DateFieldDirection } from "@cobblr/platform-contract/date-field-direction";

export type { DateFieldDirection } from "@cobblr/platform-contract/date-field-direction";
export { dateFieldDirection, canBeOverdue, dateEventTitle } from "@cobblr/platform-contract/date-field-direction";
export { pluralise, countOf, itemNounFor } from "@cobblr/platform-contract/plural";
export { expiryState, expiryPhrase, EXPIRING_WITHIN_DAYS, type ExpiryState, type ExpiryReading } from "@cobblr/platform-contract/expiry-grace";
export { keepMembers, isMember, parcelAudience } from "@cobblr/platform-contract/membership";
export { destinationLabel, normaliseTargetKind, betterDestination, type DestinationTable } from "@cobblr/platform-contract/destination-label";
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
/** Every field TYPE a custom field can have. ONE shared list, for the same
 *  reason FIELD_ROLE_VALUES is one: this union was hand-written in five places
 *  and had already drifted three different ways. `relation` reached the bundle
 *  manifest and the read types but never the write route or the field-builder
 *  picker, so a relation field was creatable only by authoring a bundle — a
 *  half-finished feature that looked finished from every angle except the one
 *  a user stands in. `lint:field-type-enum` fails a hand-written copy.
 *
 *  A site that legitimately allows FEWER types states so explicitly
 *  (`FieldTypeSchema.exclude([...])` with a reason), so a restriction is always
 *  a decision rather than an omission nobody noticed. */
export const FIELD_TYPE_VALUES = [
  "text",
  "number",
  "boolean",
  "date",
  "url",
  "richtext",
  "computed",
  "relation",
  // A person. Stored as a user id; rendered as their display name, resolved at
  // READ time so a rename propagates instead of leaving stale snapshots. This
  // is the type the `assignee` role sits on — see
  // design-decisions/household-accountability.md §1.
  "member",
] as const;
export type FieldDefType = (typeof FIELD_TYPE_VALUES)[number];
export const FieldTypeSchema = z.enum(FIELD_TYPE_VALUES);

/** What a field MEANS, as opposed to what it is called.
 *
 *  A role is the semantic identity of a field. "Best before" and "Use by" are
 *  the same idea, and once both declare `expiry`, anything built on that idea
 *  works on both without knowing either name. The name is a local label and a
 *  storage key; the role is what two workspaces can agree on.
 *
 *  DELIBERATELY CLOSED, and that is the feature. A free-text role is a synonym
 *  generator: one pack says `acquired-from`, another says `where-from`, both
 *  install cleanly, and the user ends up with two fields for one concept and no
 *  error anywhere. Every value here is a word the whole platform commits to, so
 *  adding one is a real decision. See docs/design-decisions/field-packs.md.
 *
 *  The `acquired-*` group answers "how did this come to be mine", which a
 *  receipt can fill in without anybody typing (docs/design-decisions/arrivals.md):
 *    acquired-from  where it came from: the shop, the marketplace, the person
 *    acquired-on    when it became yours
 *    acquired-for   what it cost you: net of discounts, before tax
 *    seller         WHO sold it, when that differs from where you bought it
 *                   (a marketplace listing has both, and they are not the same
 *                   fact; absent this field the seller rides as the clarifier on
 *                   acquired-from instead) */
/** A choice field's durable VALUE lives at `<name>`; its one-off CLARIFIER lives
 *  at `<name>_note` in the same metadata bag ("eBay" + "detroitaxle", rendered
 *  "eBay · detroitaxle").
 *
 *  Identity is the value alone: grouping, filters, counts and matching never
 *  look at the note, or one choice would fragment into many. Search does.
 *
 *  Defined HERE, not in platform-web, because the receipt mapper writes these
 *  keys server-side and the field panel reads them client-side. Two copies of a
 *  string like this drift the first time one of them is edited. */
export const FIELD_NOTE_SUFFIX = "_note";

/** The metadata key holding `name`'s clarifier. */
export function fieldNoteKey(name: string): string {
  return `${name}${FIELD_NOTE_SUFFIX}`;
}

/** True when a key is a clarifier rather than a value in its own right, so
 *  anything enumerating fields for IDENTITY can skip it. */
export function isFieldNoteKey(key: string): boolean {
  return key.endsWith(FIELD_NOTE_SUFFIX);
}

/**
 * The day a promised date can be said to have ARRIVED, anywhere.
 *
 * `new Date().toISOString().slice(0, 10)` is the UTC day, and two arrival
 * sweepers compared stored `YYYY-MM-DD` dates against it. At 8pm US Eastern it
 * is already tomorrow in UTC, so a parcel due the 25th was announced as "due
 * today. Did it turn up?" at 8pm on the 24th - a whole evening before the day it
 * names (reported 2026-08-24).
 *
 * These announcements are decided once for a batch or an order and sent to every
 * member, so there is no single recipient whose clock to read. The rule that is
 * right without one: a date has arrived when it has arrived EVERYWHERE. UTC-12
 * is the last zone on earth to enter a date, so waiting for it cannot be early
 * for anybody.
 *
 * The cost is up to half a day of lateness for someone far east, which is the
 * correct direction to err: "did it turn up?" is a question you ask after the
 * postman has been, never before.
 */
export function arrivedEverywhere(now: Date): string {
  try {
    // en-CA formats as YYYY-MM-DD, which is the shape the stored dates use.
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Etc/GMT+12" }).format(now);
  } catch {
    // No zone data: still lag rather than lead.
    return new Date(now.getTime() - 12 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }
}

export const FIELD_ROLE_VALUES = [
  "category",
  "pack",
  "identifier",
  "expiry",
  "assignee",
  "acquired-from",
  "acquired-on",
  "acquired-for",
  "seller",
] as const;
export type FieldRole = (typeof FIELD_ROLE_VALUES)[number];

// VOCAB-ENUMERATION OK: this is the vocabulary's own declaration file, and
// saying what each member MEANS to a person is the point. A Record over the
// union, so adding a role fails the typecheck here until it has a name and a
// decision about whether anyone may pick it by hand.
/**
 * How each role reads to a person, and whether a hand-built field may claim it.
 *
 * `pickable: false` is for a role the platform assigns from structure rather
 * than intent: a table has exactly one grouping axis, and letting someone tag a
 * second field "category" would make that ambiguous.
 */
export const FIELD_ROLE_LABELS: Record<FieldRole, { label: string; pickable: boolean }> = {
  category: { label: "Its grouping axis", pickable: false },
  pack: { label: "How many in a pack", pickable: true },
  identifier: { label: "Its identifier (serial, VIN)", pickable: true },
  expiry: { label: "When it expires", pickable: true },
  assignee: { label: "Who it is assigned to", pickable: true },
  "acquired-from": { label: "Where it came from", pickable: true },
  "acquired-on": { label: "When it became yours", pickable: true },
  "acquired-for": { label: "What it cost", pickable: true },
  seller: { label: "Who sold it", pickable: true },
};
export const FieldRoleSchema = z.enum(FIELD_ROLE_VALUES);

const EntityField = z.object({
  name: z.string().min(1).max(80),
  // `object` is for free-form JSON attribute blobs (e.g.
  // inventory:part.metadata) — opaque to the kernel beyond
  // type-checking that it's an object. Renderers treat it as
  // "json blob, show keys"; consumer modules read specific keys
  // via platform.entities.lookupMany.
  type: z.enum(["text", "number", "boolean", "date", "image-path", "url", "object"]),
  // SERVER-OWNED: the value is maintained by the module, not set by whoever
  // writes the record. Declaring a field WITHOUT this when the writer refuses it
  // is an invitation to write something that will be silently discarded — the
  // update returns 200 with a fresh updated_at, so it reads as applied. That is
  // exactly what `core-locations:location.position` did: the kind offered a
  // writable number, the assistant set 0-11 across twelve racks, every call
  // succeeded, and nothing moved (2026-08-18). Anything that describes a kind
  // for writing (the AI tool registry, form builders) must leave these out.
  readOnly: z.boolean().optional(),
  role: EntityFieldRole.optional(),
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

export type DecodeRole =
  | { kind: "identifier"; decoderId: string }
  | { kind: "target"; key: string };

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

/** Parse a `decode_role` string into its structured form, or null when the
 *  string is absent/blank/malformed. Pure; safe on any input. */
export function parseDecodeRole(raw: string | null | undefined): DecodeRole | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  const id = s.match(/^identifier:([a-z][a-z0-9_-]*)$/i);
  if (id) return { kind: "identifier", decoderId: id[1]!.toLowerCase() };
  const tgt = s.match(/^decode:([a-z][a-z0-9_-]*)$/i);
  if (tgt) return { kind: "target", key: tgt[1]!.toLowerCase() };
  return null;
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
    exposableFields: z.array(z.string().min(1)).optional(),
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
      hasFieldRole: EntityFieldRole.optional(),
    })
    .refine(
      (d) => d.kinds || d.traits || d.hasFieldRole,
      "appliesTo: must specify at least one of kinds, traits, or hasFieldRole (or use { any: true } for universal match)",
    ),
]);

export const ActionIdRegex = /^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$/;

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
  // One line for the settings list: what it does, in words.
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



const EntityAction = z.object({
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
  argsSchema: z
    .record(
      z.object({
        label: z.string().min(1),
        type: z.enum(["text", "number", "boolean", "list", "json"]).default("text"),
      }),
    )
    .optional(),
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

const ModuleManifest = z.object({
  // Stable identifier — must be unique across the platform, used as
  // the table prefix and the URL segment under /api/v1/modules/.
  // Module name doubles as a URL segment + a key in module_field_defs.source_module
  // etc. Leading digit allowed so names like "3d-printers" work; everything must
  // still be kebab/snake-case ascii.
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "name must be kebab/snake-case ascii"),
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

  intents: z.array(Intent).default([]),
  dependencies: z.array(z.string()).default([]),
  exposes: z
    .object({
      events: z.array(z.string()).default([]),
      api: z.array(z.string()).default([]),
      actions: z.array(EntityAction).default([]),
      // Sentences this module's users would type, and what to do about them.
      // Available with no AI connected at all. See ModuleCommand.
      commands: z.array(ModuleCommand).default([]),
      // Live controls — ongoing session modes surfaced in the Live box.
      live: z.array(LiveControl).default([]),
    })
    .default({ events: [], api: [], actions: [], commands: [], live: [] }),
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
            surface: z.enum(["module-page-tab", "entity-detail-panel"]),
            /** Target module ("machines") for a page tab, or entity kind
             *  ("machines:machine") for a detail panel. */
            target: z.string().min(1),
            /** The tab/panel label the host renders. */
            title: z.string().min(1),
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
  // The panel gate: contributing UI into another module's surfaces
  // requires DECLARING you operate on it. Keeps `operatesOn` honest
  // (it stops being decorative) and makes drive-by UI injection a
  // manifest-validation failure, not a review argument.
  for (const p of m.contributes.panels) {
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
}

export interface PlatformActivity {
  log(p: ActivityLogParams): Promise<void>;
}

export type EventHandler = (payload: unknown) => void | Promise<void>;

export interface PlatformEvents {
  /** Emit an event. Returns a Promise that resolves once any wires
   *  (user-configured entity_action_bindings) for the event have
   *  finished firing. Direct subscribers registered via on() still
   *  run on the next microtask tick (fire-and-forget). A caller can:
   *    • `await emit(...)` — wait for wires before returning a
   *      response (sync read-after-write semantics for the user)
   *    • `emit(...)` (no await) — fire-and-forget; the wires
   *      still run, the caller just doesn't wait. */
  emit(eventName: string, payload: unknown): Promise<void>;
  /** Subscribe a handler to an event. The module name is captured
   *  for diagnostics — failures get logged with which module's
   *  handler threw. Subscribers run asynchronously on the next
   *  microtask tick so emitters don't block on them. */
  on(eventName: string, module: string, handler: EventHandler): void;
}

/** Tenant-DB accessor for background work that doesn't have a
 *  request context (event handlers, scheduled jobs, etc.). The
 *  returned value is a Kysely instance — typed loosely here so the
 *  platform-contract doesn't need to know about every module's
 *  schema. Callers cast to their own schema type. */
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
}

// ──────────────── Pillar A runtime — entities ──────────────────────

/** Generic entity data returned to other modules. Module-private
 *  columns aren't here — only fields declared on the kind's manifest
 *  with role: 'title' / 'subtitle' / etc., plus the raw field map.
 *  Callers should rely on roles to render generically. */
export interface ResolvedEntity {
  kind: string;
  id: string;
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
  op: "<" | "<=" | ">" | ">=" | "=" | "!=";
  /** Literal value. Use the string `'now'` for current timestamp on
   *  date/timestamptz columns. Mutually exclusive with `ref_col`. */
  value?: string | number | boolean | null;
  /** Compare against another column on the same row (low-stock-style
   *  qty < min_qty). Mutually exclusive with `value`. */
  ref_col?: string;
}

/** Query passed to a list resolver — generic primitives so the
 *  resolver implementation can decide how to apply them. Modules
 *  may safely ignore filter keys they don't support; core-views
 *  surfaces the supported set to the user via the view config. */
export interface EntityListQuery {
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

export interface EntityListResult {
  items: ResolvedEntity[];
  /** Total matching rows ignoring limit/offset — optional because
   *  count-queries on large tables can be expensive. */
  total?: number;
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
  /** Marks this the fallback scan target when no identify hint matches a noun
   *  (at most one should set it). Lets core-scan route an unhinted scan without
   *  hardcoding a default module. */
  default?: boolean;
}

/** In-process create/update/delete for one kind, registered by the owning
 *  module. The WRITE counterpart to EntityResolver — used by cross-module
 *  writers (the sync engine) that have no HTTP request / user token. The
 *  writer resolves its own tenant db from orgId and runs the module's own
 *  validation + events. */
export interface EntityWriter {
  /** Create an entity; returns the new entity's id. */
  create(orgId: string, fields: Record<string, unknown>): Promise<string>;
  update(orgId: string, id: string, fields: Record<string, unknown>): Promise<void>;
  delete(orgId: string, id: string): Promise<void>;
  /** Optional: existing entities of this kind, for a natural-key match during
   *  an import preview — so a one-time import MERGES a source record into an
   *  already-present row (same name) instead of duplicating it. Without this,
   *  an importer treats every unmapped source record as a brand-new create. */
  listForMatch?(
    orgId: string,
  ): Promise<Array<{ id: string; name: string; parentId?: string | null }>>;
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
}

export interface PlatformEntities {
  /** Register a resolver for one kind. Called from a module's
   *  api/index.ts at module-load time. */
  registerResolver(kind: string, resolver: EntityResolver): void;
  /** Register an in-process WRITER for one kind (create/update/delete).
   *  Lets cross-module writers (the sync engine) mutate this kind without
   *  an HTTP loopback or user token. */
  registerWriter(kind: string, writer: EntityWriter): void;
  /** Resolve a registered writer for a kind, or null. */
  getWriter(kind: string): EntityWriter | null;
  /** Put a row back exactly as it was, id and all. True when the kind's writer
   *  can do it; false when nothing here can, so the caller can fall back and
   *  say what it actually did instead of claiming a restore. */
  restore(kind: string, orgId: string, image: Record<string, unknown>): Promise<boolean>;
  /** The whole row for a record, when its kind can produce one — what a change
   *  ledger stores so an undo has real state to put back. */
  snapshot(kind: string, orgId: string, id: string): Promise<Record<string, unknown> | null>;
  /** What would be deleted along with this record. Empty when nothing would be;
   *  null when the kind cannot say (and a caller must not read that as "safe"). */
  dependents(kind: string, orgId: string, id: string): Promise<string[] | null>;
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
   *  scan menu from this (which modules/kinds are scannable + their nouns). */
  listScannable(): Array<{ kind: string } & ScannableInfo>;
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
   *  `viewer.userId` is used by the M1 v0.5 per-link role gate:
   *  cross-workspace fall-through respects `min_target_role` on
   *  workspace_links. Omit for system / anonymous callers — only
   *  unrestricted links qualify in that case. */
  lookup(
    orgId: string,
    kind: string,
    id: string,
    viewer?: { userId?: string; publicRead?: boolean },
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
   *  for. Owner/admin see everything; omitting the viewer entirely
   *  (trusted internal / admin-module reads) also sees everything; a
   *  member-facing caller passes the viewer so "Tier 1 sees parts, not
   *  prices" is enforced at the read boundary. */
  list(
    orgId: string,
    kind: string,
    query?: EntityListQuery,
    viewer?: { userId?: string; role?: string; publicRead?: boolean },
  ): Promise<EntityListResult>;
  /** Batched lookup — resolve N (kind, id) refs in one call. Foreign
   *  callers that need joined data should use this instead of N
   *  separate single-hop calls. Same projection rules as lookup().
   *  Refs that don't resolve are silently skipped (callers get fewer
   *  results than they asked for, matchable by kind+id). Order is
   *  not guaranteed. */
  lookupMany(
    orgId: string,
    refs: ReadonlyArray<{ kind: string; id: string }>,
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
  /** The ONE resolver for where a QR/scan/search hit for an entity should land,
   *  INSTANCE AWARE — shared by the QR-token resolver, the scan registry, and
   *  search so they can't drift (they were three hand-kept copies that each
   *  hand-substituted `{id}` into a base detail_route and so mis-routed an item in
   *  a NAMED instance to the empty base page). It resolves the entity, probes the
   *  module's named instances when the base kind can't see it, and picks the
   *  per-instance route. Returns undefined when the entity has no reachable page. */
  detailPathForEntity(orgId: string, kind: string, id: string): Promise<string | undefined>;
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
 *  pre-rendered template — each in its own block. The top-level
 *  `entityKind` / `entityId` aliases are deprecated compatibility
 *  shims; new handlers should read `ctx.entity.kind` / `ctx.entity.id`.
 *  See docs/architecture/wires-and-bundles.md (Q2). */
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

  // ─── Deprecated compatibility aliases (remove in v0.3) ──────────
  /** @deprecated Use `ctx.entity.kind`. Absent for workspace-scoped actions. */
  entityKind?: string;
  /** @deprecated Use `ctx.entity.id`. Absent for workspace-scoped actions. */
  entityId?: string;
}

/** Assert that an action ran on a record (scope 'entity') and return that
 *  entity, narrowed to non-null. Entity-scoped handlers call this at the top
 *  instead of reaching into `ctx.entity` / the deprecated `ctx.entityKind`
 *  aliases directly: the invoke route always populates `entity` for an
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
  /** Find every registered action that applies to a given entity
   *  kind, factoring in `applies_to` predicates. When `orgId` is
   *  provided, per-org appliesTo overrides take precedence over the
   *  module-declared default. */
  listApplicable(kind: string, orgId?: string): Promise<EntityActionRecord[]>;
  /** Invoke an action programmatically. Throws if no handler is
   *  registered for the action's invoke_handler key. */
  invoke(actionId: string, ctx: ActionInvokeContext): Promise<unknown>;
}

export interface EntityActionRecord {
  id: string;
  module_name: string;
  label: string;
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
  /** Machine-readable arg shape for the wire composer / invoke forms; null if
   *  the action declared none. */
  args_schema: Record<string, { label: string; type: "text" | "number" | "boolean" }> | null;
  version: string;
}

// ──────────────── Pillar C runtime — wires + templates ─────────────

export interface PlatformTemplates {
  /** Render a template against a flat key/value map. Supports
   *  {{key}} substitution and {{key | default: "fallback"}} for
   *  empty values. Markdown-safe (no code execution). */
  render(template: string, data: Record<string, unknown>): string;
}

export interface PlatformWires {
  /** Called by an emitting module when an event fires. The wire
   *  engine looks up matching bindings + invokes their actions. */
  fireEvent(eventName: string, orgId: string, payload: Record<string, unknown>): Promise<void>;
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
}

/** core-queue v0.1: persistent background work for modules.
 *  enqueue() defers a unit of work; registerWorker(name, fn) sets
 *  the handler that the api process's worker loop will invoke when
 *  the job's run_at has arrived. See api/src/platform/queue.ts. */
/** One thing a person can do about a notification, straight from the message. */
export interface NotificationAction {
  /** Stable within one notification; this is what a client sends back. */
  id: string;
  label: string;
  /** A registered action id, e.g. "purchases:mark-arrived". Prefer an
   *  IDEMPOTENT action: a card can be pressed twice, from two devices, or
   *  long after the fact. */
  action: string;
  args?: Record<string, unknown>;
  /** A hint. Channels with no notion of emphasis ignore it. */
  style?: "primary" | "secondary" | "danger";
}

export interface PlatformNotifications {
  /** Fan a notification to one user across their enabled channels.
   *  Writes the row, looks up the user's per-event-type channel
   *  preferences, and delivers via every enabled channel. */
  dispatch(p: {
    orgId: string;
    userId: string;
    eventType: string;
    message: string;
    link_url?: string;
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
     */
    card?: { heading?: string; body?: string; context?: string };
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
   *  iterate this and dispatch per-user. */
  orgMemberIds(orgId: string): Promise<string[]>;
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
      argsSchema?: Record<string, { label: string; type: "text" | "number" | "boolean" | "list" | "json" }>;
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
      argsSchema?: Record<string, { label: string; type: "text" | "number" | "boolean" | "list" | "json" }>;
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
      argsSchema?: Record<string, { label: string; type: "text" | "number" | "boolean" | "list" | "json" }>;
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
] as const;

export type AiCapability = (typeof AiCapabilities)[number];

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

export interface AiProviderDef {
  id: string;
  label: string;
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
  /** Whether a workspace that has configured NO provider may have this one
   *  auto-selected by the zero-config fallback. Default true — a managed,
   *  credential-less provider (instance key) is ready to use. A provider that
   *  needs per-user setup before it works — e.g. the edge bridge needs a
   *  connected agent + a personal Connection — sets `false`, so it's used only
   *  when explicitly chosen/routed and a missing-provider case stays a clean
   *  "no provider configured" rather than an error from the unset provider. */
  autoSelectable?: boolean;
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
  /** Run a single inference. The platform handles caching + audit
   *  before/after. */
  invoke: (ctx: {
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
  }>;
  /** Optional health/test ping.
   *
   *  `models` is what the provider says it can serve. The check for "is this key any
   *  good" is usually a model-list request anyway, so the list comes back free with the
   *  answer — and it is what lets the UI offer a dropdown instead of asking someone to
   *  type an exact model name they have no way to know. */
  testConnection?: (credentials: Record<string, unknown>) => Promise<AiConnectionTest>;
}

export interface AiConnectionTest {
  ok: boolean;
  error?: string;
  /** Human-readable extra, e.g. a few model names. */
  detail?: string;
  /** Every model id the provider reported, unfiltered and in its own order. */
  models?: string[];
  /** Said instead of a verdict when the provider implements no test at all. */
  note?: string;
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
    setup?: AiProviderSetup;
    /** Position in the picker; lower first, and FIRST IS THE DEFAULT. The list
     *  is returned already sorted by it — carried as well as applied, so a
     *  consumer that re-merges these with another registry can re-sort. */
    rank?: number;
  }>;
  getProvider(id: string): AiProviderDef | null;
  /** Single entry point for any module to use AI. Picks provider +
   *  model from the workspace's capability defaults, calls the
   *  cache, calls the provider, writes audit + cache rows, returns
   *  the result. */
  invoke(req: {
    orgId: string;
    capability: AiCapability;
    input: Record<string, unknown>;
    /** Override provider + model from workspace defaults. */
    provider_id?: string;
    model?: string;
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
    result: unknown;
    provider_id: string;
    model: string;
    cached: boolean;
    input_tokens?: number;
    output_tokens?: number;
    cost_cents?: number;
    duration_ms: number;
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

export interface EdgeRequest {
  /** Path on the edge's local target, e.g. "/api/chat". */
  path: string;
  method?: "GET" | "POST";
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
}

export interface EdgeResponse {
  status: number;
  body: unknown;
}

/** A live edge connection's send function — supplied by the hosted relay when
 *  an agent connects, removed (via the returned unregister fn) when it drops. */
export type EdgeChannelSender = (req: EdgeRequest) => Promise<EdgeResponse>;

/** One queued relay request as delivered to a polling bridge. */
export interface EdgeRelayItem {
  id: string;
  path: string;
  method: "GET" | "POST";
  body?: unknown;
  instance?: EdgeRequest["instance"];
  source?: EdgeRequest["source"];
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

  // ── HTTP relay primitives — the queue mechanics behind the dial-out tunnel.
  // The kernel owns the state; routers (the kernel /orgs/:slug/edge wire and
  // any module-mounted legacy alias) are thin HTTP shims over these, so every
  // path lands on the SAME channels and modules stay isolated. Keys follow
  // edgeChannelKey: `orgId` for the default bridge, `orgId::<name>` for a
  // named one, or a bare userId for a personal (account-scoped) agent.

  /** Announce/refresh a bridge: registers the channel on first touch and
   *  bumps its liveness clock. */
  relayTouch(key: string): Promise<void>;
  /** Long-poll for the next queued request; resolves null on keep-alive
   *  timeout or when the poller hangs up (pass an abort signal). */
  relayPoll(key: string, opts?: { signal?: AbortSignal }): Promise<EdgeRelayItem | null>;
  /** Deliver a polled request's result. Returns false if the id is unknown
   *  (already timed out). */
  relayRespond(key: string, r: { id: string; status: number; body?: unknown }): Promise<boolean>;
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
  credentials: Record<string, { label: string; secret: boolean }>;
  /** Position in the picker; lower first, and FIRST IS THE DEFAULT. Optional:
   *  unranked providers sort after the ranked ones in registration order. */
  rank?: number;
  /** One line under the picker, for a kind whose purpose isn't self-evident. */
  blurb?: string;
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
}

/** The single per-tenant egress policy every external-HTTP path routes through —
 *  consistent SSRF posture across sync connectors, device drivers, webhooks, and
 *  module polls (replaces the historic divergent per-module guards). */
export interface PlatformEgress {
  /** SSRF-guarded outbound fetch for a tenant. Link-local/metadata is always
   *  blocked. On a HOSTED instance (COBBLR_HOSTED=true) a private/internal target
   *  is blocked UNLESS a registered allow-provider permits it for this org (the
   *  tenant's own registered edge endpoint); a self-hosted instance allows LAN. */
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
  userHasCapability(args: {
    orgId: string;
    userId: string;
    role: string;
    actionId: string;
  }): Promise<boolean>;
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
  /** Register the platform-level auth-email sender (verify / reset / magic
   *  link). A self-hoster wires their own; the overlay injects a managed
   *  sender. Open core registers none — magic-link falls back to the inline
   *  dev link, reset to admin-managed. Last registration wins. */
  registerEmailSender(sender: AuthEmailSender): void;
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
export interface PlatformPlacement {
  /** Put `containee` inside `container` (moving it if already placed). Throws on
   *  a self-placement, an ineligible kind, or a cycle. */
  place(args: {
    orgId: string;
    containee: EntityRef;
    container: EntityRef;
    slot?: string | null;
    placedBy?: string | null;
  }): Promise<void>;
  /** Take `containee` out of whatever container it's in (no-op if unplaced). */
  remove(args: { orgId: string; containee: EntityRef }): Promise<void>;
  /** The container a containee currently lives in, or null. */
  containerOf(args: { orgId: string; containee: EntityRef }): Promise<EntityRef | null>;
  /** Everything directly inside a container (one level; not recursive). */
  contents(args: { orgId: string; container: EntityRef }): Promise<EntityRef[]>;
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
  }): Promise<{ id: string }>;
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
   *  source-side entities of `sourceKind` point at them via
   *  `relationshipKind`?" Returns an array of { sourceId, targetId }
   *  tuples so the caller can group by target. Used by
   *  bricklink-connector's wanted-list diff to fan out from N
   *  catalog entries to the inventory:part rows matched to them in
   *  one query. */
  findByTargets(args: {
    orgId: string;
    sourceKind: string;
    targetKind: string;
    targetIds: string[];
    relationshipKind: string;
  }): Promise<Array<{ sourceId: string; targetId: string }>>;
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
}
/** Stores bytes as a new file in `orgId` (its own variants + DB row) and
 *  returns the new file id. core-files registers it; the kernel calls it to
 *  COPY a file across workspaces (e.g. the graduation import duplicating a
 *  photo into the new workspace). */
export type FileWriter = (
  orgId: string,
  bytes: Uint8Array,
  opts: { filename?: string; mimeType?: string },
) => Promise<FileWriteResult>;

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
  /** Store bytes as a NEW file in `orgId` (variants + DB row). Returns the new
   *  file id, or null if no writer is registered. Used for cross-workspace
   *  file copies (the graduation import). */
  write(
    orgId: string,
    bytes: Uint8Array,
    opts: { filename?: string; mimeType?: string },
  ): Promise<FileWriteResult | null>;
  /** Override the blob-storage driver (the overlay injects S3/R2). If none is
   *  registered, core-files uses its built-in local-disk driver. */
  registerDriver(driver: FilesDriver): void;
  /** The registered driver, or null → core-files falls back to local disk. */
  getDriver(): FilesDriver | null;
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

export interface SignupLifecycleCtx { userId: string; email: string; orgId: string }
export interface AccountDeleteCtx { userId: string; email: string }
export interface LifecycleHooks {
  onSignup?: (ctx: SignupLifecycleCtx) => Promise<void> | void;
  onAccountDelete?: (ctx: AccountDeleteCtx) => Promise<void> | void;
}
export interface PlatformAccounts {
  registerLifecycleHooks(h: LifecycleHooks): void;
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
}
export interface HostedPanel {
  /** URL segment + key, e.g. "billing", "slack". */
  id: string;
  label: string;
  /** Generic icon NAME (e.g. "credit-card"); the web maps a small allowlist. */
  icon?: string;
  group?: "modules" | "data" | "access" | "extend" | "admin";
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
  getBytes(orgId: string, fileId: string, relPath: string): Promise<Uint8Array | null>;
  remove(orgId: string, fileId: string): Promise<void>;
  /** Local drivers return an absolute path (Express sendFile fast path);
   *  remote drivers return null and the route streams getBytes. */
  localPath(orgId: string, fileId: string, relPath: string): string | null;
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

export interface Platform {
  activity: PlatformActivity;
  events: PlatformEvents;
  tenants: PlatformTenants;
  resolvables: PlatformResolvables;
  db: PlatformDb;
  entities: PlatformEntities;
  actions: PlatformActions;
  live: PlatformLive;
  templates: PlatformTemplates;
  wires: PlatformWires;
  health: PlatformHealth;
  recurrence: PlatformRecurrence;
  calendar: PlatformCalendar;
  queue: PlatformQueue;
  sharedCache: PlatformSharedCache;
  notifications: PlatformNotifications;
  integrations: PlatformIntegrations;
  ai: PlatformAi;
  units: PlatformUnits;
  nav: PlatformNav;
  edge: PlatformEdge;
  connections: PlatformConnections;
  egress: PlatformEgress;
  auth: PlatformAuth;
  pairings: PlatformPairings;
  placement: PlatformPlacement;
  catalogs: PlatformCatalogs;
  files: PlatformFiles;
  instances: PlatformInstances;
  scan: PlatformScan;
  devices: PlatformDevices;
  // Hosted-overlay seams (no-op / allow-all in open core):
  entitlements: PlatformEntitlements;
  metering: PlatformMetering;
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
  runCommand?(command: string, params: Record<string, unknown>): Promise<{ ok: boolean; ref?: string; detail?: string }>;
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
  creds?: Record<string, string | null>;
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

export interface PlatformDevices {
  /** The connection/driver owner registers this at boot (one provider). */
  registerDriverProvider(provider: DeviceDriverProvider): void;
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

let _platform: Platform | null = null;

/** Called once during api boot. Throws if called twice. */
export function setPlatform(p: Platform): void {
  if (_platform) {
    throw new Error("Platform already initialised");
  }
  _platform = p;
}

/** Called by modules. Throws if setPlatform hasn't run yet. */
export function platform(): Platform {
  if (!_platform) {
    throw new Error("Platform not initialised — setPlatform() must run during boot");
  }
  return _platform;
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
}

export interface MappedValue {
  /** The metadata key to write. */
  key: string;
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
 * Roles that have somewhere to go when the workspace has no field for them.
 *
 * DATA, not branches. A seller with nowhere to live is still worth keeping, so
 * it rides as the clarifier beside where you bought it ("eBay · detroitaxle")
 * instead of being dropped. Declaring that as a table means the next role with
 * the same shape is one line here and no change to the matcher.
 *
 * Deliberately NOT appended to the host's value: "eBay (detroitaxle)" would
 * fragment one choice into many and break "everything I bought on eBay". See
 * FIELD_NOTE_SUFFIX.
 */
export const ROLE_CLARIFIES: Partial<Record<FieldRole, FieldRole>> = {
  seller: "acquired-from",
};

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
      const unlisted =
        typeof value === "string" &&
        (field.choices?.length ?? 0) > 0 &&
        !field.choices!.some((c) => c.trim().toLowerCase() === value.trim().toLowerCase());
      out.push({ key: field.name, value, role, ...(unlisted ? { unlistedChoice: true } : {}) });
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
 *  choice and then adding it anyway would make the offer decorative. */
export function roledFactsPatch(mapped: readonly MappedValue[]): Record<string, string | number> {
  const patch: Record<string, string | number> = {};
  for (const m of mapped) {
    if (m.unlistedChoice) continue;
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
  const cols: Array<{ column_name: string; data_type: string }> = (
    await q
      .selectFrom("information_schema.columns")
      .select(["column_name", "data_type"])
      .where("table_name", "=", table)
      .execute()
  ) as Array<{ column_name: string; data_type: string }>;
  if (cols.length === 0) throw new Error(`unknown table ${table}`);
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
