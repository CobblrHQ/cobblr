/**
 * One definition of "this path is build output", for everything that globs source.
 *
 * WHY THIS EXISTS: six call sites each wrote their own predicate as
 *
 *     exclude: (p) => p.includes("node_modules") || p.includes("/dist/")
 *
 * and every one was silently doing nothing. `globSync` hands `exclude` the DIRECTORY
 * paths it walks, without a trailing slash — "packages/thermal-print/dist" — so a
 * substring test for "/dist/" never matches, and neither does "node_modules" against
 * the directory named exactly that.
 *
 * CI never noticed, because a clean checkout has no build output to scan. Build
 * locally and generated files come into scope. On 2026-08-10 that made
 * lint:ble-chooser fail on a DOC COMMENT inside packages/thermal-print/dist/ble.d.ts,
 * a comment describing the very rule the lint enforces, and because lint:all runs in
 * the pre-push hook it blocked every push, including a release/nightly push in the
 * middle of a release.
 *
 * The quiet half is worse than that outage: run-unit-tests.mjs used the same predicate
 * to choose WHICH TESTS RUN, so a local build put compiled copies of the suite in
 * scope. Nothing failed, so nobody looked.
 *
 * Matching on path SEGMENTS works for a directory and a file alike, which is what the
 * callback is actually handed.
 *
 * This is .mjs, not .ts, so plain-node scripts and tsx-run lints can share ONE copy.
 * `lint:glob-exclude` requires it wherever globSync excludes build output.
 */
import { globSync } from "node:fs";

/** Path segments that are generated, never authored. */
export const BUILD_OUTPUT_SEGMENTS = new Set(["node_modules", "dist", "build", ".next", "coverage"]);

/**
 * True when any path SEGMENT is build output. Safe for directories and files.
 * @param {string} p
 * @returns {boolean}
 */
export function isBuildOutput(p) {
  return String(p).split("/").some((seg) => BUILD_OUTPUT_SEGMENTS.has(seg));
}

/**
 * Authored files matching `pattern`, with build output and generated declarations
 * removed.
 *
 * The filter runs TWICE deliberately: `exclude` prunes directories during the walk,
 * and the post-filter catches anything that slips through if that callback's contract
 * shifts again. A scan that silently returns nothing looks exactly like one that
 * passes, so this fails toward doing the work rather than skipping it.
 *
 * @param {string} pattern
 * @param {{ includeDts?: boolean }} [opts]
 * @returns {string[]}
 */
export function sourceFiles(pattern, opts = {}) {
  return globSync(pattern, { exclude: isBuildOutput })
    .map((p) => String(p))
    .filter((p) => !isBuildOutput(p))
    .filter((p) => opts.includeDts || !p.endsWith(".d.ts"));
}
