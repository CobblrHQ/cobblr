#!/usr/bin/env tsx
/**
 * lint:glob-exclude — globSync's `exclude` must be the shared predicate, never a
 * hand-rolled substring test.
 *
 * `globSync` hands `exclude` the DIRECTORY paths it walks, without a trailing slash
 * ("packages/thermal-print/dist"). So the obvious-looking predicate
 *
 *     exclude: (p) => p.includes("node_modules") || p.includes("/dist/")
 *
 * matches NOTHING and the exclusion silently does nothing at all. Four lints shipped
 * with exactly that, and all four looked fine, because CI checks out a clean tree with
 * no build output to scan.
 *
 * It surfaced on 2026-08-10 as lint:ble-chooser failing on a DOC COMMENT inside
 * packages/thermal-print/dist/ble.d.ts — a comment describing the rule the lint
 * enforces — which, through the pre-push hook, blocked every push including a
 * release/nightly push mid-release.
 *
 * A silently-empty exclusion is the dangerous half. The lint still passes, so nobody
 * looks, and it scans generated code forever until one generated file happens to trip
 * it. Hence a lint rather than a comment.
 *
 * PERMANENT LINT.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const files = execFileSync("git", ["-C", ROOT, "ls-files", "scripts"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => /\.(ts|mts|mjs)$/.test(f));

/** This file quotes the bad form to explain it; so does the helper it points at. */
const SELF = new Set(["scripts/lint-glob-exclude.ts", "scripts/lib/glob-exclude.ts"]);

const violations: { file: string; line: number; text: string }[] = [];

for (const rel of files) {
  if (SELF.has(rel)) continue;
  let src: string;
  try {
    src = readFileSync(`${ROOT}/${rel}`, "utf8");
  } catch {
    continue;
  }
  if (!src.includes("exclude:")) continue;

  src.split("\n").forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*")) return;
    // Must look like an OBJECT PROPERTY: either the line begins with it, or it follows
    // a `{` or `,`. Without that anchor the word "exclude:" inside ordinary prose was
    // flagged — export-repo.mjs says `carved out by exclude: ${…}` in a status line,
    // and the first version of this rule reported it as a violation.
    const asProperty = /(^|[{,])\s*exclude:\s*(\(|[A-Za-z_$])/;
    if (!asProperty.test(line)) return;
    // The shared predicate, by name, is the whole point.
    if (/\bexclude:\s*isBuildOutput\b/.test(line)) return;
    violations.push({ file: rel, line: i + 1, text: t.slice(0, 96) });
  });
}

if (violations.length) {
  console.error("globSync exclude must use the shared predicate:\n");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.text}`);
  }
  console.error(`
globSync passes \`exclude\` the DIRECTORY paths it walks, with no trailing slash, so an
inline substring test like p.includes("/dist/") matches nothing and the exclusion
silently does nothing. Use the shared helper, which matches path SEGMENTS:

  import { sourceFiles } from "./lib/glob-exclude.js";
  const files = sourceFiles("{packages,modules,web,api}/**/*.{ts,tsx}");

or, if you need globSync directly:

  import { isBuildOutput } from "./lib/glob-exclude.js";
  globSync(pattern, { exclude: isBuildOutput })
`);
  process.exit(1);
}

console.log(`lint:glob-exclude: OK (${files.length} script(s) scanned)`);
