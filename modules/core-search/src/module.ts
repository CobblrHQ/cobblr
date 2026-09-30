// core-search — cross-module search. Hits every kind's list
// resolver in parallel with the user's query, merges + paginates
// the results. Builders get a single search bar without any per-
// module integration work.
//
// v0.1 — no inverted index, no relevance scoring. The list
// resolvers each handle q in their own way (ILIKE on a few columns
// today); we just fan out + interleave the per-kind results. A
// future v0.2 can graft on tsvector, or a Meilisearch sidecar
// without changing the contract.
//
// No tables — entirely a router on top of platform.entities.list().

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "core-search",
  version: "0.1.3",
  displayName: "Search",
  description:
    "One search across everything you keep.",
  icon: "search",
  band: "stock",
  autoEnable: true, // ambient capability — on for every workspace

  api: () => import("./api/index.js"),

  dependencies: [],

  // AI-REACH: no kinds by design — this module IS a reach mechanism. It is
  // reached through the shared registry's search_records tool, which is the
  // cross-kind text search an agent uses when it does not know where a thing lives.

  provides: { entityKinds: [] },

  exposes: {
    events: [],
    actions: [],
  },

  subscribes: [],
});
