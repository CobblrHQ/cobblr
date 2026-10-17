// The field and face VOCABULARIES: the words a custom field's type, role and
// clarifier key, and a record's faces, are drawn from. Plain data with no
// schema library, apart from the index (which builds its zod schemas from
// these), so a browser page that needs a field's words does not load the
// manifest validator with them (#4945). The index re-exports all of it.

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
  "secret",
  "computed",
  "relation",
  // A person. Stored as a user id; rendered as their display name, resolved at
  // READ time so a rename propagates instead of leaving stale snapshots. This
  // is the type the `assignee` role sits on — see
  // design-decisions/household-accountability.md §1.
  "member",
  // Someone on the workspace's People list: a member (tied to their account)
  // or anyone else by name, who may be invited later and keep what is theirs.
  // Stored as the list entry's id, named at READ time. The type the `owner`
  // meaning sits on (#3787).
  "person",
  // A measured value with an SI unit: "10k", "4k7", "100 nF", "16 V". Stored
  // as { value (plain SI number), unit (catalog code), text (as typed) },
  // shown with the best prefix, searched, filtered and sorted by value
  // (@cobblr/platform-contract/measure).
  "measure",
  // Money: { amount, currency }, in main units (4300 for $4,300). Legacy
  // numbers read in the workspace currency. Shown and typed through @cobblr/platform-contract/money
  // ("$4,300", "4,300"). A number field whose role or unit says money reads
  // the same way; this is the type a person picks for a price.
  "money",
  // Where something happens: { name, street, city, region, postal, country,
  // line, lat?, lon?, source }, read and written through
  // @cobblr/platform-contract/address. Shown as the name over the street
  // address with a Directions link; a dated record's calendar event takes it
  // as its "Where" (#5317). Called an address, never a location: a Location is
  // where a thing is kept.
  "address",
] as const;
export type FieldDefType = (typeof FIELD_TYPE_VALUES)[number];
/** The types a field can change between after it is made. Each holds a plain
 *  value in the record's metadata, so a change of type moves nothing; a
 *  computed, relation, member or person field holds a template or a reference
 *  and is made again rather than retyped, and an address holds parts that no
 *  other type reads. */
export const NOT_RETYPEABLE_FIELD_TYPES = ["computed", "relation", "member", "person", "secret", "address"] as const;
export const RETYPEABLE_FIELD_TYPES: readonly FieldDefType[] = FIELD_TYPE_VALUES.filter(
  (t) => !(NOT_RETYPEABLE_FIELD_TYPES as readonly string[]).includes(t),
);

/** The types a declared unit means something on: a number ("mm") and a
 *  measured value ("ohm", what a bare "10" is in). Every door that accepts or
 *  drops a unit asks this, so a new unit-bearing type is one line here. */
export const UNIT_FIELD_TYPES: readonly FieldDefType[] = ["number", "measure"];
export function fieldTypeTakesUnit(type: string | null | undefined): boolean {
  return !!type && (UNIT_FIELD_TYPES as readonly string[]).includes(type);
}

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

