// Which connection serves this workspace, for this caller.
//
// It used to be "whichever row has the newest updated_at". With one connection
// routed that is right by accident; with two it is a coin toss you cannot see,
// and the coin re-flips whenever you touch either connection for an unrelated
// reason — relabel it, rotate its key, route it to a DIFFERENT workspace. The
// model answering your questions could change because you edited something
// else.
//
// So the choice is explicit: a route can be marked PRIMARY for its workspace,
// and primary wins. Recency stays the tiebreak, which keeps the single-
// connection case (and every workspace that never picks) behaving exactly as
// before.
//
// Pure, and separate from the queries, because "which one serves me" is the
// question everything else here exists to answer and it deserves to be
// readable on its own.

export interface CandidateCredential {
  id: string;
  /** Who owns the key. */
  user_id: string;
  /** Last edit of the CREDENTIAL, the old (and now fallback) ordering. */
  updated_at: string | Date;
}

export interface RouteFacts {
  /** Where it sits in the workspace's order for the capability being invoked:
   *  1 first, 2 next, and so on. Null = unranked, which sorts after everything
   *  ranked and falls back to recency — the behaviour of every route that
   *  existed before ranking, and of every workspace that never sets one. */
  rank: number | null;
  /** Serves everyone here (an approved Share), rather than only its owner. */
  shared: boolean;
}

export interface PickInput<C extends CandidateCredential> {
  candidates: C[];
  /** Whose call this is; null for a sweep or an automation. */
  callerUserId: string | null;
  /** Route facts for a candidate in THIS workspace. */
  routeOf: (credentialId: string) => RouteFacts;
}

const byRecency = (a: CandidateCredential, b: CandidateCredential): number =>
  new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();

/** Ranked first (1 before 2), then most recently touched. */
function inPickOrder<C extends CandidateCredential>(
  list: C[],
  routeOf: (id: string) => RouteFacts,
): C[] {
  const rankOf = (id: string): number => routeOf(id).rank ?? Number.MAX_SAFE_INTEGER;
  return [...list].sort((a, b) => rankOf(a.id) - rankOf(b.id) || byRecency(a, b));
}

/**
 * The caller's OWN connections first — their key, their call, and it works even
 * while a Share offer is still waiting on the owner. Then the workspace's
 * shared AI. Within each group, the workspace's order for this capability.
 */
export function pickCredential<C extends CandidateCredential>({
  candidates,
  callerUserId,
  routeOf,
}: PickInput<C>): C | null {
  return orderCredentials({ candidates, callerUserId, routeOf })[0] ?? null;
}

/**
 * The same decision, kept as a LIST rather than a winner.
 *
 * Nothing walks past the first entry today: a provider that errors or hits its
 * cap fails the call rather than quietly spending a different key, which is the
 * deliberate choice while ranking is new. The order exists so that when
 * failover does arrive it follows the order the user set, instead of inventing
 * a second rule.
 */
export function orderCredentials<C extends CandidateCredential>({
  candidates,
  callerUserId,
  routeOf,
}: PickInput<C>): C[] {
  const own = callerUserId ? candidates.filter((c) => c.user_id === callerUserId) : [];
  const ownIds = new Set(own.map((c) => c.id));
  const shared = candidates.filter((c) => routeOf(c.id).shared && !ownIds.has(c.id));
  return [...inPickOrder(own, routeOf), ...inPickOrder(shared, routeOf)];
}
