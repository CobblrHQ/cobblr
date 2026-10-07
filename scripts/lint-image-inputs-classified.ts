#!/usr/bin/env tsx
// Every directory a Dockerfile COPYs is classified as code or as a build input, and the API image check's paths filter is exactly the inputs derived from the Dockerfiles, so a new COPY cannot fall out of the check.
//
// THE BUG THIS PREVENTS. 2026-10-07: 29 of 56 queued CI jobs were the API image check, started by a
// hand-written paths filter that Forgejo judged against stale merge bases, for pull requests that
// changed no image input. The check now decides for itself from inputs DERIVED from the Dockerfiles
// (scripts/ci/image-inputs.mjs); this keeps the derivation honest.
//
// THE RULE. Two checks:
//   1. Each COPY of a build-context DIRECTORY in docker/*.Dockerfile is under CODE_DIRS (source the
//      typecheck and suites judge) or BUILD_DIRS (part of how the image is built). A new directory in
//      neither fails: someone decides which it is.
//   2. The `paths:` block of .forgejo/workflows/api-image-check.yml is exactly what
//      `node scripts/ci/image-inputs.mjs paths` prints, so the trigger and the gate never disagree.
// COPY of a single file needs no classifying: every file COPY is an input by construction.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. web.Dockerfile copies module directories one by
// one (modules/inventory, modules/labels, ...): those are code under the `modules` root, not new
// directories, so a directory under a classified root is classified.
//
//   npx tsx scripts/lint-image-inputs-classified.ts   (pnpm lint image-inputs-classified)
import { readFileSync } from "node:fs";
import { dockerfileSources, inputsFrom, pathsFor, unclassified } from "./ci/image-inputs.mjs";
import { repoFiles } from "./lib/repo-files.js";

const WORKFLOW = ".forgejo/workflows/api-image-check.yml";
const problems: string[] = [];

const tracked = repoFiles();
const sources = dockerfileSources();
for (const u of unclassified(sources, tracked) as { file: string; src: string }[]) {
  problems.push(`${u.file}: COPY ${u.src} is a directory in neither CODE_DIRS nor BUILD_DIRS (scripts/ci/image-inputs.mjs): say whether a change there needs the image rebuilt`);
}

const want: string[] = pathsFor(inputsFrom(sources, tracked));
const yml = readFileSync(WORKFLOW, "utf8");
const m = /^ {2}pull_request:\n(?:[ ]{4}#.*\n)*[ ]{4}paths:\n((?:[ ]{6}- .*\n)+)/m.exec(yml);
const have = m ? m[1]!.split("\n").filter(Boolean).map((l) => l.replace(/^\s*-\s*'?|'?\s*$/g, "")) : null;
if (!have) problems.push(`${WORKFLOW}: no pull_request paths: block found`);
else if (JSON.stringify(have) !== JSON.stringify(want)) {
  const missing = want.filter((w) => !have.includes(w));
  const extra = have.filter((h) => !want.includes(h));
  problems.push(`${WORKFLOW}: the paths: block is not the derived inputs${missing.length ? `; missing ${missing.join(", ")}` : ""}${extra.length ? `; extra ${extra.join(", ")}` : ""}`);
}

if (problems.length) {
  console.error(`lint:image-inputs-classified - ${problems.length} violation(s):`);
  for (const p of problems) console.error(`  ${p}`);
  console.error("classify the directory in scripts/ci/image-inputs.mjs (CODE_DIRS or BUILD_DIRS), or regenerate the paths block with node scripts/ci/image-inputs.mjs paths");
  process.exit(1);
}
console.log(`lint:image-inputs-classified OK (${sources.length} COPY sources classified; the paths filter is the ${want.length} derived inputs)`);
