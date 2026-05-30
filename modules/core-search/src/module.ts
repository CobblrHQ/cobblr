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
  version: "0.1.0",
  displayName: "Search",
  description:
    "One search bar, all entity kinds. Each kind opts in by declaring a list resolver; core-search fans the query out and merges.",
  icon: "search",
  band: "stock",
  autoEnable: true, // ambient capability — on for every workspace

  api: () => import("./api/index.js"),

  intents: [
    { name: "search", description: "Find entities across modules by free text" },
  ],

  dependencies: [],

  provides: { entityKinds: [] },

  exposes: {
    events: [],
    api: ["search"],
    actions: [],
  },

  subscribes: [],
});
