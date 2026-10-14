#!/usr/bin/env tsx
// Every docker build passes --force-rm and every docker run passes --rm or --name, in .forgejo/workflows and scripts: a legacy-builder step that fails leaves its container behind forever, and an unnamed run is a stray nobody can find.
//
// THE BUG THIS PREVENTS. a cloud overlay build under DOCKER_BUILDKIT=0 left step container lucid_elgamal on the CI box after a failed attempt its retry recovered (2026-09-28); the satellite detector flagged it as an unregistered container
//
// THE RULE. A `docker build` command (continuation lines joined) must carry
// `--force-rm`: under the legacy builder (DOCKER_BUILDKIT=0, which the cloud
// overlay build uses because buildx crashed on one runner) a step that fails,
// or whose commit fails, keeps its container forever; `--force-rm` removes it
// either way, and BuildKit ignores the flag, so it is always safe. A
// `docker run` must carry `--rm` (it goes when it ends) or `--name` (a
// deliberate, findable container: a pin, a service). Opt out with a comment
// `# docker-stray-ok: <reason>` on the line above.
//
// THE BOUNDARY. Text inside quotes is not a command: an `echo "... docker
// build cache ..."` warning is prose, and a payload handed to a remote shell
// is another box's command. Comment lines are skipped. `docker buildx build`
// is BuildKit by construction and out of scope. Lint files and tests are out
// of scope; they quote the commands they judge.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-docker-leaves-no-strays.ts   (pnpm lint docker-leaves-no-strays)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { onlyChanged } from "./lib/lint-only-files.ts";

const ROOTS = [".forgejo/workflows", "scripts"];

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
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ya?ml|sh|mjs|ts)$/.test(name) && !/\.test\.(ts|mjs)$/.test(name) && !/^lint-/.test(name)) yield p;
  }
}

/** The line with quoted text blanked, so prose and remote payloads are not
 *  read as this file's own commands. */
function unquoted(line: string): string {
  return line.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/** The check. Return every violation in one file; an empty array is a pass. */
export function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const first = lines[i] ?? "";
    if (/^\s*(#|\/\/)/.test(first)) continue;
    const code = unquoted(first);
    const kind = /(^|[\s;&|(])docker\s+build\b/.test(code) ? "build" : /(^|[\s;&|(])docker\s+run\b/.test(code) ? "run" : null;
    if (!kind) continue;
    // The whole command: this line and every continuation after it.
    let cmd = first;
    for (let j = i; /\\\s*$/.test(lines[j] ?? "") && j + 1 < lines.length; j++) cmd += " " + (lines[j + 1] ?? "");
    if (/docker-stray-ok: \S/.test(lines[i - 1] ?? "")) continue;
    if (kind === "build" && !/--force-rm\b/.test(cmd)) {
      out.push({ file, line: i + 1, what: "docker build without --force-rm: a failed legacy-builder step leaves its container behind" });
    }
    if (kind === "run" && !/(^|\s)--rm\b/.test(cmd) && !/(^|\s)--name[\s=]/.test(cmd)) {
      out.push({ file, line: i + 1, what: "docker run without --rm or --name: an unnamed container nobody removes" });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:docker-leaves-no-strays - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("add --force-rm to docker build; add --rm (or --name) to docker run");
  process.exit(1);
}
console.log(`lint:docker-leaves-no-strays OK`);
