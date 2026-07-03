import { basename } from "node:path";
import { defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import fileDurations from "./tests/file-durations.json";

// Longest-first (LPT) file scheduling. With 8 forks the wall-clock is set by
// whatever's still running at the end — and by default the ~2min
// platform-pillars.test.ts and the 20-45s digifab files can START in the last
// third of the run, dragging the wall to ~210s when the same files scheduled
// longest-first finish in ~140s. Vitest's own duration-aware sort only works
// off its results cache, which never survives between CI runs — so we pin the
// order with a COMMITTED durations snapshot instead (tests/file-durations.json).
//
// The numbers don't need to be current — only the ORDER matters, and that's
// stable (big integration files stay big). Files not in the snapshot (new or
// renamed) get a pessimistic default so they schedule early; a quick file that
// runs early costs nothing, a slow file that runs late sets the wall. Refresh
// the snapshot occasionally:
//   npx vitest run --reporter=json --outputFile=/tmp/v.json
//   → durations = endTime-startTime per testResults[], keyed by basename.
const DURATIONS: Record<string, number> = fileDurations;
const UNKNOWN_FILE_WEIGHT = 45;

class LongestFirstSequencer extends BaseSequencer {
  async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const weight = (f: TestSpecification) =>
      DURATIONS[basename(f.moduleId)] ?? UNKNOWN_FILE_WEIGHT;
    return [...files].sort((a, b) => weight(b) - weight(a));
  }
}

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
    // Tests hit a real, shared API container over HTTP. A cold
    // container warming its tenant-DB + wasm-sandbox pools under the
    // serial suite can spike and time a request out; the container
    // recovers, so one retry absorbs that transient without masking a
    // genuine logic failure (which fails deterministically on retry).
    retry: 1,
    // hookTimeout has to be generous enough for the afterAll
    // teardown sweep — a file that signs up 10 orgs needs to drop 10
    // tenant DBs, each is a DROP DATABASE which can take seconds
    // when other connections need to drain first.
    hookTimeout: 120_000,
    // Run files across forks instead of one serial fork — the suite is ~2min
    // serial and the A6 runner has 12 cores. 8 forks ≤ 12 cores, so each fork
    // owns a full core: no oversubscription, tests finish faster, and the
    // Postgres CREATE/DROP DATABASE template-lock window each signup holds is
    // SHORTER — which is why 8-on-12 is both faster and no flakier than the
    // proven 6-on-8 baseline. retry:1 above absorbs any transient. Each fork is
    // its own process, so module mocks + process.env never bleed across files.
    pool: "forks",
    poolOptions: {
      forks: { singleFork: false, maxForks: 8, minForks: 2 },
    },
    sequence: { sequencer: LongestFirstSequencer },
  },
});
