// Module-isolation conformance lint. Enforces the hard rules from
// docs/architecture/module-interactions.md ("What modules MUST NOT do") that
// were, until now, only checked by periodic grep + human audit — which is why
// the same drift (a module reading another module's tables, the kernel
// string-naming a module) kept getting re-discovered.
//
// This is the first-party analogue of the wasm sandbox SQL guard: that guard
// MECHANICALLY blocks third-party modules from escaping their prefix; this lint
// blocks first-party code from doing the same, at CI/typecheck time.
//
// Rules:
//   A. A module must not read/write another module's tables (selectFrom /
//      insertInto / updateTable / deleteFrom / raw `FROM <prefix>_…`), except
//      the one promoted contract (core_tags_*).
//   B. A module must not import another module's package/dir (cross-module code
//      coupling). Cross-module talk goes through the kernel (platform.*) or events.
//   C. The kernel (api/src) must not string-name a specific module, except in
//      historical migrations and the registry/default plumbing.
//
// Baseline: scripts/module-isolation-baseline.json freezes the KNOWN existing
// violations (keyed by rule+file+token, not line number, so edits don't churn
// it). The lint is GREEN today and FAILS on any NEW violation. The baseline IS
// the visible tech-debt ledger — shrink it deliberately, never grow it silently.
//
// Run: npx tsx scripts/lint-module-isolation.ts   (free, local, no CI minutes)

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const MODULES_DIR = join(ROOT, "modules");
const API_SRC = join(ROOT, "api", "src");
const BASELINE_PATH = join(ROOT, "scripts", "module-isolation-baseline.json");

// The one promoted contract — every module may JOIN these directly. See
// module-interactions.md "Promoted contracts".
const PROMOTED_PREFIXES = new Set(["core_tags_"]);

interface Violation {
  rule: "A-table-read" | "B-cross-import" | "C-kernel-names-module" | "D-module-names-module";
  file: string; // repo-relative
  line: number;
  token: string; // the offending identifier (stable across line shifts)
  detail: string;
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "migrations") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
  }
  return out;
}

// ── Discover the prefix → module map from each manifest ──────────────────────
function discoverModules(): { byPrefix: Map<string, string>; names: Set<string>; prefixes: string[] } {
  const byPrefix = new Map<string, string>();
  const names = new Set<string>();
  for (const m of readdirSync(MODULES_DIR)) {
    const manifest = join(MODULES_DIR, m, "src", "module.ts");
    if (!existsSync(manifest)) continue;
    const src = readFileSync(manifest, "utf8");
    const name = /name:\s*"([a-z0-9-]+)"/.exec(src)?.[1];
    const prefix = /tablePrefix:\s*"([a-z0-9_]+)"/.exec(src)?.[1];
    if (name) names.add(name);
    if (name && prefix) byPrefix.set(prefix, name);
  }
  // Sort prefixes longest-first so e.g. core_files_ matches before core_f… overlaps.
  const prefixes = [...byPrefix.keys()].sort((a, b) => b.length - a.length);
  return { byPrefix, names, prefixes };
}

const { byPrefix, names, prefixes } = discoverModules();
const violations: Violation[] = [];

function ownPrefixOf(file: string): string | null {
  const m = /modules\/([a-z0-9-]+)\//.exec(file.replace(/\\/g, "/"));
  if (!m) return null;
  for (const [pfx, mod] of byPrefix) if (mod === m[1]) return pfx;
  return null;
}

// Blank out // and /* */ comments (preserving newlines for line numbers) so
// prose like "this reads inventory_parts" doesn't trip the SQL matcher.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
}

