// The CI verdict cache (#4303): "if we didn't change it, don't retest it", made exact.
//
// A test file's verdict is keyed by a hash of every file it can observe, plus what every test
// runs under (the salt). A run whose key has a fresh pass in the store (the CI sink,
// ci-failure-sink/verdict-store.mjs) reuses it and does not run the file; the log says which run it
// came from. Everything else runs, and its passes are stored.
//
// WHAT A TEST CAN OBSERVE is the inverse of unit-affected-lib's "which tests can a change reach",
// built from the same rules, so the two cannot drift: the guard is a real-tree test that every file
// whose change selects a test is among that test's inputs
// (a-test-reuses-a-pass-only-while-nothing-it-reads-changed.test.ts).
//   IMPORTS  the forward closure of its imports (a workspace package: every file under it)
//   NAMES    a file its source names: path, extensionless path, or a distinct basename; a directory
//            it walks (every file under it, code too: 2026-10-27, a walk of modules/core-scan/src kept its
//            key through #8605's edit to a .ts in it, and a red reached main); and the non-code files
//            beside and below it
//   READS    the files and directories it reads by a path built from its own directory
//   LISTS    the files its listing patterns match
// and itself.
//
// NEVER REUSED (the hidden inputs), the file runs every time: one that reads the network, the CI
// environment or the repository's own git history, or that imports a file git does not track (a build
// output) or by a computed specifier its line does not name (`// imports: <spec>`). One that reads the
// clock without fake timers is reused only the UTC day it passed.
//
// Fail open everywhere: no store, a dirty tree, an error computing a key, and the file runs.

import { createHash } from "node:crypto";
import { matchesGlob } from "node:path";
import {
  ANY_TEST, CODE_EXT, GLOB_STRING, LISTS, PREFIX_REGEX, DISTINCT_BASENAME_MAX, TEST_LISTER,
  keyOf, parseSpecifiers, quoted, readsOf, resolveSpecifier, stripComments, walksDir,
} from "./unit-affected-lib.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");

/** Whether a test reads the clock without fake timers. Its pass is reused only the same UTC day (the day is
 *  in its key): a test whose answer moves with the date re-proves itself daily, and the uncached runs (the
 *  release's, the schedule's) run it every time. Until 2026-10-15 such a test was never reused: 114 files
 *  ran on every full run. */
export function readsClock(src) {
  const s = stripComments(src);
  return /\bDate\.now\(\)|new Date\(\)|performance\.now\(\)/.test(s) && !/useFakeTimers|setSystemTime/.test(s);
}

