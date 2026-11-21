/** The test-support doors (the pool's token-minting checkout, the planted
 *  failures, the holds) are open only under the flag, and a production node
 *  that carries it refuses to boot: a leaked flag would let anyone mint a
 *  token or plant "the next sign-up dies" on a real service. Staging, which
 *  is NODE_ENV=production too, is the one node that may, by name. */
export function testDoorsOpen(e: { COBBLR_TEST_ORG_POOL?: string; NODE_ENV?: string; COBBLR_ENV?: string }): boolean {
  if (!e.COBBLR_TEST_ORG_POOL) return false;
  if (e.NODE_ENV === "production" && e.COBBLR_ENV !== "staging") {
    throw new Error("COBBLR_TEST_ORG_POOL must never be set on a production node: it opens the test-support doors");
  }
  return true;
}
