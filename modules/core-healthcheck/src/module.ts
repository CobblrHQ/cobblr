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
  version: "0.1.1",
  displayName: "Healthcheck",
  description:
    "Shows whether every part of your workspace is working, in one place.",
  icon: "heart-pulse",
  band: "foundational",

  api: () => import("./api/index.js"),

  dependencies: [],

  // AI-REACH: none needed — operator plumbing (liveness probes for the deploy).
  // Not a workspace surface; nothing a user of a workspace would ask about.

  provides: { entityKinds: [] },

  exposes: {
    events: [],
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
