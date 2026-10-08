// A lint's recorded quiet time lives in its OWN file.
//
// It used to be one keyed map, `scripts/lint-durations.json`, that every
// parallel branch appended to. Two branches adding two lints therefore
// conflicted in that file, and both sides of such a conflict are individually
// correct: taking either one silently drops the other's entry. That happened
// on 2026-09-22, `lint:all` passed, CI passed, and the loss would only have
// surfaced later as a budget failure on a lint nobody had touched.
//
// The map also needed a pressure valve (`lint:lint-durations` tolerated five
// unrecorded lints) so that a branch adding a lint was not blocked by a branch
// that had not recorded one. A valve is what made the drop invisible, and it
// fills: it was at five on 2026-09-22, which is a gate on whoever adds the
// sixth lint, for nothing they did.
//
// One file per lint removes both. Two branches adding two lints add two files
// and never conflict, so the drop is impossible rather than detectable and the
// valve has nothing to absorb. `scripts/lint-durations/<name>.json`, where
// `<name>` is the lint's script key without the `lint:` prefix:
//
//   { "lint": "lint:one-day-rule", "ms": 2220,
//     "recorded": "2026-09-22", "source": "CI typecheck run 24927" }
//
// THE FILE IS ALSO THE LINT'S REGISTRATION (#3455). A lint used to need a
// `lint:<name>` line in package.json and a claim appended to a row's array in
// scripts/placement-registry.ts as well, so two branches adding two lints
// still conflicted in both, by construction. Now the record says it all:
//
//   { "lint": "lint:one-day-rule", "run": "node scripts/lint-one-day-rule.ts",
//     "rows": ["dev-script"], "ms": 2220, "recorded": "…", "source": "…" }
//
//   run     the command that runs it (required: a record with no command is a
//           time for a lint that does not run)
//   rows    placement rows that claim it, beside the arrays in the registry
//   manual  why run-lints.mjs does NOT run it (a reason, never "not yet")
//   tsx     why it runs under tsx rather than `node` (lib/lint-command.mjs):
//           ~1.3 s of startup against ~0.1 s, so a lint pays it only for a
//           reason, such as an import that uses a parameter property
//
// A new lint is therefore two new files, its script and this record, and
// nothing shared: two branches adding two lints cannot conflict anywhere.
//
// Everything that reads or writes a quiet time goes through here, so the
// shape cannot drift: run-lints.mjs (--record and the budget), the CI-clock
// recorder, the lint that checks coverage, and new-lint.sh via the recorder.
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DURATIONS_DIR = join(ROOT, "scripts", "lint-durations");

/** The file a lint's time lives in. `name` may carry the `lint:` prefix. */
export function durationPath(name, dir = DURATIONS_DIR) {
  return join(dir, `${String(name).replace(/^lint:/, "")}.json`);
}

/** The only keys a durations file carries. Anything else, above all a
 *  second lint's name, is refused rather than read: the old map grew two
 *  lint entries at its top level beside `ms` (2026-09-22), where the budget
 *  never looked, so a hand-added time sat there reading as recorded. */
export const FILE_KEYS = ["lint", "run", "rows", "manual", "tsx", "ms", "readMB", "recorded", "source", "paths"];

/** The map this directory replaced. It must not come back beside it. */
export const LEGACY_MAP = join(ROOT, "scripts", "lint-durations.json");

/** Parse one file and say what is wrong with it, if anything. A file is
 *  read ONLY as the lint its own filename names. */
