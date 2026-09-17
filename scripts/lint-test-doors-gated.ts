#!/usr/bin/env tsx
// A test-only door (the test-support router, the outbound hold) is reachable
// only behind the one COBBLR_TEST_ORG_POOL mount, and nothing outside
// routes/test-support.ts can register a hold.
//
// THE BUG THIS PREVENTS. /test-support/hold-outbound (#3119) holds every
// outbound fetch whose URL matches until a caller releases it: on a deployment
// whose job is to be tested it is how a test says "this write has not landed
// yet"; on a production surface it would be a denial-of-service lever pointed
// at our own egress, and /test-support/checkout-org beside it mints an owner
// token. Both are safe today because server.ts mounts the router inside
// `if (env.COBBLR_TEST_ORG_POOL)`. That is an `if`: a condition that holds,
// not one anybody would notice a refactor removing. The review of #3145 asked
// for the stronger lever, and this is it: the mount shape is asserted at lint
// time, so the day someone mounts testSupportRouter unconditionally, or adds
// a second door to the hold registry, the push fails before the build.
//
// THE RULE.
//   1. `testSupportRouter` is mounted in api/src/server.ts exactly once, on a
//      line that also carries `env.COBBLR_TEST_ORG_POOL`, and nowhere else.
//   2. The hold registry's write side (registerOutboundHold, releaseOutboundHold,
//      forgetOutboundHold) is imported by no shipping file except
//      api/src/routes/test-support.ts and the package's own index.ts re-export.
//      Read-side names (outboundHoldMatches, hasOutboundHolds, applyOutboundHold,
//      outboundHoldStatus) are free: they are what the fetch loop and a fixture
//      layer consult.
//   3. No production compose or env example sets COBBLR_TEST_ORG_POOL (docker/,
//      docker-compose*.yml, deploy/, selfhost/).
// There is no opt-out: a second test door is added INSIDE the gated router.
//
// PROVEN RED 2026-09-17 by mounting the router unconditionally (rule 1) and by
// importing registerOutboundHold from api/src/index.ts (rule 2).
//
//   npx tsx scripts/lint-test-doors-gated.ts   (pnpm run lint:test-doors-gated)
import { readFileSync, existsSync, statSync } from "node:fs";
import { sourceFiles } from "./lib/glob-exclude.mjs";

interface Violation {
  file: string;
  line: number;
  what: string;
}
const violations: Violation[] = [];

// Rule 1: the one gated mount.
const SERVER = "api/src/server.ts";
const server = readFileSync(SERVER, "utf8").split("\n");
const mounts = server
  .map((l, i) => ({ l, n: i + 1 }))
  .filter(({ l }) => /\buse\(\s*testSupportRouter\s*\)/.test(l));
if (mounts.length !== 1) {
  violations.push({ file: SERVER, line: mounts[0]?.n ?? 1, what: `testSupportRouter is mounted ${mounts.length} time(s); exactly one gated mount is allowed` });
}
for (const m of mounts) {
  if (!/if\s*\(\s*env\.COBBLR_TEST_ORG_POOL\s*\)/.test(m.l)) {
    violations.push({ file: SERVER, line: m.n, what: "testSupportRouter mounted without `if (env.COBBLR_TEST_ORG_POOL)` on the same line" });
  }
}
for (const f of sourceFiles("api/src/**/*.ts")) {
  if (f === SERVER || /\.test\.ts$/.test(f)) continue;
  readFileSync(f, "utf8").split("\n").forEach((l, i) => {
    if (/\buse\(\s*testSupportRouter\s*\)/.test(l)) violations.push({ file: f, line: i + 1, what: "testSupportRouter mounted outside server.ts's gated mount" });
  });
}

// Rule 2: the hold's write side has one door.
const WRITE_SIDE = /\b(registerOutboundHold|releaseOutboundHold|forgetOutboundHold)\b/;
const ALLOWED = new Set(["api/src/routes/test-support.ts", "packages/platform-net/src/index.ts", "packages/platform-net/src/outbound-hold.ts"]);
for (const f of [...sourceFiles("api/src/**/*.ts"), ...sourceFiles("modules/*/src/**/*.ts"), ...sourceFiles("packages/*/src/**/*.ts")]) {
  if (ALLOWED.has(f) || /\.test\.ts$/.test(f)) continue;
  readFileSync(f, "utf8").split("\n").forEach((l, i) => {
    if (WRITE_SIDE.test(l)) violations.push({ file: f, line: i + 1, what: "registers or releases an outbound hold outside routes/test-support.ts" });
  });
}

// Rule 3: no production shape sets the flag.
for (const f of [...sourceFiles("docker/**/*"), ...sourceFiles("docker-compose*.yml"), ...sourceFiles("deploy/**/*"), ...sourceFiles("selfhost/**/*")]) {
  if (!existsSync(f) || statSync(f).isDirectory() || /\.md$/.test(f)) continue;
  readFileSync(f, "utf8").split("\n").forEach((l, i) => {
    if (/^\s*-?\s*COBBLR_TEST_ORG_POOL\s*[:=]\s*["']?(1|true|on)/.test(l)) violations.push({ file: f, line: i + 1, what: "sets COBBLR_TEST_ORG_POOL in a deployable shape" });
  });
}

if (violations.length) {
  console.error(`lint:test-doors-gated - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("A test door lives inside routes/test-support.ts, behind server.ts's single `if (env.COBBLR_TEST_ORG_POOL)` mount. There is no opt-out.");
  process.exit(1);
}
console.log("lint:test-doors-gated OK: the test-support router has one gated mount; the outbound hold has one door; no deployable shape sets the flag.");
