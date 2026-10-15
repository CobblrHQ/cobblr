#!/usr/bin/env tsx
// Only a job that writes to the registry names secrets.REGISTRY_TOKEN; every job that only reads it uses REGISTRY_READ_TOKEN
//
// THE BUG THIS PREVENTS. 2026-10-15: the new-app proof and every pull request's nesting fetch and image pulls ran with the registry's write token, so a pull request's code could publish
//
// THE RULE. In .forgejo/workflows, a line naming secrets.REGISTRY_TOKEN (write:package) must sit in a job
// listed in WRITERS below, with what that job writes. Every other job that touches the registry, an image
// pull, a package install, a manifest read, uses secrets.REGISTRY_READ_TOKEN (read:package on the CI bot,
// a member of CobblrHQ's package-readers team). A comment line is not a use.
//
// THE BOUNDARY. watch.yml's watch job is listed though it writes nothing: it checks that the publish token
// itself is still accepted, which only that token can show. Nothing else has tested the boundary yet.
//
//   npx tsx scripts/lint-registry-token-only-where-it-writes.ts   (pnpm lint registry-token-only-where-it-writes)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = [".forgejo/workflows"];

/** The jobs that write to the registry, by workflow file and job id, and what they write. */
const WRITERS: Record<string, Record<string, string>> = {
  "publish-packages.yml": { publish: "publishes the engine packages" },
  "overlay-kit.yml": { publish: "publishes the overlay kit" },
  "docker-build.yml": { build: "pushes the core images" },
  "museum-build.yml": { build: "pushes a museum build's images" },
  "nesting-wasm.yml": { publish: "publishes the nesting solver" },
  "registry-retention.yml": { prune: "deletes old package versions" },
  "watch.yml": { watch: "checks that the publish token itself is still accepted" },
};

/** One offending place. `line` is 1-based for a clickable path:line. */
interface Violation {
  file: string;
  line: number;
  what: string;
}

function* walk(dir: string): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    // An embedded payload (a base64 build) holds no code to judge and is megabytes.
    else if (/\.ya?ml$/.test(name)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  const allowed = WRITERS[basename(file)] ?? {};
  let inJobs = false;
  let job: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^jobs:\s*$/.test(line)) inJobs = true;
    else if (/^\S/.test(line)) inJobs = false;
    const j = inJobs ? /^  ([A-Za-z0-9_-]+):\s*$/.exec(line) : null;
    if (j) job = j[1] ?? null;
    if (/^\s*#/.test(line) || !/secrets\.REGISTRY_TOKEN\b/.test(line)) continue;
    if (job && allowed[job]) continue;
    out.push({ file, line: i + 1, what: `${job ? `job ${job}` : "outside any job"} names the registry's write token but writes nothing to the registry (or is not in WRITERS)` });
  }
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:registry-token-only-where-it-writes - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("use secrets.REGISTRY_READ_TOKEN, or add the job to WRITERS with what it writes");
  process.exit(1);
}
console.log(`lint:registry-token-only-where-it-writes OK`);
