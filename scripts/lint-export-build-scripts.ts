#!/usr/bin/env tsx
/**
 * Every repo file a Dockerfile names under scripts/ must be shipped by the public export.
 *
 * The export allowlist is per-file globs. A Dockerfile step is not an import, so
 * nothing connected the two: `docker/api.Dockerfile` ran
 * `node scripts/install-registry-modules.mjs`, the manifest never listed it, and the
 * public repo could not build its own api image. It failed on 2026-08-11 with
 *
 *     Cannot find module '/app/scripts/install-registry-modules.mjs'
 *
 * the morning after that repo went public, and the only thing that noticed was
 * verify-public-export going red after the fact.
 *
 * This is deliberately NOT the same rule as the export's import gate. That one follows
 * relative imports; this one follows Dockerfile RUN lines, and neither can see what the
 * other checks. A missing build script is invisible in-repo, because in-repo the file
 * is right there, so it needs a check rather than more care.
 *
 * It follows every `scripts/` path a Dockerfile line names, not only the script it runs.
 * Matching just `node scripts/x.mjs` let `node scripts/prod-lockfile.mjs --from
 * scripts/ci/api-image-projects.json` through: the script shipped, its data file did not,
 * and verify-public-export was red every day from 2026-10-05 until 10-28 (ENOENT at the
 * api image's lockfile step) with this lint green.
 *
 * PERMANENT LINT.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const MANIFEST = join(ROOT, "scripts/publish/manifests/core.json");

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as { include?: string[] };
const include = manifest.include ?? [];

/** Glob match with the same semantics the exporter uses: `*` does not cross `/`. */
function matches(path: string, pattern: string): boolean {
  const rx = new RegExp(
    "^" +
      pattern
        .split("*")
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*") +
      "$",
  );
  return rx.test(path);
}

const dockerDir = join(ROOT, "docker");
const found = new Map<string, string>(); // script -> the Dockerfile that runs it

for (const name of readdirSync(dockerDir)) {
  if (!name.endsWith("Dockerfile") && !name.includes("Dockerfile")) continue;
  const src = readFileSync(join(dockerDir, name), "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  // A repo-relative path: a script it runs, a file it passes one, a COPY source. Not a path
  // inside the image (`./scripts/…`, `/app/scripts/…`), which the lookbehind leaves out.
  for (const m of src.matchAll(/(?<![\w./-])(scripts\/[A-Za-z0-9._/-]+\.[A-Za-z0-9]+)/g)) {
    if (!found.has(m[1]!)) found.set(m[1]!, name);
  }
}

const missing = [...found].filter(([script]) => !include.some((p) => matches(script, p)));

if (missing.length) {
  console.error("Dockerfile names a file the public export does not ship:\n");
  for (const [script, dockerfile] of missing) {
    console.error(`  ${script}`);
    console.error(`    named by docker/${dockerfile}, absent from scripts/publish/manifests/core.json`);
  }
  console.error(`
Anyone building from the public repo fails at that step ("Cannot find module", ENOENT). Add it to
\`include\` in the manifest:

    "${missing[0]?.[0]}",
`);
  process.exit(1);
}

console.log(`lint:export-build-scripts: OK (${found.size} file(s) the Dockerfiles name, all shipped)`);
