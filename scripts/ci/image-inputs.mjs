#!/usr/bin/env node
// Does this pull request change what goes into the API image? The API image check
// (api-image-check.yml) builds the whole image, boots every module in it and builds the
// cloud overlay on top: ten to thirty minutes on the one image slot. It is worth that only
// for a change to how the image is MADE, not to the code compiled into it (typecheck and the
// test suites judge that, on every pull request).
//
// WHY (owner, 2026-10-07): the CI queue sat at 56 to 75 and would not drain; 29 of 56 waiting
// jobs were this check. Its `paths:` filter looked right, but Forgejo judges paths against the
// pull request's STORED merge base, which goes stale the moment a branch merges main (the merge
// queue does that on every refresh): the diff then holds every lockfile and workflow change main
// made since, and the check ran for pull requests that touched none of them (#5194, #5227,
// #5215, #5172, #5212, #5269 against their true merge base: nothing). So the job asks itself,
// against the merge base git computes, and a pull request that changes no input says so and
// stands down in seconds; main still builds every image on every push (docker-build.yml).
//
// THE INPUTS ARE DERIVED, not listed by hand: every FILE a Dockerfile in docker/ COPYs from the
// build context (each package.json, the lockfile, the workspace and tsconfig base, a build
// script); every DIRECTORY it COPYs that is packaging rather than code (BUILD_DIRS); and the
// fixed set below (the Dockerfiles themselves, .dockerignore, the size budgets, deploy's compose
// files, the check's own workflow and scripts).
// A directory COPY that is source code covered by typecheck and the suites is CODE_DIRS. A new
// COPY of a directory that is in neither list fails lint:image-inputs-classified, so a new path
// cannot quietly fall out of the check.
//
//   node scripts/ci/image-inputs.mjs affected <base> <head>   "affected: <first input>" (exit 0) or "not affected" (exit 3)
//   node scripts/ci/image-inputs.mjs list                     the derived inputs
//   node scripts/ci/image-inputs.mjs paths                    the workflow's paths: filter, generated
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Directories a Dockerfile COPYs that are source code: judged by typecheck and the suites, not by a rebuild. */
//
// packages/platform-contract IS CODE (#5761). It was an input because the cloud overlay compiles
// against it, and its source changes were 70 of the ~106 image builds pull requests ran in three
// days (218 of 521 build-minutes on the one image slot). That compile needs no image: ci.yml's
// typecheck runs scripts/overlay-compat.sh on every pull request that touches the contract, about a
// second with tsgo. Its package.json is still an input (a file the Dockerfile COPYs), and what only
// the image would see is held at typecheck too: erasableSyntaxOnly in its tsconfig and
// lint:contract-sibling-imports for Node's type stripping.
export const CODE_DIRS = new Set(["api", "modules", "packages/platform-contract", "packages/platform-net", "packages/workspace-tools", "packages/thermal-print", "packages/platform-web", "web", "scripts", "sandboxed-modules", "changelog.d", "bundles", "docs/third-party", "deploy/seeds"]);
/** Directories a Dockerfile COPYs that are part of how the image is built: a change rebuilds. */
export const BUILD_DIRS = new Set(["modules/digifab/nesting"]);
/** Always inputs (prefixes), whatever the Dockerfiles say. */
export const FIXED = [
  "docker/",
  ".dockerignore",
  "deploy/image-size-budgets.json",
  "deploy/selfhost/",
  ".forgejo/workflows/api-image-check.yml",
  "scripts/ci/api-image-boot-checks.sh",
  "scripts/ci/docker-build-heal.sh",
  "scripts/ci/image-inputs.mjs",
  "scripts/ci/wait-for-room.sh",
];

