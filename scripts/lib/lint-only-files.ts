// Pre-push lints cost the size of the change, not the repository (#6226). The pre-push hook's run
// (run-lints.mjs --reuse-ci) hands every lint the files this change touches, in COBBLR_LINT_ONLY_FILES (a file
// of paths, one per line). A lint whose verdict on a file depends on that file alone checks only those; CI runs
// every lint over the whole tree after, so nothing a per-file lint judges escapes it. Unset (CI, a lint run by
// hand), every file is checked, as before.
//
// Measured on 2026-10-14: a one-line change to one module file re-ran 304 of 506 lints over the whole tree,
// 82 s on the box (610 lint-seconds), because every lint that walks modules/ reads that file.
import { readFileSync } from "node:fs";

let only: Set<string> | null | undefined;

/** Should this file be checked in this run? Always, unless the run was handed the change's own files. */
export function onlyChanged(file: string): boolean {
  if (only === undefined) {
    const list = process.env.COBBLR_LINT_ONLY_FILES;
    only = null;
    if (list) {
      try {
        only = new Set(readFileSync(list, "utf8").split("\n").map((l) => l.trim().replace(/^\.\//, "")).filter(Boolean));
      } catch {
        only = null; // an unreadable list checks everything: never a pass for nothing
      }
    }
  }
  return only === null || only.has(file.replace(/^\.\//, ""));
}
