// The request-local "asking again by near words" flag (#9624): set by
// entities.list when the search route asks with `near`, read by the contract's
// textSearchWhere through setNearWordsSource, so the 28 resolvers that match
// `q` through it widen their words without passing anything along.
import { AsyncLocalStorage } from "node:async_hooks";
import { setNearWordsSource } from "@cobblr/platform-contract/text-search";

const near = new AsyncLocalStorage<true>();
setNearWordsSource(() => near.getStore() === true);

/** Run `fn` with every text search inside it matching near words. */
export function withNearWords<T>(fn: () => Promise<T>): Promise<T> {
  return near.run(true, fn);
}
