// Which unit test files can a change reach? Pure functions; scripts/unit-affected.mjs
// feeds them git and the file system.
//
// The unit suites (scripts/run-unit-tests.mjs: every *.test.ts under modules/,
// packages/, web/ and scripts/, about a thousand files) ran whole on every pull
// request, 5.4 of the typecheck job's 9.8 minutes, whatever the change
// (#4303). A pull request now runs the files its change can reach; every push
// to main still runs all of them, so a miss here is found on the merge, never
// shipped.
//
// A test is reached when either
//   IMPORTS  its import closure holds a changed file (relative specifiers,
//            dynamic import, require, vi.mock, new URL(…, import.meta.url), and a
//            workspace package by name, which counts as every file under that
//            package's directory), or
//   NAMES    its source names a changed file: the repo path, or the basename when
//            no more than a few files in the repo share it (a test that spawns
//            scripts/lib/push-defer.sh, a lint test that runs its lint). A
//            changed file that is not code also reaches the tests that name one
//            of its directories ("bundles/", "migrations/"), and the tests in its
//            own directory or above it (a fixture a test reads with readdirSync).
//   READS    it reads a file by a path built from its own directory: `join(import.meta.dirname, "../index.ts")`,
//            `resolve(__dirname, "..", "x.json")`. A source-reading safety check names its file by a relative
//            path, which the NAMES rule cannot match when the basename is common (index.ts), so a pull request
//            that moved api/src/index.ts's boot passes merged without running the one test that read that file
//            for them, and turned main red (#7412, 2026-10-19). A read of a directory reaches every change under it.
//   LISTS    it lists a directory (readdirSync, globSync) and filters it by a
//            pattern the changed file matches: a regex with a literal prefix
//            (`/^lint-.*\.ts$/`) against its name, or a glob string
//            (`"modules/x/src/**/*.ts"`) against its path. These are the
//            "every lint obeys X" tests: they name no file, so neither rule
//            above reaches them, and a pull request adding a lint that broke
//            one merged green and turned main red (#4614, 2026-10-02).
//   SCANS    it reaches the repo's lister of test files (TEST_LISTER) through its imports, and any test file changed:
//            it indexes every test in the repo (where-test ranks them by their words), so one more test anywhere can
//            change its answer. #7434 added a test whose words outranked build-gate.test.ts in where-test's
//            real-repo control; main's affected run never chose where-test.test.ts, and main read green over a
//            red (2026-10-19).
// and a changed test file always runs itself.
//
// FULL on any doubt: no base to diff against, a change to anything the runner or
// vitest itself loads (computed from their own import closure, so a new setup
// file cannot be missed), a package manifest, a lockfile, a tsconfig.

import { matchesGlob } from "node:path";
import { stripComments } from "./source-scan.ts";

// A test citing a design doc in its header comment does not read it, so the
// naming rule reads the source with its comments stripped (the one scanner).
export { stripComments };

export const CODE_EXT = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/** Paths whose change can alter how every unit test runs. */
export const FULL_PATHS = [
  /(^|\/)package\.json$/,
  /^pnpm-(lock|workspace)\.yaml$/,
  /^\.npmrc$/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)vitest\.config\.[^/]+$/,
  /^\.forgejo\/workflows\/ci\.yml$/,
];

/** The files whose import closure is the runner itself: a change there is FULL. */
export const RUNNER_ROOTS = [
  "vitest.config.ts",
  "scripts/lib/vitest-setup.mjs",
  "scripts/run-unit-tests.mjs",
  "scripts/unit-affected.mjs",
  "scripts/lib/unit-affected-lib.mjs",
  "scripts/ensure-packages-built.mjs",
];

/** A basename this common names too many files to say which one a test means. */
export const DISTINCT_BASENAME_MAX = 3;

/** repo path → the key an import of it resolves to (extension off, index folded). */
export function keyOf(path) {
  return path.replace(CODE_EXT, "");
}

