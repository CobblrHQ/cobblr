#!/usr/bin/env tsx
// A heal, reconcile or backfill boot pass registers itself in api/src/platform/boot/, never as an import and a call in api/src/index.ts, so two PRs adding passes never edit one file.
//
// THE BUG THIS PREVENTS. api/src/index.ts (2,343 lines) was in 6 of a week's
// 224 merge re-checks (#7387): every heal, shim and boot pass was imported
// and called by name in boot(), so any two PRs adding one touched the same
// import block and the same run of calls, and the merge queue sent the green
// one back to re-run.
//
// THE RULE. api/src/index.ts imports nothing from a pass file:
// ./platform/heal-*, ./platform/*reconcile*, ./platform/backfill-*,
// ./platform/repair-*, ./platform/retire-* or ./platform/migrate-*. A pass is
// a file in api/src/platform/boot/ that default-exports bootPass({ name,
// phase, run }) (api/src/platform/boot-passes.ts), and boot() runs each phase
// with runBootPhase. Each descriptor is checked here the way the boot would
// refuse it: a readable name and run, a phase boot() runs, a name no other
// pass has, and an `after` that names a pass of the same phase.
//
// THE BOUNDARY. heal-shim-log.ts is the health seam's implementation, not a
// pass, and index.ts wires it into platform().health; it is the one import
// the patterns would catch that is allowed. A pass file whose name matches no
// pattern (integration-nav.ts, seed-bindings.ts) is not caught by the import
// rule; it moved to the registry with the rest, and nothing but review stops
// a new one being called from boot() by hand.
//
//   npx tsx scripts/lint-boot-passes-register-themselves.ts   (pnpm lint boot-passes-register-themselves)
import { readFileSync, readdirSync } from "node:fs";
import { relative } from "node:path";
import { bootPassRefs } from "./lib/boot-passes.ts";

const INDEX = "api/src/index.ts";
const PASS_FILE = /^\.\/platform\/(heal-[^"/]+|[^"/]*reconcile[^"/]*|backfill-[^"/]+|repair-[^"/]+|retire-[^"/]+|migrate-[^"/]+)\.js$/;
const NOT_A_PASS = new Set(["./platform/heal-shim-log.js"]);
const PHASES_FILE = "api/src/platform/boot-passes.ts";

interface Violation {
  file: string;
  line: number;
  what: string;
}

/** Imports of a pass file in index.ts. Pure. */
export function passImports(src: string): Violation[] {
  const out: Violation[] = [];
  for (const m of src.matchAll(/^import\s[^;]*?from\s+"([^"]+)";/gms)) {
    const spec = m[1]!;
    if (!PASS_FILE.test(spec) || NOT_A_PASS.has(spec)) continue;
    const line = src.slice(0, m.index).split("\n").length;
    out.push({ file: INDEX, line, what: `imports ${spec}: register the pass as a file in api/src/platform/boot/ (a bootPass({ name, phase, run })) instead` });
  }
  return out;
}

const phases = [...readFileSync(PHASES_FILE, "utf8").matchAll(/^\s+"([a-z-]+)",$/gm)].map((m) => m[1]!);
const index = readFileSync(INDEX, "utf8");
const violations = passImports(index);
const run = new Set([...index.matchAll(/runBootPhase\("([a-z-]+)"/g)].map((m) => m[1]!));
const refs = bootPassRefs(".").filter((p) => p.descriptor);
const byName = new Map<string, string>();
for (const p of refs) {
  const file = relative(".", p.descriptor!);
  if (!p.phase || !phases.includes(p.phase)) violations.push({ file, line: 1, what: `phase "${p.phase}" is not one of ${PHASES_FILE}'s BOOT_PHASES` });
  else if (!run.has(p.phase)) violations.push({ file, line: 1, what: `boot() never runs the "${p.phase}" phase` });
  if (!p.file) violations.push({ file, line: 1, what: `run calls ${p.fn}, which is not imported from a file beside the pass` });
  const twin = byName.get(p.label);
  if (twin) violations.push({ file, line: 1, what: `named ${p.label}, like ${twin}` });
  byName.set(p.label, file);
}
const ofPhase = new Map(refs.map((p) => [p.label, p.phase]));
for (const p of refs)
  for (const m of readFileSync(p.descriptor!, "utf8").match(/\bafter:\s*\[([^\]]*)\]/)?.[1]?.matchAll(/"([^"]+)"/g) ?? [])
    if (ofPhase.get(m[1]!) !== p.phase) violations.push({ file: relative(".", p.descriptor!), line: 1, what: `runs after ${m[1]}, which is not a ${p.phase} pass` });
const unread = readdirSync("api/src/platform/boot").filter((f) => f.endsWith(".ts") && !/\.(test|d)\.ts$/.test(f) && !refs.some((p) => p.descriptor!.endsWith(`/${f}`)));
for (const f of unread) violations.push({ file: `api/src/platform/boot/${f}`, line: 1, what: "is not a bootPass({ name, phase, run: () => fn() }) the registry can read" });

if (violations.length) {
  console.error(`lint:boot-passes-register-themselves - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("A boot pass is one file in api/src/platform/boot/, so two PRs adding passes never edit api/src/index.ts (#7387).");
  process.exit(1);
}
console.log(`lint:boot-passes-register-themselves OK (${refs.length} registered passes)`);
