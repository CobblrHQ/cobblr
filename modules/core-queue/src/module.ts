// core-queue — persistent background work for modules.
//
// Foundational because every module that wants to defer a unit of
// work goes through this module's API:
//   platform().queue.enqueue({ orgId, queue, payload, runAt?, maxAttempts? })
//   platform().queue.registerWorker(name, async (job) => { ... })
//
// The runtime (worker loop + lock + retry + stale-sweep) lives at
// api/src/platform/queue.ts because the worker process IS the api
// process — same node, same memory. The manifest here documents the
// feature in the registry so it appears alongside other core-*
// modules and so `core-notifications` etc. can declare it as a dep
// in a future iteration.
//
// No table migrations here (the queue table is platform-side, in
// cobblr_meta, because queues are cross-tenant infra). No api
// routes either — listing/inspecting jobs is a future v0.2 surface.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "core-queue",
  version: "0.1.0",
  displayName: "Background queue",
  description:
    "Persistent background work for modules. Modules enqueue() jobs and registerWorker(name, fn); the api process's worker loop polls every 5s, locks rows via SKIP LOCKED, retries failures with exponential backoff, and reclaims locks from crashed workers after 15min.",
  icon: "list-todo",
  band: "foundational",

  intents: [],
  dependencies: [],

  exposes: {
    events: [],
    api: ["enqueue", "registerWorker"],
    actions: [],
  },

  subscribes: [],
});
