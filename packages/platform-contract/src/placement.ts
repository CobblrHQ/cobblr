import type { GroupPlan } from "./grouped-list.js";
import { platform } from "@cobblr/platform-contract/platform-runtime";
import type { DatedMoney } from "@cobblr/platform-contract/platform-services";
import type { ResolvedEntity } from "@cobblr/platform-contract/entity-resolvers";

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
