// A typecheck that can report success without checking anything is worse than
// no typecheck, because everyone downstream believes it.
//
// 2026-09-04: `CI / typecheck` went GREEN on a commit whose web build had nine
// errors in one file, and main was red the moment it merged. The log says how:
//
//   === incremental cache ===
//   [tsbuild] restored 68 incremental file(s) from the host cache
//   web typecheck$ tsc -b --noEmit
//   web typecheck: Done
//
// `tsc -b` (build mode) decides what to check by comparing TIMESTAMPS, not
// content. The cache is restored AFTER checkout, so every restored
// `.tsbuildinfo` is newer than every source file, and build mode concludes the
// project is up to date and checks none of it. Reproduced locally: with the
// buildinfo touched newer than a file containing two real errors,
// `tsc -b --noEmit` prints nothing and exits 0; adding `--force` prints both.
//
// `--force` costs 2.6s on web (22.4s -> 25.0s), because the project graph gets
// walked either way. That is the whole price of the gate meaning something.
//
// ONLY build mode is affected. Plain `tsc --noEmit`, which every other
// workspace uses, always checks its files and needs nothing here.
//
// AND IT IS NOT ONLY THE SCRIPT CALLED `typecheck`. The rule keys off what the
// command DOES, not what it is named: `tsc -b --noEmit` is a check wearing a
// build's clothes. An EMITTING `tsc -b` may legitimately skip a project whose
// outputs are already current - the outputs are the evidence, and forcing it
// would just make real builds slower. A `--noEmit` one produces nothing but a
// VERDICT, so a skipped project makes that verdict false.
//
// web/package.json had exactly that one line above the fixed one:
// `"build": "tsc -b --noEmit && vite build"`. vite does not typecheck (esbuild
// strips types without checking them), so a build whose tsc step checked
// nothing succeeds on broken types just as quietly as the gate did.

import { readFileSync } from "node:fs";
import { sourceFiles } from "./lib/glob-exclude.mjs";

const offenders: string[] = [];

for (const file of sourceFiles("{,*/,*/*/}package.json")) {
  let pkg: { scripts?: Record<string, string> };
  try {
    pkg = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    continue;
  }
  for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
    if (typeof script !== "string") continue;
    // Build mode only. `tsc --noEmit` is not skippable.
    if (!/\btsc\s+(-b\b|--build\b)/.test(script)) continue;
    // An emitting build may skip: its outputs are the evidence. A --noEmit one
    // produces only a verdict, and a skipped project makes the verdict false.
    if (!/--noEmit\b/.test(script)) continue;
    if (/--force\b/.test(script)) continue;
    offenders.push(`${file}  ${name}: ${script}`);
  }
}

if (offenders.length > 0) {
  console.error(
    "[lint:typecheck-not-skippable] ✗ a build-mode typecheck can silently check nothing:\n" +
      offenders.map((o) => `  ${o}`).join("\n") +
      "\n\n  `tsc -b` skips a project whose .tsbuildinfo is newer than its sources,\n" +
      "  which is exactly what restoring an incremental cache after checkout does -\n" +
      "  it reported success over nine real errors and main went red on merge.\n" +
      "  A --noEmit build produces nothing but a verdict, so a skipped project\n" +
      "  makes that verdict false, whatever the script is called.\n" +
      "  Add --force. It costs seconds; a gate nobody can trust costs a day.",
  );
  process.exit(1);
}

console.log("[lint:typecheck-not-skippable] ✓ every --noEmit build-mode run actually checks");
