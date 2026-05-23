import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // 60s — Cobblr's tests boot full tenant DBs (signup creates a
    // dedicated postgres database, runs all module migrations, seeds
    // bindings). On the author's Mac that's ~1.5s; the Forgejo runner on
    // the OMV box is closer to 5–15s for the same work. Tail
    // operations like DELETE /orgs (DROP DATABASE + cascade) can
    // push past 20s under load. Generous so CI flake isn't a thing.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
