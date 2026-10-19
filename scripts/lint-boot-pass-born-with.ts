#!/usr/bin/env tsx
// A boot pass under api/src/platform says where a NEW workspace gets the same thing: a BORN WITH: line naming the function signup or enable calls, or BORN WITH: nothing (why a fresh workspace cannot need it).
//
// THE BUG THIS PREVENTS. The scan category axis was created by the boot pass
// alone, so a workspace signed up between two restarts was born without it
// and stayed so until the next deploy, a day on the hosted product (#3252,
// found on a first-run walk, 2026-09-20). docs/architecture/platform-spec.md §8.1 is about EXISTING
// workspaces healing on the next boot; this is the worse version, a workspace
// that starts life missing the capability, and nothing had asked the
// question of any other pass. Asked once, by hand, the answer was: of the
// sixteen passes boot() runs from api/src/platform, four give a workspace
// something it needs (default modules, default wires, the app's scan
// fallback, the scan axis); the axis was the one with no signup-time
// counterpart. The rest heal a shape a fresh workspace cannot have. This
// lint makes each file carry its half of that answer, so the next pass
// answers it at authoring time.
//
// THE RULE. Every boot pass whose function lives under api/src/platform (one
// `boot()` in api/src/index.ts times as `T("<name>", <name>(...))`, or one
// registered in api/src/platform/boot/, #7387) must carry, in that file, one
// of:
//   BORN WITH: <identifier> ...   the function a new workspace goes through
//                                 that gives it the same thing (signup, an
//                                 enable, provisioning); the identifier must
//                                 be defined under api/src, so it cannot name
//                                 an intention
//   BORN WITH: nothing (<reason>) a pass with no per-workspace creation: a
//                                 heal of rows a bug or an older shape wrote,
//                                 a per-user or cluster-wide sweep
// Passes outside api/src/platform (the module registry, mounting, module
// onBoot hooks) are not judged: they are process-wide, not per-workspace.
//
// PROVE IT RED before you trust it green: against the tree as of 39d8c79ab it
// names every one of the sixteen files.
//
//   npx tsx scripts/lint-boot-pass-born-with.ts   (pnpm run lint boot-pass-born-with)
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { bootPassRefs } from "./lib/boot-passes.ts";

const LINT_ROOT = process.env.COBBLR_LINT_ROOT || ".";
const INDEX = join(LINT_ROOT, "api/src/index.ts");
const SRC = join(LINT_ROOT, "api/src");
const PLATFORM = join(LINT_ROOT, "api/src/platform");

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
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) yield p;
  }
}

/** The boot passes whose function lives under api/src/platform: the ones
 *  index.ts times itself and the registry's (scripts/lib/boot-passes.ts). */
export function bootPasses(root: string): Array<{ name: string; file: string }> {
  return bootPassRefs(root)
    .filter((p): p is typeof p & { file: string } => !!p.file && resolve(p.file).startsWith(resolve(PLATFORM)))
    .map((p) => ({ name: p.fn, file: p.file }));
}

let sources: string[] | undefined;

/** Whether an identifier is defined somewhere under api/src. */
function definedUnderSrc(ident: string): boolean {
  const re = new RegExp(`\\b(?:function|const|let|class)\\s+${ident}\\b|\\b${ident}\\s*=\\s*(?:async\\s*)?\\(`);
  sources ??= [...walk(SRC)].map(f => readFileSync(f, "utf8"));
  if (sources.some(src => re.test(src))) return true;
  return false;
}

export function checkPass(file: string, src: string): Violation[] {
  const rel = relative(LINT_ROOT, file);
  const m = /BORN WITH:\s*(\S+)([^\n]*)/.exec(src);
  if (!m) return [{ file: rel, line: 1, what: "no BORN WITH: line: where does a NEW workspace get what this pass gives an old one?" }];
  const line = src.slice(0, m.index).split("\n").length;
  const ident = m[1]!;
  if (ident === "nothing") {
    if (!/^\s*\(\S/.test(m[2] ?? "")) return [{ file: rel, line, what: "BORN WITH: nothing needs its reason in parentheses: why can a fresh workspace not need this?" }];
    return [];
  }
  const name = ident.replace(/[^A-Za-z0-9_].*$/, "");
  if (!name) return [{ file: rel, line, what: `BORN WITH: names nothing readable ("${ident}")` }];
  if (!definedUnderSrc(name)) return [{ file: rel, line, what: `BORN WITH: ${name} is defined nowhere under api/src; name the real counterpart` }];
  return [];
}

const violations: Violation[] = [];
if (existsSync(INDEX)) {
  const passes = bootPasses(LINT_ROOT);
  const seen = new Set<string>();
  for (const p of passes) {
    if (seen.has(p.file)) continue;
    seen.add(p.file);
    if (!existsSync(p.file)) continue;
    violations.push(...checkPass(p.file, readFileSync(p.file, "utf8")));
  }
}

if (violations.length) {
  console.error(`lint:boot-pass-born-with - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error(
    "Add a BORN WITH: line to the file's header: the identifier of the per-workspace counterpart (defined under api/src), or nothing (<reason>) for a pass that only heals a shape a new workspace cannot have.",
  );
  process.exit(1);
}
console.log(`lint:boot-pass-born-with OK`);
