#!/usr/bin/env tsx
// A script or workflow that force-removes a container also removes its anonymous volumes (docker rm -fv), unless the line says why it keeps them (# keeps-volumes: <why>).
//
// THE BUG THIS PREVENTS. A nightly restore drill removed its throwaway Postgres
// with `docker rm -f`, which leaves the image's anonymous data volume behind. One
// volume a night for seven weeks filled a production box's disk to 94% (about
// 26 GB, found 2026-10-01). The self-host restore test and several CI workflows
// had the same line.
//
// THE RULE. Every `docker rm -f <name>` in a shell script, a workflow or a
// script that writes one is `docker rm -fv`, so a disposable container takes
// its anonymous volumes with it. Named volumes are never touched by -v. A
// container whose anonymous volumes must survive says so on the line:
// `# keeps-volumes: <why>`.
//
// THE BOUNDARY. The edge-bridge installer's container keeps its state in a
// NAMED volume, so -v would be safe there, but an installer on someone's own
// machine is the wrong place to find out; it carries the annotation instead.
//
//   npx tsx scripts/lint-docker-rm-takes-its-volumes.ts   (pnpm lint docker-rm-takes-its-volumes)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = [".forgejo", "deploy", "scripts", "docker", "api/src"];

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
    if (name === "node_modules" || name === "dist" || (name.startsWith(".") && name !== ".forgejo")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(sh|ya?ml|mjs)$/.test(name)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/docker\s+rm\s+-f(\s|$)/.test(line) && !/#\s*keeps-volumes:\s*\S/.test(line)) {
      out.push({ file, line: i + 1, what: "docker rm -f leaves the container's anonymous volumes behind: use docker rm -fv, or say why with # keeps-volumes: <why>" });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:docker-rm-takes-its-volumes - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:docker-rm-takes-its-volumes OK`);