/** Why this test's verdict may never be reused, or null. Read from its own source. */
export function hiddenInput(src) {
  const s = stripComments(src);
  if (/\bfetch\(|node:https?["']|node:net["']|node:dgram|\bhttp\.request|new WebSocket\(/.test(s) && !/vi\.(stubGlobal|spyOn)\([^)]*fetch|globalThis\.fetch\s*=/.test(s)) return "reaches the network";
  if (/process\.env\.(GITHUB_|RUNNER_|CI\b)|process\.env\[["'](GITHUB_|RUNNER_|CI["'])/.test(s)) return "reads the CI environment";
  if (/\bgit\b[^\n]{0,80}(origin\/main|rev-parse|ls-files|merge-base|\blog\b|\bdiff\b)/.test(s) && !/mkdtemp|tmpdir\(/.test(s)) return "reads the repository's git history";
  return null;
}

/** Build outputs git does not track, by path prefix, and what each is built from. The nesting solver
 *  (nesting/pkg/, built from the crate by scripts/build-nesting.sh, cached by scripts/ci/nesting-cache.sh
 *  on its pins) is loaded by the nesting worker, which 117 unit tests reach: before this, none of them
 *  could reuse a pass (2026-10-15). */
export const BUILT_FROM = [
  ["modules/digifab/nesting/pkg/", ["modules/digifab/nesting/", "scripts/build-nesting.sh", "scripts/ci/nesting-cache.sh"]],
];

/**
 * An index of the tracked tree, built once per run.
 * @param {string[]} files every tracked path
 */
export function treeIndex(files) {
  const byKey = new Map();
  const byBase = new Map();
  const add = (m, k, v) => (m.get(k) ?? m.set(k, []).get(k)).push(v);
  const dirs = new Set();
  for (const f of files) {
    add(byKey, f, f);
    if (CODE_EXT.test(f)) add(byKey, keyOf(f), f);
    const base = f.slice(f.lastIndexOf("/") + 1);
    add(byBase, base, f);
    if (CODE_EXT.test(base)) add(byBase, keyOf(base), f);
    for (let i = f.indexOf("/"); i > 0; i = f.indexOf("/", i + 1)) dirs.add(f.slice(0, i));
  }
  const under = new Map();
  const filesUnder = (dir) => {
    let hit = under.get(dir);
    if (!hit) under.set(dir, (hit = files.filter((f) => f.startsWith(`${dir}/`))));
    return hit;
  };
  return { files, byKey, byBase, dirs, filesUnder };
}

/**
 * Every tracked file this test can observe, or why it can never be reused.
 * @param {{ test: string, sources: Map<string, string>, packages: Map<string, string>, tree: ReturnType<typeof treeIndex> }} a
 * @returns {{ inputs: Set<string>, hidden: string | null }}
 */
const PARSED = new WeakMap();
/**
 * Every tracked file a module's import closure reaches (a workspace package: every file under it; a
 * directory URL: every file under it), or why it cannot be told.
 * @returns {{ files: Set<string>, hidden: string | null }}
 */
export function importClosure({ start, sources, packages, tree }) {
  const inputs = new Set([start]);
  const seen = new Set();
  const queue = [start];
  while (queue.length) {
    const f = queue.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    if (!sources.has(f)) continue;
    const { specs, computed } = parsedOf(sources, f);
    if (computed) return { files: inputs, hidden: `${f} imports by a computed specifier` };
    for (const spec of specs) {
      const k = resolveSpecifier(f, spec, packages);
      if (!k) continue;
      if (k.startsWith("pkg:")) {
        for (const p of tree.filesUnder(k.slice(4))) {
          inputs.add(p);
          if (sources.has(p)) queue.push(p);
        }
        continue;
      }
      const hits = [...(tree.byKey.get(k) ?? []), ...(tree.byKey.get(`${k}/index`) ?? [])];
      // A directory (`new URL("../../bundles/", import.meta.url)`): every file under it.
      const dir = k.replace(/\/+$/, "");
      if (!hits.length && tree.dirs.has(dir)) {
        for (const p of tree.filesUnder(dir)) inputs.add(p);
        continue;
      }
      if (!hits.length) {
        // A build output whose sources are known: those sources, and how it is built, are its inputs.
        const built = BUILT_FROM.find(([out]) => k.startsWith(out));
        if (built) {
          for (const src of built[1]) for (const p of src.endsWith("/") ? tree.filesUnder(src.replace(/\/$/, "")) : [src]) inputs.add(p);
          continue;
        }
        if (spec.startsWith(".")) return { files: inputs, hidden: `${f} imports ${spec}, which git does not track (a build output?)` };
        continue;
      }
      for (const p of hits) {
        inputs.add(p);
        if (sources.has(p)) queue.push(p);
      }
    }
  }

  return { files: inputs, hidden: null };
}

/**
 * PURE. A source's dynamic imports by a computed specifier: whether any is left unnamed, and the targets
 * named for them. `import(existsSync(js) ? js : ts)` names its targets in a comment on its own line or the
 * line above, `// imports: ./laser-layout.ts`, and is then those files (2026-10-15: the nesting worker's one
 * such import kept 104 tests from ever reusing a pass). `(?` after `import (` is a regular expression's
 * group (personal-document.ts reads Python's `from cadquery import (?:…)`), not an import: 27 tests.
 */
export function dynamicImports(src) {
  const lines = String(src).split("\n");
  const named = [];
  let computed = false;
  for (let i = 0; i < lines.length; i++) {
    // The argument may start on the next line: `await import(\n  path\n)`.
    const code = `${lines[i].replace(/\/\/.*$/, "")} ${/\bimport\s*\(\s*$/.test(lines[i].replace(/\/\/.*$/, "")) ? (lines[i + 1] ?? "").trim() : ""}`;
    if (/^\s*(\*|\/\*)/.test(lines[i]) || !/\bimport\s*\(\s*[^"'\s)?]/.test(code)) continue;
    const note = /\/\/\s*imports:\s*(.+)$/.exec(lines[i]) ?? /^\s*\/\/\s*imports:\s*(.+)$/.exec(lines[i - 1] ?? "");
    if (!note) { computed = true; continue; }
    for (const t of note[1].split(",").map((x) => x.trim()).filter(Boolean)) named.push(t);
  }
  return { computed, named };
}

/** A source's specifiers and whether it imports by a computed one, read once per run. */
function parsedOf(sources, f) {
  let per = PARSED.get(sources);
  if (!per) PARSED.set(sources, (per = new Map()));
  let hit = per.get(f);
  if (!hit) {
    const src = sources.get(f) ?? "";
    const { computed, named } = dynamicImports(src);
    per.set(f, (hit = { specs: [...parseSpecifiers(src), ...named], computed }));
  }
  return hit;
}

export function unitTestInputs({ test, sources, packages, tree }) {
  const inputs = new Set([test]);
  const src = sources.get(test) ?? "";
  const hidden0 = hiddenInput(src);
  if (hidden0) return { inputs, hidden: hidden0 };
  const clock = readsClock(src);

  // IMPORTS
  const closure = importClosure({ start: test, sources, packages, tree });
  if (closure.hidden) return { inputs, hidden: closure.hidden, clock };
  for (const p of closure.files) inputs.add(p);

  // NAMES (the test's own source, comments stripped, as namedBy reads it)
  const s = stripComments(src);
  const prefixes = new Set();
  for (const tok of new Set(s.match(/[\w.@+-]+/g) ?? [])) for (let i = 1; i <= tok.length; i++) prefixes.add(tok.slice(0, i));
  for (const pre of prefixes) {
    for (const p of tree.byBase.get(pre) ?? []) {
      const base = p.slice(p.lastIndexOf("/") + 1);
      const distinct = (tree.byBase.get(base)?.length ?? 0) <= DISTINCT_BASENAME_MAX;
      if (s.includes(p) || s.includes(keyOf(p) + '"') || (distinct && quoted(s, base))) inputs.add(p);
    }
  }
  for (const m of s.matchAll(/["'`]([\w./@+-]+?)\/?(?:\*\*?[^"'`]*)?["'`]/g)) {
    const dir = m[1];
    if (tree.dirs.has(dir) && walksDir(s, dir)) for (const p of tree.filesUnder(dir)) inputs.add(p);
  }
  const tDir = test.slice(0, test.lastIndexOf("/"));
  if (tDir.includes("/")) for (const p of tree.filesUnder(tDir)) if (!CODE_EXT.test(p)) inputs.add(p);

  // READS: a file or directory it reads by a path built from its own directory (#7412).
  for (const r of readsOf(test, src)) {
    if (tree.byKey.has(r)) inputs.add(r);
    if (tree.dirs.has(r)) for (const p of tree.filesUnder(r)) inputs.add(p);
  }

  // SCANS: a test that reaches the lister of test files reads every test file in the repo (#7434).
  if (closure.files.has(TEST_LISTER)) for (const p of tree.files) if (ANY_TEST.test(p)) inputs.add(p);

  // LISTS
  if (LISTS.test(s)) {
    for (const m of s.matchAll(PREFIX_REGEX)) {
      let re;
      try {
        re = new RegExp(`^${m[1]}`, m[2].replace("g", ""));
      } catch {
        continue;
      }
      for (const p of tree.files) if (re.test(p.slice(p.lastIndexOf("/") + 1))) inputs.add(p);
    }
    for (const m of s.matchAll(GLOB_STRING)) {
      if (!m[1].includes("/")) continue;
      for (const p of tree.files) if (matchesGlob(p, m[1])) inputs.add(p);
    }
  }
  return { inputs, hidden: null, clock };
}

/**
 * One key: the suite, the file, the salt, and every input with its content id.
 * @param {{ suite: string, name: string, salt: string, inputs: Iterable<string>, blobs: Map<string, string> }} a
 */
export function verdictKey({ suite, name, salt, inputs, blobs }) {
  const lines = [...inputs].sort().map((p) => `${p}\0${blobs.get(p) ?? "absent"}`);
  return sha(`${suite}\n${name}\n${salt}\n${lines.join("\n")}`);
}

/** A package.json with its version line taken out: every feature bumps one (lint:versions). */
export function withoutVersion(text) {
  try {
    const { version: _v, ...rest } = JSON.parse(text);
    return JSON.stringify(rest);
  } catch {
    return text;
  }
}

/** The `typecheck` job of ci.yml, where the unit suite runs: the rest of the workflow cannot change it. */
export function jobBlock(yml, job) {
  const lines = yml.split("\n");
  const start = lines.findIndex((l) => l === `  ${job}:`);
  if (start < 0) return yml;
  let end = start + 1;
  while (end < lines.length && !/^ {2}[\w-]+:\s*$/.test(lines[end])) end++;
  return lines.slice(start, end).join("\n");
}

/** The sink client. Fails open: any error is "no verdicts". */
export async function lookup(keys, { url = process.env.CI_SINK_URL || "http://workshop:8767", timeoutMs = 15_000 } = {}) {
  if (!keys.length) return {};
  try {
    const r = await fetch(`${url}/verdicts/lookup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ keys }), signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return {};
    return (await r.json()).hits ?? {};
  } catch {
    return {};
  }
}

/** Store passes. Never throws; says whether they were kept. */
export async function record(suite, entries, { url = process.env.CI_SINK_URL || "http://workshop:8767", run = process.env.GITHUB_RUN_NUMBER ?? "", sha: commit = process.env.GITHUB_SHA ?? "", timeoutMs = 15_000 } = {}) {
  if (!entries.length) return true;
  try {
    // Batches under the sink's body limit (8 MB): a lint's manifest can be a few hundred KB.
    let batch = [];
    let size = 0;
    const send = async () => {
      if (!batch.length) return true;
      const r = await fetch(`${url}/verdicts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ suite, run, sha: commit, entries: batch }), signal: AbortSignal.timeout(timeoutMs) });
      batch = [];
      size = 0;
      return r.ok;
    };
    let ok = true;
    for (const e of entries) {
      const n = JSON.stringify(e).length;
      if (batch.length && (size + n > 3_000_000 || batch.length >= 4_000)) ok = (await send()) && ok;
      batch.push(e);
      size += n;
    }
    return (await send()) && ok;
  } catch {
    return false;
  }
}

/** An uncached run's shadow misses: passes the cache would have reused for files that failed. Never throws. */
export async function recordShadow(suite, misses, { url = process.env.CI_SINK_URL || "http://workshop:8767", run = process.env.GITHUB_RUN_NUMBER ?? "", sha: commit = process.env.GITHUB_SHA ?? "" } = {}) {
  try {
    const r = await fetch(`${url}/verdicts/shadow`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ suite, run, sha: commit, misses }), signal: AbortSignal.timeout(15_000) });
    return r.ok;
  } catch {
    return false;
  }
}
