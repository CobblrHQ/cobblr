// Two ways a model gets an action almost right, and the platform's answer to
// each. Both are guards inside the turn, not more prompt: the prompt already
// says "never escort for something an action covers", and the model escorted
// anyway (measured 2026-09-06 - "hide the manufacturer field on parts" and
// "make Purchase Date required" both went to the Fields screen, which the
// person then has to operate themselves).
//
// The escort destinations already declare which actions cover them
// (ESCORT_DESTINATIONS.covered_by, kept honest by lint:escort-claims). That
// declaration was only ever rendered into prose. Here it does work.

import { ESCORT_DESTINATIONS } from "@cobblr/workspace-tools";

/** Which actions cover each escort destination, by id. The destinations own
 *  the declaration; this is the lookup, so a caller does not have to import
 *  the tool registry to ask the question. */
export const ESCORT_COVERAGE: Record<string, string[] | undefined> = Object.fromEntries(
  ESCORT_DESTINATIONS.map((d) => [d.id, d.covered_by]),
);

/** An id the model nearly got right: separators and case are not the point. */
export function normalizeActionId(id: string): string {
  return id.trim().toLowerCase().replace(/_/g, "-");
}

/** The real action id for what the model typed, or null if nothing matches. */
export function resolveActionId(typed: string, known: Iterable<string>): string | null {
  const want = normalizeActionId(typed);
  for (const id of known) {
    if (id === typed) return id;
    if (normalizeActionId(id) === want) return id;
  }
  return null;
}

/** What to hand back when an escort would send someone to do a job the
 *  workspace can do for them, or null when the escort is the right answer. */
export function escortCoveredByAction(
  destination: string,
  coveredBy: string[] | undefined,
  knownActions: Set<string>,
): string | null {
  const runnable = (coveredBy ?? []).filter((id) => knownActions.has(id));
  if (runnable.length === 0) return null;
  return `Do not send the user to the ${destination} screen: this workspace can do it. ${runnable.join(", ")} cover that. Call list_actions for the one you need, then invoke_action. Escort only if none of them fits, and say why.`;
}
