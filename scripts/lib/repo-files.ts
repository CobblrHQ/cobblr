// The repository's files as a lint should see them: tracked, AND new files not
// yet committed (ignored ones excluded). A lint that read `git ls-files` alone
// passed on the machine where a new file was written, because the file was not
// tracked yet, and failed in CI on the same tree once it was committed. The
// local run and the CI run must judge the same files.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

/** A new file in a hidden directory below the top level (scripts/.new-test-x/) is a
 *  tool's scratch, written and deleted while other tests run: listed here, it
 *  vanished before a lint read it (main red, 2026-10-13). A top-level hidden
 *  directory (.forgejo/) is real and stays judged. */
const isScratch = (f: string) => f.split("/").slice(0, -1).some((seg, i) => i > 0 && seg.startsWith("."));

/** A file's text, or null when it vanished since it was listed. */
export function readRepoFile(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export function repoFiles(pathspecs: string[] = [], cwd?: string): string[] {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", ...pathspecs], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...(cwd ? { cwd } : {}),
  });
  const tracked = new Set(
    execFileSync("git", ["ls-files", "--cached", "--", ...pathspecs], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...(cwd ? { cwd } : {}) }).split("\n"),
  );
  const seen = new Set<string>();
  for (const f of out.split("\n")) {
    if (!tracked.has(f) && isScratch(f)) continue;
    // A tracked file deleted in the working tree is still listed by --cached.
    if (f && !seen.has(f) && existsSync(cwd ? `${cwd}/${f}` : f)) seen.add(f);
  }
  return [...seen];
}

/** The repository's files (tracked, and new ones not yet committed) under
 *  `pathspecs` whose text contains `needle`, picked by git before any is read.
 *  A lint that reads every file to find one string grows with the tree until it
 *  is over its read budget: lint:node-resolves read all of scripts/ to find
 *  "@cobblr/" and turned main red (9d2f5b33e). Pathspecs with ** carry :(glob). */
export function repoFilesContaining(needle: string, pathspecs: string[], cwd?: string): string[] {
  let out = "";
  try {
    out = execFileSync("git", ["grep", "--untracked", "-l", "-F", "-e", needle, "--", ...pathspecs], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      ...(cwd ? { cwd } : {}),
    });
  } catch (e) {
    // git grep exits 1 when nothing matches; anything else is a real failure.
    if ((e as { status?: number }).status === 1) return [];
    throw e;
  }
  return out.split("\n").filter((f) => f && !isScratch(f) && existsSync(cwd ? `${cwd}/${f}` : f));
}
