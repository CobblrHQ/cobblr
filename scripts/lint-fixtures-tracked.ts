// A test fixture that git ignores passes locally and fails in CI.
//
// This cost a red build the day it was written. A fixture was saved as
// `scripts/fixtures/release-already-current.log`, `.gitignore` carries a blanket
// `*.log`, and `git add -A` skipped it WITHOUT SAYING SO. The test then passed
// on the machine that wrote it — the file was right there on disk — and failed
// in CI with ENOENT, which reads like a broken test rather than a missing file.
//
// The shape is nastier than it sounds: the closer a fixture is to the real
// artifact it stands in for, the likelier its extension collides with an ignore
// rule. Logs, dumps, archives and generated output are exactly what you want a
// fixture to be, and exactly what a .gitignore excludes.
//
// So: nothing inside a fixtures/ directory may be ignored.

import { execFileSync } from "node:child_process";

function sh(args: string[]): string {
  try {
    return execFileSync("git", args, { encoding: "utf8" });
  } catch {
    return "";
  }
}

// Every path under any fixtures/ dir that git would ignore. --others includes
// untracked files (the ones at risk); --ignored lists what is excluded.
const ignored = sh(["ls-files", "--others", "--ignored", "--exclude-standard"])
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean)
  .filter((p) => /(^|\/)fixtures\//.test(p));

if (ignored.length) {
  console.error("[lint:fixtures-tracked] ✗ a fixture is excluded by .gitignore:\n");
  for (const p of ignored) {
    const rule = sh(["check-ignore", "-v", p]).trim().split("\t")[0] || "(a .gitignore rule)";
    console.error(`  ${p}\n      excluded by ${rule}`);
  }
  console.error(`
It exists on your machine, so your tests pass. It is not in the repository, so
CI fails with ENOENT — which reads like a broken test rather than a missing file.

Rename it out of the pattern (a release log as .txt, a dump as .sql.txt), or add
a negation to .gitignore if the extension genuinely matters to the fixture.`);
  process.exit(1);
}
console.log("[lint:fixtures-tracked] ✓ no fixture is excluded by .gitignore");
