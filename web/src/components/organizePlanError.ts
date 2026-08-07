// Pure decision for what the Sorting-plan lens shows when a plan request fails.
// Kept in its own import-light module so it's unit-testable without dragging in
// the component's heavy graph (@cobblr/platform-web etc.).
//
// The one case that must NEVER be a bare dead-end: a 422 `nothing_to_plan` when
// the pile is simply all-unidentified — the items ARE in the box (they drive the
// banner + toggle), they just can't be placed until named, so we point back to
// them ("review") rather than stranding the user on a red string (the bug a beta tester
// hit — feedback ca6b762e). A plain error is anything else.
export type PlanErrorView =
  | { kind: "review"; count: number }
  | { kind: "error"; message: string };

export function planErrorView(
  errorCode: string | null,
  reviewNeeded: number,
  message: string,
  canReview: boolean,
): PlanErrorView {
  if (errorCode === "nothing_to_plan" && canReview) {
    return { kind: "review", count: reviewNeeded };
  }
  return { kind: "error", message };
}