function readOne(dir, file) {
  const expected = `lint:${file.slice(0, -5)}`;
  let d;
  try {
    d = JSON.parse(readFileSync(join(dir, file), "utf8"));
  } catch (e) {
    return { name: expected, problem: `${file} is not JSON (${e.message})` };
  }
  if (!d || typeof d !== "object" || Array.isArray(d)) return { name: expected, problem: `${file} is not an object` };
  const extra = Object.keys(d).filter((k) => !FILE_KEYS.includes(k));
  if (extra.length) return { name: expected, problem: `${file} carries ${extra.map((k) => JSON.stringify(k)).join(", ")}; a file holds one lint's record and only ${FILE_KEYS.join("/")}` };
  if (d.lint !== expected) return { name: expected, problem: `${file} says it is ${JSON.stringify(d.lint)}; its filename says ${expected}` };
  // A manual lint is never run by the runner, so it has no time to record.
  if (!(d.manual !== undefined && d.ms === undefined) && (!Number.isFinite(d.ms) || d.ms <= 0)) return { name: expected, problem: `${file} has ms ${JSON.stringify(d.ms)}, which is not a time` };
  if (typeof d.run !== "string" || !d.run.trim()) return { name: expected, problem: `${file} has no "run": a time for a lint with no command is a lint that never runs` };
  if (d.rows !== undefined && !(Array.isArray(d.rows) && d.rows.every((r) => typeof r === "string" && r))) return { name: expected, problem: `${file} has "rows" that is not a list of row ids` };
  if (d.manual !== undefined && !(typeof d.manual === "string" && d.manual.trim().length >= 20)) return { name: expected, problem: `${file} has "manual" without a reason (a sentence saying why the runner skips it)` };
  const onTsx = /^tsx\s+\S+\.ts(\s|$)/.test(d.run);
  if (onTsx && !(typeof d.tsx === "string" && d.tsx.trim().length >= 20)) return { name: expected, problem: `${file} runs under tsx with no "tsx" reason; run it as \`node ${d.run.replace(/^tsx\s+/, "")}\` (Node strips the types, ~0.1 s to start against ~1.3 s), or say why it needs tsx` };
  if (!onTsx && d.tsx !== undefined) return { name: expected, problem: `${file} gives a "tsx" reason but does not run under tsx` };
  if (d.readMB !== undefined && !(Number.isFinite(d.readMB) && d.readMB >= 0)) return { name: expected, problem: `${file} has readMB ${JSON.stringify(d.readMB)}, which is not a size` };
  // A lint with a fast path and a full fallback has a quiet time per path ("paths": {"full": 14000}); it says
  // which it took with a `[lint-path] <name>` line, and is judged against that path's time.
  if (d.paths !== undefined && !(d.paths && typeof d.paths === "object" && !Array.isArray(d.paths) && Object.values(d.paths).every((v) => Number.isFinite(v) && v > 0)))
    return { name: expected, problem: `${file} has "paths" that is not an object of path name to a time` };
  return { name: expected, ...(d.ms !== undefined ? { ms: d.ms } : {}), ...(d.readMB !== undefined ? { readMB: d.readMB } : {}), ...(d.paths ? { paths: d.paths } : {}), run: d.run, rows: d.rows ?? [], manual: d.manual };
}

/** Every registered lint, from its record: `{ name, run, rows, manual }`.
 *  The one list of lints; package.json no longer carries one. */
export function readRegistry(dir = DURATIONS_DIR) {
  const out = [];
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const file of names.sort()) {
    if (!file.endsWith(".json")) continue;
    const r = readOne(dir, file);
    if (r.run) out.push({ name: r.name, run: r.run, rows: r.rows, manual: r.manual });
  }
  return out;
}

/** Every recorded time, as the budget wants it: `{ "lint:x": 123 }`. A file
 *  that is missing, unreadable or the wrong shape is simply not a baseline
 *  (auditDurations says why); the budget already knows what to do with a
 *  lint it has never heard of. */
export function readQuietMs(dir = DURATIONS_DIR) {
  const out = {};
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const file of names) {
    if (!file.endsWith(".json")) continue;
    const r = readOne(dir, file);
    if (r.ms !== undefined) out[r.name] = r.ms;
  }
  return out;
}

/** Each lint's quiet time per path, for the lints that have more than one: `{ name: { path: ms } }`. */
export function readPathMs(dir = DURATIONS_DIR) {
  const out = {};
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const file of names) {
    if (!file.endsWith(".json")) continue;
    const r = readOne(dir, file);
    if (r.paths) out[r.name] = r.paths;
  }
  return out;
}

/** What is wrong with the directory as a whole, for lint:lint-durations:
 *  every file that is not exactly one lint's time under its own name, and the
 *  old map if it has reappeared. */
export function auditDurations(dir = DURATIONS_DIR, legacy = LEGACY_MAP) {
  const problems = [];
  if (existsSync(legacy)) problems.push(`${relative(ROOT, legacy)} is back; times live one per file in scripts/lint-durations/ (move each entry there, then delete it)`);
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return problems;
  }
  for (const file of names) {
    if (file === "README.md") continue;
    if (!file.endsWith(".json")) {
      problems.push(`${file} is not a durations file`);
      continue;
    }
    const r = readOne(dir, file);
    if (r.problem) problems.push(r.problem);
  }
  return problems;
}

