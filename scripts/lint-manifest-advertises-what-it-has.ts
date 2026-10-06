#!/usr/bin/env tsx
// A module manifest advertises only what something stands behind: no intents and no exposes.api names, both retired because nothing ever handled or resolved one.
//
// THE BUG THIS PREVENTS. 14 modules declared 30 intents and 15 listed exposes.api names; nothing read either but a listing route (2026-09-30)
//
// THE RULE. A first-party module manifest (modules/*/src/module.ts) carries no
// `intents` key and no `api` list under `exposes`. Both are still accepted by
// defineModule, so an old third-party manifest loads; neither is read by
// anything but the module listing, so a name in either promises a door that
// is not there. What the assistant should be able to do is an action
// (`exposes.actions`), which is handled, pinned and offered.
//
// THE BOUNDARY. The module's own `api: () => import(...)` (its HTTP router)
// sits at the manifest's top level and is not `exposes.api`, so only an
// `api:` array inside the `exposes` block counts. An EMPTY intents or api
// list is refused too: it restates a retired field and invites the next
// person to fill it.
//
// And every name in `exposes.events` has an emitter: the name appears as a
// whole string literal somewhere in module or api source other than the
// manifest itself. A declared event is a "when this happens" trigger in the
// wire editor; one nothing emits is a wire that silently never fires. Emit
// with the literal name (`cond ? "x.a" : "x.b"`, never a template), so this
// can see it.
//
// PROVED RED on the 45 manifests that carried intents or exposes.api, and on
// the 13 declared events nothing emitted, before either was fixed.
//
//   npx tsx scripts/lint-manifest-advertises-what-it-has.ts   (pnpm lint manifest-advertises-what-it-has)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

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
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  if (!/modules\/[^/]+\/src\/module\.ts$/.test(file)) return [];
  const out: Violation[] = [];
  const lines = src.split("\n");
  let inExposes = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^  intents\s*:/.test(line)) out.push({ file, line: i + 1, what: "an intents list (retired: nothing handles an intent; make it an action)" });
    if (/^  exposes\s*:/.test(line)) inExposes = true;
    else if (/^  [a-zA-Z]/.test(line)) inExposes = false;
    if (inExposes && /^    api\s*:/.test(line)) out.push({ file, line: i + 1, what: "an exposes.api list (retired: nothing resolves these names)" });
  }
  return out;
}

/** Every source file an event could be emitted from, read once. */
function* sourceFiles(): Generator<string> {
  for (const root of ["modules", "api/src", "packages"]) yield* walk(root);
}
const sources = new Map<string, string>();
for (const f of sourceFiles()) sources.set(f, readFileSync(f, "utf8"));

/** The names in a manifest's `exposes.events`, with their lines. */
function declaredEvents(src: string): Array<{ name: string; line: number }> {
  const lines = src.split("\n");
  const out: Array<{ name: string; line: number }> = [];
  let inExposes = false;
  let inEvents = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^  exposes\s*:/.test(line)) inExposes = true;
    else if (/^  [a-zA-Z]/.test(line)) inExposes = false;
    if (inExposes && /^    events\s*:\s*\[/.test(line)) inEvents = !/\]/.test(line.slice(line.indexOf("[")));
    else if (inEvents && /^    \]/.test(line)) inEvents = false;
    else if (inEvents && !/^\s*\/\//.test(line)) {
      for (const m of line.matchAll(/"([^"]+)"/g)) out.push({ name: m[1]!, line: i + 1 });
    }
  }
  return out;
}

function emitted(name: string, manifest: string): boolean {
  for (const [f, t] of sources) {
    if (f === manifest || /\.test\.tsx?$/.test(f)) continue;
    if (t.includes(`"${name}"`) || t.includes(`'${name}'`) || t.includes(`\`${name}\``)) return true;
  }
  return false;
}

const violations: Violation[] = [];
const allDeclared = new Set<string>();
for (const [file, src] of sources) {
  if (!/^modules\/[^/]+\/src\/module\.ts$/.test(file)) continue;
  for (const ev of declaredEvents(src)) {
    allDeclared.add(ev.name);
    if (!emitted(ev.name, file)) violations.push({ file, line: ev.line, what: `declares the event "${ev.name}", which nothing emits (a wire on it would never fire): emit it where it happens, by its literal name, or remove it` });
  }
}
// A default wire a module contributes waits for an event: one no module
// declares is a wire born silent (the wires page would flag it, and the
// route would refuse a person the same wire).
for (const [file, src] of sources) {
  if (!/^modules\/[^/]+\/src\/module\.ts$/.test(file)) continue;
  src.split("\n").forEach((line, i) => {
    const m = line.match(/trigger_event:\s*"([^"]+)"/);
    if (m && !allDeclared.has(m[1]!)) violations.push({ file, line: i + 1, what: `a default wire waits for "${m[1]}", which no module declares, so it would never run` });
  });
}
for (const [file, src] of sources) violations.push(...check(file, src));

if (violations.length) {
  console.error(`lint:manifest-advertises-what-it-has - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:manifest-advertises-what-it-has OK`);
