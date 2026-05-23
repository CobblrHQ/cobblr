// core-healthcheck — aggregates platform.health probes into a single
// rollup endpoint. Other modules register probes via
//   platform().health.registerProbe(name, fn)
// from their lifecycle.onBoot — this module's onBoot registers the
// built-in `meta-db` probe (cobblr_meta reachable) so a fresh
// install has at least one signal.
//
// Rollup semantics:
//   - All probes are ok          → 200 { status: "ok", probes: {…} }
//   - Any probe is 'degraded'   → 200 { status: "degraded", probes: {…} }
//   - Any probe is 'error'      → 503 { status: "error", probes: {…} }
// 503 lets the workshop-box deploy script + uptime monitors react
// without parsing the body.

import { defineModule, platform } from "@cobblr/platform-contract";

export default defineModule({
  name: "core-healthcheck",
  version: "0.1.0",
  displayName: "Healthcheck",
  description:
    "Aggregates every module's health probes into one rollup. Modules register probes via platform().health.registerProbe(); this module exposes the snapshot over HTTP.",
  icon: "heart-pulse",
  band: "foundational",

  api: () => import("./api/index.js"),

  intents: [],
  dependencies: [],

  provides: { entityKinds: [] },

  exposes: {
    events: [],
    api: ["snapshot"],
    actions: [],
  },

  subscribes: [],

  lifecycle: {
    onBoot: async () => {
      // Built-in: cobblr_meta reachable. Other modules add their
      // own — e.g. core-recurrence could ship a "scheduler running"
      // probe, core-files a "files root writable" probe.
      platform().health.registerProbe("meta-db", async () => {
        // Quick round-trip query. Kysely instance is on platform.db.meta;
        // we duck-type the selectFrom('orgs').limit(1).execute() chain
        // to avoid taking a runtime dependency on the api workspace.
        const meta = platform().db.meta as {
          selectFrom(t: string): {
            select(cols: string[]): { limit(n: number): { execute(): Promise<unknown[]> } };
          };
        };
        await meta.selectFrom("orgs").select(["id"]).limit(1).execute();
        return { status: "ok" };
      });
    },
  },
});