/** The mark a scaffolded estimate carries. A dev box is shared and loaded, so
 *  its timing is a placeholder that keeps the lint out of "never heard of";
 *  the first CI measurement replaces it (lint-durations-record-missing.mjs). */
export const PROVISIONAL = "scaffolded by new-lint.sh";

/** Is this lint's recorded time still the scaffold's guess? */
export function isProvisional(name) {
  try {
    const d = JSON.parse(readFileSync(durationPath(name), "utf8"));
    return typeof d.source === "string" && d.source.startsWith(PROVISIONAL);
  } catch {
    return false;
  }
}

/** Every recorded read volume, `{ "lint:x": 26.4 }` in MB (lib/lint-reads.cjs). */
export function readRecordedReadMB(dir = DURATIONS_DIR) {
  const out = {};
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const file of names) {
    if (!file.endsWith(".json")) continue;
    const r = readOne(dir, file);
    if (r.readMB !== undefined) out[r.name] = r.readMB;
  }
  return out;
}

/** Which lints have a file at all (whatever it holds). */
export function recordedNames() {
  return new Set(Object.keys(readQuietMs()));
}

/** Write one lint's time. `source` says where the number came from, because a
 *  hand-taken number on a busy box and a CI measurement are not the same
 *  claim and the next reader has to be able to tell. */
export function writeQuietMs(name, ms, source, recorded = new Date().toISOString().slice(0, 10), dir = DURATIONS_DIR, readMB = undefined) {
  // A baseline that is not a number is not a baseline, and writing one would
  // be the same silent nothing this file exists to end: the budget would read
  // the file, find no usable time, and judge the lint at the median anyway.
  if (!Number.isFinite(ms) || ms <= 0) throw new Error(`lint-durations: ${name} was given ${ms} ms, which is not a time`);
  mkdirSync(dir, { recursive: true });
  const lint = String(name).startsWith("lint:") ? String(name) : `lint:${name}`;
  // A time is re-recorded far more often than a lint is registered, and the
  // registration must survive it: read what the file says and keep it.
  let prior = {};
  try {
    prior = JSON.parse(readFileSync(durationPath(lint, dir), "utf8"));
  } catch {
    prior = {};
  }
  if (typeof prior.run !== "string" || !prior.run.trim()) throw new Error(`lint-durations: ${lint} has no registration to record a time against (scripts/new-lint.sh registers a lint)`);
  const reads = readMB !== undefined ? Math.round(readMB * 10) / 10 : prior.readMB;
  const doc = { lint, run: prior.run, ...(prior.rows ? { rows: prior.rows } : {}), ...(prior.manual ? { manual: prior.manual } : {}), ms: Math.round(ms), ...(reads !== undefined ? { readMB: reads } : {}), recorded, source };
  writeFileSync(durationPath(lint, dir), `${JSON.stringify(doc, null, 2)}\n`);
  return durationPath(lint, dir);
}

/** Register a new lint: its command, the rows that claim it, and a first
 *  time (the scaffold's estimate). Refuses a name that already has a record. */
export function registerLint(name, { run, rows = [], manual }, ms, source, recorded = new Date().toISOString().slice(0, 10)) {
  const lint = String(name).startsWith("lint:") ? String(name) : `lint:${name}`;
  if (existsSync(durationPath(lint))) throw new Error(`lint-durations: ${lint} is already registered (${relative(ROOT, durationPath(lint))})`);
  if (!Number.isFinite(ms) || ms <= 0) throw new Error(`lint-durations: ${lint} was given ${ms} ms, which is not a time`);
  mkdirSync(DURATIONS_DIR, { recursive: true });
  const doc = { lint, run, ...(rows.length ? { rows } : {}), ...(manual ? { manual } : {}), ms: Math.round(ms), recorded, source };
  writeFileSync(durationPath(lint), `${JSON.stringify(doc, null, 2)}\n`);
  return durationPath(lint);
}

/** Remove a lint's file: it no longer runs. */
export function forgetQuietMs(name) {
  const p = durationPath(name);
  if (!existsSync(p)) return false;
  unlinkSync(p);
  return true;
}
