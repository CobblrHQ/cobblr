#!/usr/bin/env tsx
// The deployed copy of scripts/lib/box-alert.sh in the sibling server-setup
// checkout is byte-identical below its header; a checkout without the sibling
// skips.
//
// THE BUG THIS PREVENTS. The alert library lives here (with its tests) and is
// COPIED into the server-setup repo, which is what the app boxes deploy from.
// On 2026-09-13 the two were identical by discipline only: a `cp` after every
// change, remembered by one person. The day someone fixes the library here and
// forgets the copy, the app boxes run an older alert path than the CI box,
// which is exactly the two-alert-paths split this library was written to end.
//
// THE RULE. Everything from the line `# Sourced by ci-runner-health.sh` to the
// end of the file must be byte-identical in both copies. The header above that
// line is allowed to differ (each repo says where its copy comes from). When
// the sibling checkout is not present (CI, a machine without server-setup) the
// lint prints "skipped" and passes: the copy is a cross-repo fact this repo
// cannot see, and the pre-push hook on the machine that HAS both is where the
// drift is caught. Override the sibling path with ALERT_LIB_SIBLING.
//
// A genuine divergence has no opt-out: fix the copy (`cp` this file over it,
// keep its header), or fix this file.
//
// IT FAILS ONLY THE PUSH THAT CAN FIX IT (2026-10-17). server-setup #301 took
// the library's new copy before core's own pull request (#7039) had merged, and
// from then every session's core push failed here, for a change none of them
// made and none could land. A push whose tree has the library exactly as main
// has it is told, loudly, and passes; a push that changes the library itself
// must still match the copy (or leave the copy as main's: the copy follows
// after the merge).
//
// PROVE IT RED before you trust it green: change one character in the copy,
// run it, watch it fail, put it back.
//
//   npx tsx scripts/lint-alert-lib-sync.ts   (pnpm run lint alert-lib-sync)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const OURS = "scripts/lib/box-alert.sh";
const SIBLING =
  process.env.ALERT_LIB_SIBLING ??
  resolve(process.cwd(), "../../server-setup/scripts/box-guardrails/lib/box-alert.sh");
const MARK = "# Sourced by ci-runner-health.sh";

function body(file: string): string {
  return bodyOf(readFileSync(file, "utf8"), file);
}
function bodyOf(src: string, file: string): string {
  const at = src.indexOf(MARK);
  if (at < 0) throw new Error(`${file}: header marker "${MARK}" not found`);
  return src.slice(at);
}

if (!existsSync(SIBLING)) {
  console.log(`lint:alert-lib-sync skipped (no sibling checkout at ${SIBLING})`);
  process.exit(0);
}

const a = body(OURS).split("\n");
const b = body(SIBLING).split("\n");
let firstDiff = -1;
for (let i = 0; i < Math.max(a.length, b.length); i++) {
  if (a[i] !== b[i]) {
    firstDiff = i;
    break;
  }
}
/** origin/main's copy of the library, or null when git cannot say (no remote ref in a bare test tree). */
function mainBody(): string | null {
  try {
    const ref = process.env.ALERT_LIB_MAIN_REF ?? "origin/main";
    return bodyOf(execFileSync("git", ["show", `${ref}:${OURS}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }), `${ref}:${OURS}`);
  } catch {
    return null;
  }
}
if (firstDiff >= 0) {
  const onMain = mainBody();
  const ours = a.join("\n");
  const theirs = b.join("\n");
  if (onMain !== null && ours === onMain) {
    console.log(`lint:alert-lib-sync WARNING (not this push's): the server-setup copy differs from main's library, first at body line ${firstDiff + 1}.`);
    console.log(`  This push leaves the library as main has it, so it passes. Land the library's core pull request, or bring the copy back to main's.`);
    process.exit(0);
  }
  if (onMain !== null && theirs === onMain) {
    console.log(`lint:alert-lib-sync OK: this push changes the library and the server-setup copy is still main's; copy it over after this merges, and redeploy.`);
    process.exit(0);
  }
  console.error(`lint:alert-lib-sync - the deployed copy of the alert library has drifted from this one.`);
  console.error(`  ${OURS} and ${SIBLING} differ below the header, first at body line ${firstDiff + 1}:`);
  console.error(`    core:         ${JSON.stringify(a[firstDiff] ?? "<end of file>")}`);
  console.error(`    server-setup: ${JSON.stringify(b[firstDiff] ?? "<end of file>")}`);
  console.error(`  Fix: copy this file over the sibling (keep the sibling's header), commit both, redeploy the copy.`);
  process.exit(1);
}
console.log(`lint:alert-lib-sync OK (${a.length} lines identical below the header)`);
