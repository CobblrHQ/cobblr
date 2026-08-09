#!/usr/bin/env tsx
// Deploy/release scripts must reach the box through on_box(), never a literal ssh.
//
// WHY THIS IS A LINT: the same bug shipped FOUR times in one script family, each
// time silently and each time with a different symptom. Every one was a call site
// that spelled out `ssh "$BOX" …`, written from a workstation's point of view,
// then executed BY THE NIGHTLY CRON ON THAT BOX - where it is ssh-to-self and
// dies on "Host key verification failed":
//
//   has_image   -> every probe "no"  -> "no commit has images", release skipped
//   live_sha    -> under pipefail, ssh's 255 propagated -> `set -e` killed the
//                  release with NO output whatsoever
//   backup gate -> "FAIL ssh"        -> refused to promote, permanently
//   promote     -> would have failed the same way
//
// A doc cannot hold this: each new script looks correct in isolation and only
// misbehaves in the one environment nobody runs interactively. So the rule is
// mechanical - if a release-path script needs the box, it calls on_box.
//
//   cd <repo> && npx tsx scripts/lint-on-box.ts
//
// Local + CI, free, zero deps.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Scripts that run against the deploy box. */
const SCRIPTS_DIR = "scripts";
const LIB = "scripts/lib/on-box.sh";
/** on-box.sh is the ONE place allowed to spell out ssh. */
const EXEMPT = new Set([LIB]);

const failures: string[] = [];

// The helper itself must exist and keep its two load-bearing properties.
try {
  const lib = readFileSync(LIB, "utf8");
  if (!/on_box\(\)/.test(lib)) failures.push(`${LIB}: on_box() is gone.`);
  if (!/ON_BOX_MARKER/.test(lib)) {
    failures.push(
      `${LIB}: lost the marker-path detection.\n` +
        `    → do NOT switch to a hostname check: PROMOTE_BOX is an ssh ALIAS ("workshop")\n` +
        `      and the machine calls itself something else ("workshop-host"), so comparing\n` +
        `      them silently never matches and the bug comes back.`,
    );
  }
} catch {
  failures.push(`${LIB} is missing — every deploy script would go back to raw ssh.`);
}

const files = readdirSync(SCRIPTS_DIR)
  .filter((f) => f.endsWith(".sh"))
  .map((f) => join(SCRIPTS_DIR, f))
  .concat(
    readdirSync(join(SCRIPTS_DIR, "lib"))
      .filter((f) => f.endsWith(".sh"))
      .map((f) => join(SCRIPTS_DIR, "lib", f)),
  );

// A literal ssh to the box variable, ignoring comments.
const RAW_SSH = /^\s*[^#\n]*\bssh\b[^#\n]*"\$\{?(?:PROMOTE_)?BOX/;

for (const file of files) {
  if (EXEMPT.has(file)) continue;
  const src = readFileSync(file, "utf8");
  src.split("\n").forEach((line, i) => {
    if (RAW_SSH.test(line)) {
      failures.push(
        `${file}:${i + 1} reaches the box with a literal ssh:\n` +
          `    ${line.trim().slice(0, 96)}\n` +
          `    → use on_box "<command>" (source scripts/lib/on-box.sh). Run on the box\n` +
          `      itself, a literal ssh is ssh-to-self and fails host-key verification.`,
      );
    }
  });
  // A script that calls on_box must actually have it in scope.
  if (/\bon_box\b/.test(src) && !/on-box\.sh|shippable\.sh/.test(src)) {
    failures.push(
      `${file}: calls on_box but sources neither lib/on-box.sh nor lib/shippable.sh — it would die with "on_box: command not found".`,
    );
  }
}

if (failures.length) {
  console.error(`[lint:on-box] ✗ ${failures.length} problem(s):`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log("[lint:on-box] ✓ every deploy script reaches the box through on_box()");