export const FIELD_ROLE_VALUES = [
  "category",
  "pack",
  "identifier",
  "expiry",
  "due",
  "assignee",
  "acquired-from",
  "acquired-on",
  "acquired-for",
  "seller",
  "location",
  "lot",
  "ready-from",
  "ready-until",
  "year-made",
  "belongs-to",
  "usage",
  "outer-size",
  "payment-method",
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
 *
 * `ownedBy` names a capability that ALREADY answers this question for every
 * record in the workspace. A custom field claiming such a role is refused: two
 * places to write the same fact means two answers to one question, and the one
 * in the custom field is the one nothing else can read. Home Inventory learned
 * this the hard way - it shipped a Room text field, retired it into real
 * Locations at v0.4.0, and a scan matched a day before that upgrade still
 * showed "room: Living room" beside the item's actual location eleven days
 * later (reported 2026-09-03).
 */
export const FIELD_ROLE_LABELS: Record<
  FieldRole,
  { label: string; pickable: boolean; ownedBy?: string; type?: "number" | "date" | "text" }
> = {
  "payment-method": { label: "How it is paid (last four digits only)", pickable: true, type: "text" },
  category: { label: "Its grouping axis", pickable: false },
  pack: { label: "How many in a pack", pickable: true },
  identifier: { label: "Its identifier (serial, VIN)", pickable: true },
  expiry: { label: "When it expires", pickable: true },
  // A deadline, which is not an expiry: a chore is due and milk expires, and
  // overdue means two different things for them. A record past this date with
  // nothing done about it is told again, louder, each step (core-recurrence's
  // overdue sweep); an expiry has a "Goes off" face instead.
  due: { label: "When it is due", pickable: true, type: "date" },
  assignee: { label: "Who it is assigned to", pickable: true },
  "acquired-from": { label: "Where it came from", pickable: true },
  "acquired-on": { label: "When it became yours", pickable: true },
  "acquired-for": { label: "What it cost", pickable: true },
  seller: { label: "Who sold it", pickable: true },
  location: { label: "Where it is kept", pickable: false, ownedBy: "core-locations" },
  // The batch printed on this one unit's label (a dye lot, a food lot, a
  // filament batch). Per unit, never a fact about the product: two balls of
  // one yarn can be two lots, so it never leaves the workspace.
  lot: { label: "Its lot or batch", pickable: true },
  // A window, not a deadline: a wine is ready from one day and best by
  // another, a cheese is aged from one date to the next, seed is viable to a
  // year. Past the end is "past its best", never spoiled, so these are NOT
  // expiry: no "Goes off" face, no Threw it out, no expiry reminder.
  "ready-from": { label: "When it is ready from", pickable: true },
  "ready-until": { label: "When it is at its best until", pickable: true },
  // The year printed on this one unit (a wine's vintage, a coin's year). Per
  // unit like the lot: one barcode covers every vintage of a wine, so the
  // year never becomes a fact about the barcode.
  "year-made": { label: "The year it was made", pickable: true },
  // Whose it is, which is not who has it now (that is `assignee`, and it
  // turns on Lending). A member or anyone on the workspace's People list.
  // Not called "owner": that word is the workspace role.
  "belongs-to": { label: "Who it belongs to", pickable: true },
  // A number that only goes up as the thing is used: a car's miles, a
  // mower's hours, a press's cycles. A service schedule can fall due every so
  // many of it, on any kind, with no code of the kind's own.
  usage: { label: "What it counts as it is used (miles, hours)", pickable: true, type: "number" },
  // How much room the thing takes: width, depth and height, as written
  // ("600 x 550 x 700 mm"; parseOuterSize in ./outer-size). The floor plan
  // draws a placed thing at this size and checks it fits its shelf. Its
  // outside, never what it holds or makes (a printer's build volume is not it).
  "outer-size": { label: "Its outer size (W × D × H)", pickable: true, type: "text" },
};

/** Why a field of this type cannot carry this role, or null when it can. A
 *  role that reads its value as a number (`usage`) means nothing on a text
 *  field: the field would say "counts use" and never count. */
export function fieldRoleTypeRefusal(role: FieldRole | null | undefined, type: string | null | undefined): string | null {
  const want = role ? FIELD_ROLE_LABELS[role]?.type : undefined;
  if (!want || !type || type === want) return null;
  return `"${FIELD_ROLE_LABELS[role!].label}" is a ${want} field's meaning; this field is ${type}.`;
}

/** The capability that already owns this role's question, or null when the
 *  role is a field's to claim. A role with an owner may not be declared on a
 *  custom field - see FIELD_ROLE_LABELS. */
export function fieldRoleOwner(role: FieldRole | null | undefined): string | null {
  if (!role) return null;
  return FIELD_ROLE_LABELS[role]?.ownedBy ?? null;
}

/** What to tell someone who tried to declare a role the platform owns. Kept
 *  beside the vocabulary so the API, the lint and the UI say the same thing. */
export function fieldRoleOwnedMessage(role: FieldRole): string {
  const owner = fieldRoleOwner(role);
  if (!owner) return "";
  if (role === "location") {
    return "Where a thing is kept is already the item's Location, so a field cannot also claim it - two places to write one fact end up disagreeing. Set the item's location instead. To retire a place field you already have, the inventory:field-to-location migration moves each value into a real Location and clears the field.";
  }
  return `That meaning is already ${owner}'s, so a field cannot also claim it.`;
}

export const FACE_NAMES = ["stock", "perishable", "serialized", "maintained", "lendable", "container"] as const;
export type FaceName = (typeof FACE_NAMES)[number];
/** What a person calls each face, for the row that offers the dormant ones. */
export const FACE_LABELS: Record<FaceName, string> = {
  stock: "Stock",
  perishable: "Goes off",
  serialized: "Serials",
  maintained: "Service",
  lendable: "Lending",
  container: "Contents",
};

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

/** Is this value one of a choice field's choices? Trimmed and without regard
 *  to case, the one rule for every writer: the scan mapper deciding whether to
 *  write a fact, and the write routes deciding whether to take it. */
export function isListedChoice(value: unknown, choices: readonly string[]): boolean {
  if (typeof value !== "string") return false;
  const v = value.trim().toLowerCase();
  return choices.some((c) => c.trim().toLowerCase() === v);
}
