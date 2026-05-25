import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Per-file teardown: every workspace created by signupFreshOrg /
    // registerOrgForTeardown is deleted at end-of-file. Stops the
    // tenant-DB leak that used to accumulate hundreds of orphan
    // databases per CI/dev cycle and exhaust connection slots + disk.
    setupFiles: ["./tests/setup-teardown.ts"],
    // 60s — Cobblr's tests boot full tenant DBs (signup creates a
    // dedicated postgres database, runs all module migrations, seeds
    // bindings). On the author's Mac that's ~1.5s; the Forgejo runner on
    // the OMV box is closer to 5–15s for the same work. Tail
    // operations like DELETE /orgs (DROP DATABASE + cascade) can
    // push past 20s under load. Generous so CI flake isn't a thing.
    testTimeout: 60_000,
    // hookTimeout has to be generous enough for the afterAll
    // teardown sweep — a file that signs up 10 orgs needs to drop 10
    // tenant DBs, each is a DROP DATABASE which can take seconds
    // when other connections need to drain first.
    hookTimeout: 120_000,
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