// ── Rule A: cross-module table access ────────────────────────────────────────
// Catch an other-module table prefix used as a table identifier — in a Kysely
// builder call OR in any (typed `sql<T>`` / plain `sql`` / `.raw`) SQL string —
// after a FROM/JOIN/INTO/UPDATE. We scan the whole comment-stripped file: a bare
// `from inventory_parts` is unambiguously a cross-module table read (no JS
// identifier starts with another module's `<prefix>_`).
const KYSELY_RE =
  /\b(?:selectFrom|insertInto|updateTable|deleteFrom|innerJoin|leftJoin|rightJoin|fullJoin)\s*\(\s*["'`]([a-z0-9_]+)/g;
const RAW_FROM_RE = /\b(?:from|join|into|update)\s+([a-z0-9_]+)/gi;

function checkTableRefs(file: string, rawSrc: string): void {
  const src = stripComments(rawSrc);
  const own = ownPrefixOf(file);
  const seen = new Set<string>();
  const flag = (ident: string, idx: number) => {
    for (const pfx of prefixes) {
      if (!ident.startsWith(pfx)) continue;
      if (own && ident.startsWith(own)) return; // own table — fine
      if (PROMOTED_PREFIXES.has(pfx)) return; // core-tags promoted contract
      const line = src.slice(0, idx).split("\n").length;
      const key = `${ident}:${line}`;
      if (seen.has(key)) return;
      seen.add(key);
      violations.push({
        rule: "A-table-read",
        file,
        line,
        token: ident,
        detail: `reads table '${ident}' owned by module '${byPrefix.get(pfx)}'`,
      });
      return;
    }
  };
  for (const m of src.matchAll(KYSELY_RE)) flag(m[1]!.toLowerCase(), m.index!);
  for (const m of src.matchAll(RAW_FROM_RE)) flag(m[1]!.toLowerCase(), m.index!);
}

// ── Rule D: a module string-names another module ─────────────────────────────
// e.g. joining org_modules on `module_name = "inventory"` from inside `lists`,
// or core-scan's hardcoded target list. Kind strings ("inventory:part") are
// allowed (they carry a colon → kernel-mediated reference) and don't match.
function checkModuleNaming(file: string, rawSrc: string): void {
  // A module's manifest LEGITIMATELY names other modules — `dependencies`,
  // event `subscribes`, exposed-API references. The rule is about code reaching
  // into another module, not declaring a relationship. Skip module.ts.
  if (/\/module\.ts$/.test(file.replace(/\\/g, "/"))) return;
  const ownMod = /modules\/([a-z0-9-]+)\//.exec(file.replace(/\\/g, "/"))?.[1];
  const src = stripComments(rawSrc);
  src.split("\n").forEach((ln, i) => {
    // A declarative dependency list — `requires:` / `dependencies:` /
    // `subscribes:` — legitimately NAMES other modules (same rationale that
    // exempts module.ts manifests: it's declaring a relationship, e.g. an
    // authoring template's `requires: ["inventory", "labels"]`, not code
    // reaching into another module). Skip the whole line.
    if (/^\s*(requires|dependencies|subscribes)\s*:/.test(ln)) return;
    for (const m of ln.matchAll(/["']([a-z0-9-]+)["']/g)) {
      const lit = m[1]!;
      if (names.has(lit) && lit !== ownMod) {
        violations.push({
          rule: "D-module-names-module",
          file,
          line: i + 1,
          token: lit,
          detail: `module '${ownMod}' string-names another module '${lit}'`,
        });
      }
    }
    // Colon-literal kind strings ("inventory:part") are normally fine — they're
    // kernel-mediated references. But BRANCHING on another module's kind in
    // control flow (=== / !== / case) IS coupling: it's exactly the pattern that
    // hid core-scan's hardcoded scan maps behind the colon exemption. Flag a
    // foreign kind compared in control flow; own-module kinds are fine. Reach
    // for a kernel seam (resolver / trait / registry) instead. (Audit
    // 2026-06-26.)
    for (const m of ln.matchAll(/(?:===|!==|\bcase)\s*["']([a-z0-9-]+:[a-z0-9_-]+)["']/g)) {
      const kind = m[1]!;
      const mod = kind.split(":")[0]!;
      if (names.has(mod) && mod !== ownMod) {
        violations.push({
          rule: "D-module-names-module",
          file,
          line: i + 1,
          token: kind,
          detail: `module '${ownMod}' branches on another module's kind '${kind}' — use a kernel seam (resolver / trait / registry), not a hardcoded kind`,
        });
      }
    }
  });
}

// ── Rule B: cross-module imports ─────────────────────────────────────────────
const IMPORT_RE = /\bfrom\s+["']([^"']+)["']/g;
function checkImports(file: string, src: string): void {
  const ownMod = /modules\/([a-z0-9-]+)\//.exec(file.replace(/\\/g, "/"))?.[1];
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1]!;
    // @cobblr/<othermodule>
    const pkg = /^@cobblr\/([a-z0-9-]+)/.exec(spec)?.[1];
    if (pkg && names.has(pkg) && pkg !== ownMod) {
      violations.push({
        rule: "B-cross-import",
        file,
        line: src.slice(0, m.index!).split("\n").length,
        token: spec,
        detail: `imports another module's package '${spec}'`,
      });
    }
    // relative climb into a sibling module: ../../<othermodule>/ or ../<othermodule>/
    const rel = /(?:^|\/)\.\.\/(?:\.\.\/)*([a-z0-9-]+)\//.exec(spec)?.[1];
    if (rel && names.has(rel) && rel !== ownMod) {
      violations.push({
        rule: "B-cross-import",
        file,
        line: src.slice(0, m.index!).split("\n").length,
        token: spec,
        detail: `imports another module's directory '${spec}'`,
      });
    }
  }
}

// ── Rule C: kernel string-names a module ─────────────────────────────────────
// A string literal in api/src equal to a known module name, outside historical
// migrations / test plumbing. Conservative: only flags exact module-name literals.
function checkKernelNaming(file: string, rawSrc: string): void {
  // Match module-name LITERALS against the comment-stripped source — a module
  // name in a JSDoc example or a `// note` is documentation, never coupling
  // (rules A and D already strip). Without this the kernel couldn't even
  // DESCRIBE a module in a doc-comment. (Audit burn-down.)
  const rawLines = rawSrc.split("\n");
  const lines = stripComments(rawSrc).split("\n");
  lines.forEach((ln, i) => {
    // `HISTORICAL DATA MIGRATION` is an intentional inline COMMENT marker —
    // test the RAW line (the marker lives in the comment we strip above).
    if (/HISTORICAL DATA MIGRATION/.test(rawLines[i] ?? "")) return;
    // Real console.* calls may name a module (logging) — test the STRIPPED line
    // so a commented-out console.log can't shield a real literal below it.
    if (/console\.(log|warn|error|info)/.test(ln)) return;
    for (const m of ln.matchAll(/["']([a-z0-9-]+)["']/g)) {
      const lit = m[1]!;
      if (names.has(lit)) {
        violations.push({
          rule: "C-kernel-names-module",
          file,
          line: i + 1,
          token: lit,
          detail: `kernel hardcodes module name '${lit}'`,
        });
      }
    }
  });
}

// ── Run ──────────────────────────────────────────────────────────────────────
for (const f of walk(MODULES_DIR)) {
  const rel = relative(ROOT, f);
  const src = readFileSync(f, "utf8");
  checkTableRefs(rel, src);
  checkImports(rel, src);
  checkModuleNaming(rel, src);
}
for (const f of walk(API_SRC)) {
  const unix = f.replace(/\\/g, "/");
  // Skip historical data-migration helpers (fenced + name-driven) and dev
  // seed/demo scripts (naming modules to seed them is their whole job).
  if (/\/migrate-/.test(unix) || /\/scripts\//.test(unix)) continue;
  const rel = relative(ROOT, f);
  checkKernelNaming(rel, readFileSync(f, "utf8"));
}

// ── Baseline diff ────────────────────────────────────────────────────────────
type BaselineEntry = { rule: string; file: string; token: string; reason: string };
const baseline: BaselineEntry[] = existsSync(BASELINE_PATH)
  ? JSON.parse(readFileSync(BASELINE_PATH, "utf8"))
  : [];
const baselineKey = (v: { rule: string; file: string; token: string }) => `${v.rule}::${v.file}::${v.token}`;
const baselined = new Set(baseline.map(baselineKey));

const isNew = violations.filter((v) => !baselined.has(baselineKey(v)));
// Stale baseline entries (fixed violations still listed) — report so the ledger
// can shrink, but don't fail on them.
const stillPresent = new Set(violations.map(baselineKey));
const staleBaseline = baseline.filter((b) => !stillPresent.has(baselineKey(b)));

const WRITE_BASELINE = process.argv.includes("--update-baseline");
if (WRITE_BASELINE) {
  const byKey = new Map<string, BaselineEntry>();
  for (const v of violations) {
    const k = baselineKey(v);
    if (!byKey.has(k)) {
      byKey.set(k, {
        rule: v.rule,
        file: v.file,
        token: v.token,
        reason: "grandfathered 2026-06-10 — pre-existing drift; burn down, never grow. See docs/architecture/module-interactions.md",
      });
    }
  }
  const fresh = [...byKey.values()].sort((a, b) => baselineKey(a).localeCompare(baselineKey(b)));
  writeFileSync(BASELINE_PATH, JSON.stringify(fresh, null, 2) + "\n");
  console.log(`Wrote ${fresh.length} unique baseline entries to ${relative(ROOT, BASELINE_PATH)}`);
  process.exit(0);
}

console.log(`module-isolation lint: ${violations.length} total findings, ${baselined.size} baselined, ${isNew.length} NEW`);
if (staleBaseline.length) {
  console.log(`\n${staleBaseline.length} baseline entr${staleBaseline.length === 1 ? "y is" : "ies are"} now fixed — remove from the baseline:`);
  for (const b of staleBaseline) console.log(`  - ${b.rule} ${b.file} :: ${b.token}`);
}
if (isNew.length) {
  console.error(`\n❌ ${isNew.length} NEW module-isolation violation(s):\n`);
  for (const v of isNew) {
    console.error(`  [${v.rule}] ${v.file}:${v.line}\n      ${v.detail}`);
  }
  console.error(`\nFix: route cross-module access through platform.* (entities.lookup/list, catalogs.*,`);
  console.error(`pairings.*, events.emit) or the module's own HTTP endpoint — never a direct table read`);
  console.error(`or cross-module import. See docs/architecture/module-interactions.md.`);
  console.error(`If this is a deliberate, documented exception, add it to the baseline with a reason.`);
  process.exit(1);
}
console.log("✓ no new module-isolation violations");
