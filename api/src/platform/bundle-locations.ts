// Places a bundle offers to set up - Kitchen with a Fridge and a Freezer in it,
// Garden with beds, Workshop with shelves.
//
// The hard case is not the empty workspace. It is the one that already has a
// Kitchen with a Top Cabinet in it, because that is what anybody who has been
// using Cobblr for a week looks like. Getting that wrong means either a second
// "Kitchen" nobody notices among thirty-odd top-level places, or an install that
// refuses to help because the parent happens to exist.
//
// So the unit of idempotency is the CHILD, not the parent: find-or-create each
// name under its parent, touch nothing else, and leave every existing sibling
// exactly where it is.
//
// The planner is pure and separate from the applier on purpose. "What will this
// do to my locations?" is worth answering before it happens, and a preview that
// re-derives its answer by a different route than the write is a preview that
// eventually lies.

/** One place a bundle wants to exist. Children nest one level, which covers
 *  every real case so far and keeps the preview readable. */
export interface BundleLocation {
  name: string;
  /** `area` is a room; `container` is a thing you put stuff in and can label. */
  kind: "area" | "container";
  children?: Array<{ name: string; kind: "area" | "container" }>;
}

/** What exists already, flattened. `parentName` is null for a top-level place. */
export interface ExistingLocation {
  id: string;
  name: string;
  parentName: string | null;
}

export interface PlannedLocation {
  name: string;
  kind: "area" | "container";
  parentName: string | null;
  /** Already there - the plan will not touch it. */
  exists: boolean;
  /** Present only for an existing row, so the applier can parent onto it. */
  existingId?: string;
}

/** Names compare case- and space-insensitively. "Top Cabinet 1" and "top
 *  cabinet 1" are the same shelf; anything stricter creates duplicates that
 *  read as identical. */
const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Written as the escape, not a raw byte: a raw NUL makes grep treat the whole
 *  file as binary and skip it silently. The separator has to be something that
 *  cannot occur in a location name, or "Kitchen"+"Fridge" and a top-level place
 *  called "KitchenFridge" would key the same. */
const key = (name: string, parentName: string | null): string =>
  `${parentName === null ? "" : norm(parentName)}\x00${norm(name)}`;

/**
 * What installing these would do, given what is already there.
 *
 * Every entry comes back, existing ones flagged rather than dropped, because
 * the preview has to be able to say "Kitchen already exists, Fridge and Freezer
 * would be added inside it". A plan that listed only the new rows would leave
 * the user guessing whether their Kitchen was about to be duplicated.
 */
export function planLocations(
  wanted: BundleLocation[],
  existing: ExistingLocation[],
): PlannedLocation[] {
  const byKey = new Map<string, ExistingLocation>();
  for (const e of existing) byKey.set(key(e.name, e.parentName), e);
  const find = (name: string, parentName: string | null) => byKey.get(key(name, parentName));

  // A top-level entry matches a place of that name ANYWHERE, not only at the
  // root. "Home > Kitchen" is still the user's kitchen, and insisting on
  // parentName === null would create a second top-level Kitchen beside it -
  // exactly the duplicate this whole planner exists to prevent, and harder to
  // spot because the two sit at different depths.
  const findAnywhere = (name: string) => existing.find((e) => norm(e.name) === norm(name));

  const out: PlannedLocation[] = [];
  for (const top of wanted) {
    const hit = find(top.name, null) ?? findAnywhere(top.name);
    out.push({
      name: top.name,
      kind: top.kind,
      // Report where it ACTUALLY is, so the applier parents children onto the
      // real row and the preview does not claim it is at the root when it is not.
      parentName: hit ? (hit.parentName ?? null) : null,
      exists: !!hit,
      ...(hit ? { existingId: hit.id } : {}),
    });
    for (const child of top.children ?? []) {
      // Matched under the parent NAME, so an existing sibling ("Top Cabinet 1")
      // neither blocks nor is disturbed by adding a Fridge beside it.
      const childHit = find(child.name, top.name);
      out.push({
        name: child.name,
        kind: child.kind,
        parentName: top.name,
        exists: !!childHit,
        ...(childHit ? { existingId: childHit.id } : {}),
      });
    }
  }
  return out;
}

/** Just the rows a plan would create. The applier writes exactly these. */
export function locationsToCreate(plan: PlannedLocation[]): PlannedLocation[] {
  return plan.filter((p) => !p.exists);
}

/**
 * One line a person can read before agreeing to it.
 *
 * Deliberately names what is being LEFT ALONE. Merging into somebody's existing
 * tree without saying so is how a user learns to distrust an install.
 */
export function describePlan(plan: PlannedLocation[]): string {
  const create = locationsToCreate(plan);
  if (create.length === 0) return "Everything is already set up.";
  const lines = create.map((p) => (p.parentName ? `${p.name} (inside ${p.parentName})` : p.name));
  const kept = plan.filter((p) => p.exists).map((p) => p.name);
  const one = kept.length === 1;
  const keptNote = kept.length
    ? ` ${kept.join(" and ")} already exist${one ? "s" : ""} and stay${one ? "s" : ""} as ${one ? "it is" : "they are"}.`
    : "";
  return `Adds ${lines.join(", ")}.${keptNote}`;
}
