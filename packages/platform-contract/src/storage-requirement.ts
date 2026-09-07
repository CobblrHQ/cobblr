// How a thing must be KEPT, and whether a PLACE keeps it that way.
//
// Two facts, deliberately apart: "must be kept refrigerated" is a property of
// the product; "in the fridge" (a location, or a `storage` field with choices
// like Fridge / Pantry / Counter) is where this one is. The bridge between
// them is this one vocabulary, and it lives here because three readers need
// the same answer: the scan server suggesting a home and warning about a
// wrong one, the fill that turns "refrigerated" into the table's own "Fridge"
// choice, and the card that drops the "Must be kept" chip when the Storage
// chip already says it. Two copies of "does a fridge count as cold" would
// drift into the worst bug available: suggest a place, then complain about
// the thing being in it.

export type StorageRequirement = "frozen" | "refrigerated" | "ambient";

const FREEZER = /freezer|deep ?freeze/;
const COLD = /fridge|refrigerat|chiller|cool ?box/;

/** Does this place SATISFY the requirement? A freezer satisfies a
 *  refrigeration requirement; a fridge does not satisfy a frozen one. False
 *  for ambient and for anything unknown, so a caller can only act on a
 *  positive answer. */
export function satisfiesRequirement(
  requirement: StorageRequirement | null | undefined,
  placeName: string | null | undefined,
): boolean {
  if (!requirement || requirement === "ambient" || !placeName) return false;
  const place = placeName.toLowerCase();
  const isFreezer = FREEZER.test(place);
  const isCold = isFreezer || COLD.test(place);
  return requirement === "frozen" ? isFreezer : isCold;
}

/** What keeping a thing in this place IMPLIES about it: a freezer means
 *  frozen, a fridge means refrigerated, and any other place means nothing
 *  (a counter does not prove a thing is shelf-stable; it may just be wrong). */
export function requirementImpliedByPlace(placeName: string | null | undefined): StorageRequirement | null {
  if (!placeName) return null;
  const place = placeName.toLowerCase();
  if (FREEZER.test(place)) return "frozen";
  if (COLD.test(place)) return "refrigerated";
  return null;
}

/** The table's own word for a place that keeps the requirement: the first
 *  declared choice that satisfies it ("Fridge" for refrigerated, "Freezer"
 *  for frozen). Null for ambient (that is the person's call: pantry or
 *  counter) and when no choice qualifies. */
export function choiceSatisfying(
  requirement: StorageRequirement | null | undefined,
  choices: readonly string[] | null | undefined,
): string | null {
  if (!requirement || requirement === "ambient" || !choices) return null;
  // Exact tier first: a freezer for frozen, a FRIDGE (not the freezer) for
  // refrigerated, so cold things do not all get sent to the freezer.
  const exact = choices.find((c) => requirementImpliedByPlace(c) === requirement);
  return exact ?? choices.find((c) => satisfiesRequirement(requirement, c)) ?? null;
}

/** A requirement chip says nothing the storage chip does not already say
 *  when the two agree. Disagreement is the news, and both stay. */
export function requirementImpliedBy(
  requirement: StorageRequirement | null | undefined,
  storageValue: unknown,
): boolean {
  if (!requirement || typeof storageValue !== "string" || !storageValue.trim()) return false;
  if (requirement === "ambient") return requirementImpliedByPlace(storageValue) === null;
  return requirementImpliedByPlace(storageValue) === requirement;
}
