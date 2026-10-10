// Every test file gets its own temporary directory, removed when the file
// finishes, so nothing a test (or a process it starts) writes under
// os.tmpdir() outlives it.
//
// On 2026-09-30 the runner host's /tmp (a tmpfs) ran out of INODES, 1,048,575
// of 1,048,576, with 34 GB of space free, and every session's shell died
// with ENOSPC: days of tests' fixture repositories and spooled blobs,
// `mkdtemp(join(tmpdir(), "lint-…"))` 186k inodes, "triage-says-" 74k and more,
// from 63 test files that make a temporary directory and never remove it.
// Fixing each file keeps the next one from forgetting nothing; this does it
// for all of them: the setup points TMPDIR at a directory of the file's own
// (node's tmpdir() reads TMPDIR on every call, and every child process
// inherits it), and removes it in the file's afterAll, with an exit hook
// behind it for a file that dies.

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const ORIGINAL = "COBBLR_TEST_TMP_BASE";

/** Point TMPDIR at a fresh directory for the running test file; remove it after. */
export function scopeTmpdir(afterAll) {
  if (!process.env[ORIGINAL]) process.env[ORIGINAL] = process.env.TMPDIR || "/tmp"; // verdict-env: restores the variables this file set, by their names
  const dir = mkdtempSync(join(process.env[ORIGINAL], "vitest-file-")); // verdict-env: restores the variables this file set, by their names
  process.env.TMPDIR = dir;
  const remove = () => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      /* a process still writing; the exit hook tries again */
    }
  };
  afterAll(remove);
  process.once("exit", remove);
  return dir;
}
