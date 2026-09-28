// The repository's files as a lint should see them: tracked, AND new files not
// yet committed (ignored ones excluded). A lint that read `git ls-files` alone
// passed on the machine where a new file was written, because the file was not
// tracked yet, and failed in CI on the same tree once it was committed. The
// local run and the CI run must judge the same files.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

export function repoFiles(pathspecs: string[] = [], cwd?: string): string[] {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", ...pathspecs], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...(cwd ? { cwd } : {}),
  });
  const seen = new Set<string>();
  for (const f of out.split("\n")) {
    // A tracked file deleted in the working tree is still listed by --cached.
    if (f && !seen.has(f) && existsSync(cwd ? `${cwd}/${f}` : f)) seen.add(f);
  }
  return [...seen];
}