function posixJoin(dir, spec) {
  const parts = dir ? dir.split("/") : [];
  for (const seg of spec.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

/** Every module specifier a source file names. */
export function parseSpecifiers(src) {
  const out = new Set();
  const re =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\bvi\.(?:mock|doMock|importActual)\s*\(\s*|new\s+URL\s*\(\s*)(["'])([^"'\n]+)\1/g;
  for (const m of src.matchAll(re)) out.add(m[2]);
  return [...out];
}

/**
 * PURE. The file a package's `exports` names for a subpath ("." or "./money"), or null when it names none
 * this can read (conditions, arrays): the caller then depends on the whole package.
 * @param {unknown} exportsField the package.json `exports` (or its `main`, as a string)
 * @param {string} sub
 */
export function exportTarget(exportsField, sub) {
  const pick = (v) => (typeof v === "string" ? v : v && typeof v === "object" && !Array.isArray(v) ? pick(v.import ?? v.default ?? v.types) : null);
  if (typeof exportsField === "string") return sub === "." ? exportsField : null;
  if (!exportsField || typeof exportsField !== "object") return null;
  if (sub in exportsField) return pick(exportsField[sub]);
  for (const [k, v] of Object.entries(exportsField)) {
    const star = k.indexOf("*");
    if (star < 0) continue;
    const pre = k.slice(0, star), post = k.slice(star + 1);
    if (sub.startsWith(pre) && sub.endsWith(post) && sub.length >= pre.length + post.length) {
      const t = pick(v);
      if (t) return t.replace("*", sub.slice(pre.length, sub.length - post.length));
    }
  }
  return null;
}

/**
 * @param {string} file the importing file's repo path
 * @param {string} spec
 * @param {Map<string, string>} packages workspace package name → its directory
 * @param {Map<string, unknown>} [exportsByDir] package directory → its `exports` (or `main`): an import then
 *   depends on the file it resolves to, not on the whole package. A change to one platform-contract file used
 *   to select every unit test that imports the package at all: 1,531 of 2,368 for four paths (#6226).
 * @returns {string | null} a key: a file key, or `pkg:<dir>`; null for npm
 */
export function resolveSpecifier(file, spec, packages, exportsByDir) {
  if (spec.startsWith(".")) {
    const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
    return keyOf(posixJoin(dir, spec));
  }
  const m = /^(@[^/]+\/[^/]+|[^@/][^/]*)(\/.*)?$/.exec(spec);
  const dir = m && packages.get(m[1]);
  if (!dir) return null;
  const target = exportsByDir?.has(dir) ? exportTarget(exportsByDir.get(dir), m[2] ? `.${m[2]}` : ".") : null;
  return target && !target.includes("*") ? keyOf(posixJoin(dir, target)) : `pkg:${dir}`;
}

/**
 * The keys each file depends on.
 * @param {Map<string, string>} sources repo path → source
 * @param {Map<string, string>} packages
 * @returns {Map<string, Set<string>>}
 */
export function buildGraph(sources, packages, exportsByDir) {
  const graph = new Map();
  for (const [file, src] of sources) {
    const deps = new Set();
    for (const spec of parseSpecifiers(src)) {
      const k = resolveSpecifier(file, spec, packages, exportsByDir);
      if (k) {
        deps.add(k);
        // `./dir` and `./dir/index` are one module.
        if (!k.startsWith("pkg:")) deps.add(`${k}/index`);
      }
    }
    graph.set(file, deps);
  }
  return graph;
}

/** The keys a changed path is known by. */
export function keysOfChanged(path, packages, versionOnly = new Set()) {
  if (versionOnly.has(path)) return new Set([path]);
  const keys = new Set([path, keyOf(path)]);
  for (const dir of packages.values()) if (path.startsWith(`${dir}/`)) keys.add(`pkg:${dir}`);
  return keys;
}

const REVERSE = new WeakMap();
function reverseOf(graph) {
  let rev = REVERSE.get(graph);
  if (rev) return rev;
  rev = new Map();
  for (const [file, deps] of graph) for (const d of deps) (rev.get(d) ?? rev.set(d, []).get(d)).push(file);
  REVERSE.set(graph, rev);
  return rev;
}

/**
 * Every file whose import closure reaches one of `seeds` (a seed's own file
 * included when it is a source).
 * @param {Map<string, Set<string>>} graph
 * @param {Set<string>} seeds keys
 * @param {Map<string, string>} packages
 */
export function dependents(graph, seeds, packages) {
  const rev = reverseOf(graph);
  const reached = new Set();
  const seen = new Set();
  const queue = [...seeds];
  for (const k of seeds) if (graph.has(k)) reached.add(k);
  while (queue.length) {
    const k = queue.pop();
    if (seen.has(k)) continue;
    seen.add(k);
    for (const f of rev.get(k) ?? []) {
      if (reached.has(f)) continue;
      reached.add(f);
      for (const fk of keysOfChanged(f, packages)) queue.push(fk);
    }
  }
  return reached;
}

/** The files the runner itself loads; a change in any of them is FULL. */
export function runnerClosure(graph) {
  const out = new Set();
  const want = new Set(RUNNER_ROOTS.map(keyOf));
  let grew = true;
  while (grew) {
    grew = false;
    for (const [file, deps] of graph) {
      if (out.has(file) || !want.has(keyOf(file))) continue;
      out.add(file);
      for (const d of deps) if (!d.startsWith("pkg:")) want.add(d), want.add(d.replace(/\/index$/, ""));
      grew = true;
    }
  }
  return out;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The test names the directory itself ("docs", "docs/", "docs/**"), not a file inside it. */
export function walksDir(src, dir) {
  return new RegExp(`["'\`]${escapeRe(dir)}/?(?:\\*\\*?[^"'\`]*)?["'\`]`).test(src);
}

export function quoted(src, s) {
  return src.includes(`"${s}`) || src.includes(`'${s}`) || src.includes(`\`${s}`) || src.includes(`/${s}`);
}

/**
 * The tests a change NAMES rather than imports.
 * @param {string} path the changed path
 * @param {string[]} tests
 * @param {Map<string, string>} testSources
 * @param {Map<string, number>} basenameCount basename → how many repo files carry it
 */
export function namedBy(path, tests, testSources, basenameCount) {
  const out = new Set();
  const base = path.slice(path.lastIndexOf("/") + 1);
  const distinct = (basenameCount.get(base) ?? 0) <= DISTINCT_BASENAME_MAX;
  const code = CODE_EXT.test(path);
  const segs = path.split("/");
  const dirs = [];
  for (let i = 1; i < segs.length; i++) dirs.push(segs.slice(0, i).join("/"));
  const fileDir = dirs.at(-1) ?? "";
  for (const t of tests) {
    const src = stripComments(testSources.get(t) ?? "");
    if (src.includes(path) || src.includes(keyOf(path) + '"') || (distinct && quoted(src, base))) { out.add(t); continue; }
    if (code) continue;
    // Not code: a test that walks one of its directories, or sits beside or above it.
    if (dirs.some((d) => walksDir(src, d))) { out.add(t); continue; }
    const tDir = t.slice(0, t.lastIndexOf("/"));
    if (fileDir && (fileDir === tDir || fileDir.startsWith(`${tDir}/`)) && tDir.includes("/")) out.add(t);
  }
  return out;
}

// `join(` or `resolve(` with the test's own directory first, then string-literal segments.
const READ_CALL = /\b(?:join|resolve)\s*\(\s*(?:import\.meta\.dirname|__dirname)\s*((?:,\s*(["'`])[^"'`\n$]+\2\s*)+)\)/g;

/** PURE. The repo paths a test reads by a path built from its own directory (READS). */
export function readsOf(test, src) {
  const dir = test.slice(0, test.lastIndexOf("/"));
  const out = new Set();
  for (const m of stripComments(src).matchAll(READ_CALL)) {
    const segs = [...m[1].matchAll(/(["'`])([^"'`\n]+)\1/g)].map((x) => x[2]);
    const p = posixJoin(dir, segs.join("/"));
    if (p) out.add(p);
  }
  return out;
}

/**
 * The tests that READ the changed path, or a directory holding it.
 * @param {string} path
 * @param {string[]} tests
 * @param {Map<string, string>} testSources
 */
export function readBy(path, tests, testSources) {
  const out = new Set();
  for (const t of tests) {
    for (const r of readsOf(t, testSources.get(t) ?? "")) {
      if (r === path || path.startsWith(`${r}/`)) {
        out.add(t);
        break;
      }
    }
  }
  return out;
}

/** The module that lists every test file in the repo; a test reaching it reads the whole test tree (SCANS). */
export const TEST_LISTER = "scripts/lib/unit-test-files.mjs";
/** A test file of any suite: unit, api (`api/tests`) or e2e. */
export const ANY_TEST = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

export const LISTS = /\breaddirSync\s*\(|\breaddir\s*\(|\bglobSync\s*\(|\bglob\s*\(/;
// A regex literal with a real literal prefix: `/^lint-.*\.ts$/`, not `/^\d+$/`.
export const PREFIX_REGEX = /\/\^([A-Za-z][\w-]{2,}(?:[^/\n\\]|\\.)*)\/([dgimsuy]*)/g;
export const GLOB_STRING = /["'`]([\w./-]*\*[\w.*{},/-]*)["'`]/g;

/**
 * The tests that LIST files the changed path is one of.
 * @param {string} path
 * @param {string[]} tests
 * @param {Map<string, string>} testSources
 */
export function listedBy(path, tests, testSources) {
  const out = new Set();
  const base = path.slice(path.lastIndexOf("/") + 1);
  for (const t of tests) {
    const src = stripComments(testSources.get(t) ?? "");
    if (!LISTS.test(src)) continue;
    let hit = false;
    for (const m of src.matchAll(PREFIX_REGEX)) {
      try {
        if (new RegExp(`^${m[1]}`, m[2].replace("g", "")).test(base)) { hit = true; break; }
      } catch {
        /* not a regex after all: a path or a division */
      }
    }
    if (!hit) {
      for (const m of src.matchAll(GLOB_STRING)) {
        if (m[1].includes("/") && matchesGlob(path, m[1])) { hit = true; break; }
      }
    }
    if (hit) out.add(t);
  }
  return out;
}

/**
 * @param {{
 *   changed: string[] | null,      null = no base, cannot tell
 *   tests: string[],               every unit test file the runner discovered
 *   sources: Map<string, string>,  repo path → source, for every code file in the graph
 *   packages: Map<string, string>,
 *   basenameCount: Map<string, number>,
 *   versionOnly?: Set<string>,     package.json files whose diff is the version line alone
 *   graph?: Map<string, Set<string>>,  buildGraph(sources, packages), when the caller already has it
 *   exportsByDir?: Map<string, unknown>, each package's `exports`: imports resolve to files, not packages
 * }} input
 * @returns {{ kind: "full" | "affected", tests: string[], reason: string, why: Map<string, string> }}
 */
export function selectUnitTests({ changed, tests, sources, packages, basenameCount, versionOnly = new Set(), graph: prebuilt = null, exportsByDir }) {
  const full = (reason) => ({ kind: "full", tests: [...tests], reason, why: new Map() });
  if (changed === null) return full("no base to compare against");
  const paths = changed.filter(Boolean);
  const graph = prebuilt ?? buildGraph(sources, packages, exportsByDir);
  const runner = runnerClosure(graph);
  for (const p of paths) {
    // A version bump (every module change carries one, lint:versions) changes no
    // dependency and no code: the tests that name the manifest, nothing more.
    if (!versionOnly.has(p) && FULL_PATHS.some((re) => re.test(p))) return full(`${p} can change how every unit test runs`);
    if (runner.has(p)) return full(`${p} is loaded by the unit runner itself`);
  }
  const testSet = new Set(tests);
  const testSources = new Map(tests.map((t) => [t, sources.get(t) ?? ""]));
  const why = new Map();
  for (const p of paths) {
    if (testSet.has(p) && !why.has(p)) why.set(p, "edited");
    const seeds = keysOfChanged(p, packages, versionOnly);
    for (const f of dependents(graph, seeds, packages)) if (testSet.has(f) && !why.has(f)) why.set(f, `imports ${p}`);
    for (const t of namedBy(p, tests, testSources, basenameCount)) if (!why.has(t)) why.set(t, `names ${p}`);
    for (const t of listedBy(p, tests, testSources)) if (!why.has(t)) why.set(t, `lists files like ${p}`);
    for (const t of readBy(p, tests, testSources)) if (!why.has(t)) why.set(t, `reads ${p}`);
  }
  const aTest = paths.find((p) => ANY_TEST.test(p));
  if (aTest) {
    for (const f of dependents(graph, keysOfChanged(TEST_LISTER, packages, versionOnly), packages)) {
      if (testSet.has(f) && !why.has(f)) why.set(f, `scans every test file, and ${aTest} is one`);
    }
  }
  const selected = tests.filter((t) => why.has(t));
  return {
    kind: "affected",
    tests: selected,
    reason: `${selected.length} of ${tests.length} unit test files reach the ${paths.length} changed path(s)`,
    why,
  };
}
