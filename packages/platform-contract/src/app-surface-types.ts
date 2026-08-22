// What a single app capability looks like to the assistant that describes it.
//
// In the contract because the generated list beside it names the module that
// owns each screen, and a module may not name another module — the contract
// may, since that is precisely what it is for.
export interface Capability {
  /** What the app calls it. */
  feature: string;
  /** What it does, in the product's own words. */
  does: string;
  /** The route that does it. Verified by lint:app-surface. */
  where: string;
  /** Other words a person might use for it. */
  also?: string[];
  /** Hidden when this module is disabled. */
  module?: string;
}
