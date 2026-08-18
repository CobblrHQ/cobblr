// Guard: every Forgejo Actions API call that passes `limit` must also pass `page`.
//
// WHY THIS IS A LINT: on this Forgejo, `limit` ALONE IS SILENTLY IGNORED by the
// actions endpoints. `?limit=40` does not return 40 rows — it returns every task
// the instance has ever run. Measured 2026-08-17 at ~24k tasks:
//
//     actions/tasks?limit=40           12 MB     17.9 s
//     actions/tasks?limit=40&page=1    21 KB      0.075 s
//     actions/runs?limit=40           160 MB     10.6 s
//
// Nothing errors. The call just gets slower every week as history grows, until it
// crosses whatever timeout the caller set — and then it fails in a way that looks
// like anything but pagination.
//
// It cost a full CI outage. docker-build's deploy gate polled
// `actions/tasks?limit=40` every 10s with `curl --max-time 15`. Once the response
// passed 15s, EVERY poll timed out, so the gate never saw its own test result: it
// burned all 78 iterations, pinned a runner for ~30 minutes per deploy, and
// fail-opened. Worse, each of those polls streamed 12 MB out of the same Forgejo
// instance the runners fetch their jobs from, with several gates in flight at
// once — so job dispatch crawled and the whole queue backed up behind it.
//
// The failure mode is invisible in review (`?limit=40` reads as obviously
// bounded) and invisible in testing (it works fine on a young instance). So it
// gets checked mechanically instead.
//
// Deliberately showing the broken form (a doc explaining the trap)? Put
// `pagination-anti-example` on the line — explicit, per-line, and greppable.
//
// Run: npx tsx scripts/lint-forgejo-pagination.ts

import { execFileSync } from "node:child_process";

/** Endpoints where `limit` needs `page` to bind. */
const ENDPOINTS = /actions\/(tasks|runs|artifacts)/;

let out = "";
try {
  // Literal prefilter, then the real test in JS — a regex over the whole tree is
  // what made lint:ci-sink cost 151s (see scripts/run-lints.mjs BUDGET_MS).
  out = execFileSync("git", ["grep", "-nF", "actions/tasks", "--", ".", ":!*.lock"], { encoding: "utf8" });
} catch {
  // git grep exits 1 on no match.
}
try {
  out += execFileSync("git", ["grep", "-nF", "actions/runs", "--", ".", ":!*.lock"], { encoding: "utf8" });
} catch {
  /* no match */
}

const offenders: string[] = [];
for (const line of out.split("\n")) {
  if (!line.trim()) continue;
  // `file:lineno:content`
  const firstColon = line.indexOf(":");
  const secondColon = line.indexOf(":", firstColon + 1);
  if (secondColon === -1) continue;
  const where = line.slice(0, secondColon);
  const content = line.slice(secondColon + 1);

  // This lint documents the trap, so it necessarily contains the bad string.
  if (where.startsWith("scripts/lint-forgejo-pagination.ts")) continue;

  if (!ENDPOINTS.test(content)) continue;
  if (!/[?&]limit=/.test(content)) continue; // no limit → no false expectation
  if (/[?&]page=/.test(content)) continue; // correctly paginated
  // A doc that TEACHES this trap has to show the broken form. Docs stay in
  // scope otherwise (one telling you to use the unpaginated call is a real bug,
  // and this lint caught exactly that in a skill), so the opt-out is explicit
  // and per-line rather than a blanket exemption for docs/.
  if (/pagination-anti-example/.test(content)) continue;
  // A prose mention of the trap is not a call site.
  if (/^\s*(#|\/\/|\*|-|>)/.test(content) && !/curl|fetch\(|http/i.test(content)) continue;

  offenders.push(`${where}: ${content.trim().slice(0, 120)}`);
}

if (offenders.length) {
  console.error("✗ lint-forgejo-pagination: `limit` without `page` is ignored — this returns the FULL history:\n");
  for (const o of offenders) console.error(`  ${o}`);
  console.error(
    "\n  Add `&page=1`. Without it the response is every task the instance ever ran\n" +
      "  (12 MB / 17.9s at 24k tasks, and growing), which eventually blows past the\n" +
      "  caller's timeout and takes Forgejo's job dispatch down with it.\n",
  );
  process.exit(1);
}
console.log("✓ forgejo-pagination lint: every actions API call with `limit` also passes `page`");
process.exit(0);
