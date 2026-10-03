// "Something else is already powering this workspace."
//
// With two of your connections routed to one workspace, which one serves used
// to be settled by whichever you edited last — invisible, and it re-flipped
// when you touched the other one for an unrelated reason. The resolver now
// honours an explicit primary; this is the other half, so the choice is put in
// front of you at the moment you create the situation rather than discovered
// later by wondering which model answered.
//
// Pure so the wording and the rules can be asserted without a browser.

export interface RoutedConnection {
  id: string;
  kind: string;
  label: string;
  provider_id: string;
  routes?: Array<{ org_id: string; mode: string; primary?: boolean }>;
}

/** Connections of one kind that are routed into one workspace. Ranking is
 * kind-local: an AI provider cannot compete with a service, mailbox or
 * tracking account merely because both are available in the same workspace. */
export function routedConnectionsOfKind<T extends RoutedConnection>(
  others: T[],
  orgId: string,
  kind: string,
): T[] {
  return others.filter(
    (c) => c.kind === kind && (c.routes ?? []).some((r) => r.org_id === orgId),
  );
}

/**
 * Which of my OTHER connections currently serves `orgId`, or null when none
 * does and there is nothing to ask about.
 *
 * Mirrors the server's rule so the screen cannot promise something the resolver
 * would not do: an explicit primary wins; otherwise nothing is claimed, because
 * "most recently edited" is a tiebreak, not a decision, and naming a winner we
 * are not sure of would be worse than saying only that another is routed.
 */
export function incumbentConnection<T extends RoutedConnection>(
  others: T[],
  orgId: string,
  kind: string,
): T | null {
  const routedHere = routedConnectionsOfKind(others, orgId, kind);
  if (routedHere.length === 0) return null;
  const primary = routedHere.find((c) =>
    (c.routes ?? []).some((r) => r.org_id === orgId && r.primary),
  );
  return primary ?? routedHere[0] ?? null;
}

/** Is more than one of mine routed here — i.e. is there a choice to make? */
export function hasCompetition(others: RoutedConnection[], orgId: string, kind: string): boolean {
  return routedConnectionsOfKind(others, orgId, kind).length > 0;
}