/** PURE. The build-context sources of every COPY (not COPY --from) in a Dockerfile's text. */
export function copySources(dockerfile) {
  const out = [];
  for (const raw of dockerfile.split("\n")) {
    const line = raw.trim();
    if (!/^COPY\s/i.test(line) || /--from=/i.test(line)) continue;
    const words = line.replace(/^COPY\s+/i, "").split(/\s+/).filter((w) => !w.startsWith("--"));
    for (const src of words.slice(0, -1)) out.push(src.replace(/^\.\//, "").replace(/\/$/, ""));
  }
  return out;
}

/** The Dockerfiles under docker/ and their COPY sources, read from the tree. */
export function dockerfileSources(root = ROOT) {
  const files = readdirSync(join(root, "docker")).filter((f) => /Dockerfile$/.test(f));
  return files.flatMap((f) => copySources(readFileSync(join(root, "docker", f), "utf8")).map((src) => ({ file: `docker/${f}`, src })));
}

/** PURE. Is `src` (a COPY source) a directory? Judged by the tree listing: a path with entries under it. */
export function isDir(src, tracked) {
  return tracked.some((t) => t.startsWith(`${src}/`));
}

/** PURE. The input prefixes and exact files, from the COPY sources and the tracked file list. */
export function inputsFrom(sources, tracked) {
  const exact = new Set();
  const prefixes = new Set(FIXED);
  for (const { src } of sources) {
    if (isDir(src, tracked)) {
      if (BUILD_DIRS.has(src)) prefixes.add(`${src}/`);
    } else {
      exact.add(src);
    }
  }
  return { exact, prefixes };
}

/** PURE. The first changed path that is an input, or null. `versionBumpOnly(path)` says a
 *  package.json changed only its version. */
export function firstInput(changed, inputs, versionBumpOnly = () => false) {
  for (const p of changed) {
    if (/(^|\/)package\.json$/.test(p) && versionBumpOnly(p)) continue;
    if (inputs.exact.has(p)) return p;
    for (const pre of inputs.prefixes) if (pre.endsWith("/") ? p.startsWith(pre) : p === pre) return p;
    if (/(^|\/)package\.json$/.test(p) || /(^|\/)pnpm-lock\.yaml$/.test(p)) return p;
  }
  return null;
}

const under = (src, set) => [...set].some((d) => src === d || src.startsWith(`${d}/`));

/** PURE. COPY directories in neither list (what the lint refuses). A directory under a code root
 *  is code (web.Dockerfile copies module directories one by one), unless it is a build input. */
export function unclassified(sources, tracked) {
  return sources.filter(({ src }) => isDir(src, tracked) && !under(src, BUILD_DIRS) && !under(src, CODE_DIRS));
}

/** PURE. Two package.json texts that differ in nothing but "version" (the release-hygiene bump every
 *  feature pull request makes) change nothing the image build reads. Unreadable reads as a change. */
export function versionOnly(before, after) {
  try {
    const a = JSON.parse(before), b = JSON.parse(after);
    delete a.version; delete b.version;
    return JSON.stringify(a) === JSON.stringify(b);
  } catch { return false; }
}

/** PURE. The workflow's `paths:` filter for these inputs: the trigger, generated so it cannot drift
 *  from the gate (lint:image-inputs-classified compares). Forgejo judges it against a stale merge
 *  base, which only ever ADDS files, so it never misses an input; the gate step removes the rest. */
export function pathsFor(inputs) {
  const out = new Set(["**/package.json", "**/pnpm-lock.yaml"]);
  for (const pre of inputs.prefixes) out.add(pre.endsWith("/") ? `${pre}**` : pre);
  const dirs = [...inputs.prefixes].filter((p) => p.endsWith("/"));
  for (const f of inputs.exact) {
    if (/(^|\/)(package\.json|pnpm-lock\.yaml)$/.test(f) || dirs.some((d) => f.startsWith(d))) continue;
    out.add(f);
  }
  return [...out].sort();
}

const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, base, head = "HEAD"] = process.argv.slice(2);
  const tracked = git("ls-files").split("\n");
  const inputs = inputsFrom(dockerfileSources(), tracked);
  if (cmd === "paths") {
    for (const p of pathsFor(inputs)) console.log(p);
  } else if (cmd === "list") {
    for (const p of [...inputs.prefixes, ...inputs.exact].sort()) console.log(p);
  } else if (cmd === "affected") {
    if (!base) { console.log("affected: no base to compare with (judging it affected)"); process.exit(0); }
    const changed = git("diff", "--name-only", base, head).split("\n").filter(Boolean);
    const show = (rev, p) => { try { return git("show", `${rev}:${p}`); } catch { return ""; } };
    const hit = firstInput(changed, inputs, (p) => versionOnly(show(base, p), show(head, p)));
    if (hit) { console.log(`affected: ${hit}`); process.exit(0); }
    console.log(`not affected: none of the ${changed.length} changed file(s) is an image input`);
    process.exit(3);
  } else {
    console.error("usage: image-inputs.mjs affected <base> [head] | list");
    process.exit(64);
  }
}
