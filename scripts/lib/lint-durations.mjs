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
// Everything that reads or writes a quiet time goes through here, so the
// shape cannot drift: run-lints.mjs (--record and the budget), the CI-clock
// recorder, the lint that checks coverage, and new-lint.sh via the recorder.
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DURATIONS_DIR = join(ROOT, "scripts", "lint-durations");

/** The file a lint's time lives in. `name` may carry the `lint:` prefix. */
export function durationPath(name) {
  return join(DURATIONS_DIR, `${String(name).replace(/^lint:/, "")}.json`);
}

/** The only keys a durations file carries. Anything else, above all a
 *  second lint's name, is refused rather than read: the old map grew two
 *  lint entries at its top level beside `ms` (2026-09-22), where the budget
 *  never looked, so a hand-added time sat there reading as recorded. */
export const FILE_KEYS = ["lint", "ms", "recorded", "source"];

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
  if (extra.length) return { name: expected, problem: `${file} carries ${extra.map((k) => JSON.stringify(k)).join(", ")}; a file holds one lint's time and only ${FILE_KEYS.join("/")}` };
  if (d.lint !== expected) return { name: expected, problem: `${file} says it is ${JSON.stringify(d.lint)}; its filename says ${expected}` };
  if (!Number.isFinite(d.ms) || d.ms <= 0) return { name: expected, problem: `${file} has ms ${JSON.stringify(d.ms)}, which is not a time` };
  return { name: expected, ms: d.ms };
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

/** Which lints have a file at all (whatever it holds). */
export function recordedNames() {
  return new Set(Object.keys(readQuietMs()));
}

/** Write one lint's time. `source` says where the number came from, because a
 *  hand-taken number on a busy box and a CI measurement are not the same
 *  claim and the next reader has to be able to tell. */
export function writeQuietMs(name, ms, source, recorded = new Date().toISOString().slice(0, 10)) {
  // A baseline that is not a number is not a baseline, and writing one would
  // be the same silent nothing this file exists to end: the budget would read
  // the file, find no usable time, and judge the lint at the median anyway.
  if (!Number.isFinite(ms) || ms <= 0) throw new Error(`lint-durations: ${name} was given ${ms} ms, which is not a time`);
  mkdirSync(DURATIONS_DIR, { recursive: true });
  const lint = String(name).startsWith("lint:") ? String(name) : `lint:${name}`;
  const doc = { lint, ms: Math.round(ms), recorded, source };
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
