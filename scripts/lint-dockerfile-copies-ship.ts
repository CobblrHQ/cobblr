#!/usr/bin/env tsx
// Every path a shipped Dockerfile COPYs from the build context is a path the
// public export manifest ships.
//
// THE BUG THIS PREVENTS. The public repo is a sanitized export of core, and
// `verify-public-export.yml` proves nightly that the exported tree still
// builds. On 2026-09-20 it started failing and stayed red for three nights,
// unread: `docker/api.Dockerfile` COPYs `deploy/seeds` (the try sandbox's
// stock, which api/src/platform/try-sandbox-seed.ts resolves at runtime), the
// manifest shipped `deploy/selfhost/**` and nothing else under `deploy/`, and
// the exported tree's `docker build` died at that COPY. Anyone building from
// the public repo hit the same error, so "read the public code to know what
// you are running" did not hold.
//
// The cheap leg could not catch it. verify-export.mjs's PARITY check asserts
// every runtime-critical SOURCE file is present, and its list is curated
// source globs (api/src, web/src, modules, bundles, docker/*.Dockerfile). A
// directory that only a Dockerfile copies is not source, so parity passed and
// only the nightly docker build failed.
//
// THE RULE. Read the COPY lines out of every Dockerfile the manifest ships
// (discovered, not curated: a new COPY is covered the day it lands), and ask
// the EXPORTER whether each build-context source ships, through its own
// shippedPaths from scripts/publish/path-gate.mjs, so this lint and the export
// cannot disagree. A source that is not in the export fails. Out of scope, by
// construction rather than by exception: a path from another build stage
// (--from=..., or an absolute /app/... written by an earlier stage), which is
// not read from the build context at all.
//
// PROVE IT RED: on the tree at a0ff9dd53 it names deploy/seeds.
//
//   npx tsx scripts/lint-dockerfile-copies-ship.ts   (pnpm run lint dockerfile-copies-ship)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// path-gate.mjs is plain JS, so its return is untyped here; the cast is the
// one place this file says what the exporter hands back.
import { shippedPaths as shippedPathsUntyped } from "./publish/path-gate.mjs";
import { copySources } from "./lib/dockerfile-copy.js";

export { copySources };

const shippedPaths = shippedPathsUntyped as (tracked: string[], manifest: { include: string[]; exclude?: string[] }) => string[];

const ROOT = process.env.COBBLR_LINT_ROOT ?? ".";
const MANIFEST = join(ROOT, "scripts", "publish", "manifests", "core.json");

interface Violation {
  file: string;
  line: number;
  src: string;
}

/** The repo's tracked paths, which is what the exporter itself walks. */
function tracked(): string[] {
  return execFileSync("git", ["-C", ROOT, "ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
}


const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as { include: string[]; exclude?: string[] };
const all = tracked();
const ships = new Set(shippedPaths(all, manifest));
const shipsUnder = (src: string): boolean => {
  const p = src.replace(/^\.\//, "").replace(/\/$/, "");
  if (ships.has(p)) return true;
  // A directory ships when anything under it does: that is what COPY reads.
  const prefix = `${p}/`;
  for (const s of ships) if (s.startsWith(prefix)) return true;
  return false;
};
// A COPY source that is not in the repo at all is a different defect (a stale
// Dockerfile), and lint:dockerfile-paths-exist is not this lint's job; a path
// the repo does not track cannot be missing from the export.
const inRepo = (src: string): boolean => {
  const p = src.replace(/^\.\//, "").replace(/\/$/, "");
  return all.includes(p) || all.some((f) => f.startsWith(`${p}/`));
};

const violations: Violation[] = [];
for (const file of [...ships].filter((p) => /(^|\/)[^/]*Dockerfile[^/]*$/.test(p)).sort()) {
  const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const src of copySources(line)) {
      if (!inRepo(src) || shipsUnder(src)) continue;
      violations.push({ file, line: i + 1, src });
    }
  });
}

if (violations.length) {
  console.error(`lint:dockerfile-copies-ship - ${violations.length} path(s) a shipped Dockerfile COPYs that the public export does not ship:`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  COPY ${v.src}`);
  console.error(`
The exported tree's docker build dies at that COPY, so the public repo cannot build
its own images and a self-hoster building from it hits the same error. Add the path to
"include" in scripts/publish/manifests/core.json, or stop copying it in the Dockerfile.`);
  process.exit(1);
}
console.log(`lint:dockerfile-copies-ship OK (${[...ships].filter((p) => /Dockerfile/.test(p)).length} shipped Dockerfile(s))`);
