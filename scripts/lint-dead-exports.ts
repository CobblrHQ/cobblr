// Dead-export lint. Flags an exported symbol whose name appears NOWHERE in the repo but
// its own definition — the fingerprint of dead code OR a half-wired feature (a verify fn
// whose mint side is never called, a lifecycle seam nothing fires). A code sweep found 14
// of these by hand; this makes the whole class fail at commit for everyone.
//
// METHOD (fast + accurate for THIS codebase): one pass tokenizes every .ts/.tsx in the
// repo into a global identifier-frequency map, then each exported symbol is "dead" iff its
// name occurs exactly once (only at its definition). Because we tally raw tokens, a
// string-keyed dispatch (`handlers.get("listQueues")`) or a re-export barrel COUNTS as a
// use — so the failure mode is UNDER-reporting (a symbol sharing a name with an unrelated
// identifier looks alive), never a false positive that blocks a real symbol.
//
// Baseline: scripts/dead-exports-baseline.json freezes today's known-dead exports (a
// seam kept ahead of its feature, an intentionally-retained capability). GREEN today,
// FAILS on any NEW dead export. Shrink the baseline as real dead code is removed; never
// grow it silently. `--update-baseline` regenerates it.
//
// Run: npx tsx scripts/lint-dead-exports.ts   (free, local, no CI minutes)

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const BASELINE_PATH = join(ROOT, "scripts", "dead-exports-baseline.json");

// Where we look for DEFINITIONS: the APPLICATION code, where an unreferenced export means
// dead code or a half-wired feature. We deliberately EXCLUDE packages/* — those are shared
// libraries + the platform CONTRACT, whose exports are an extension surface for module
// authors, so "no first-party caller" there is expected, not a defect. The reference tally
// below still scans the WHOLE repo (incl. packages + tests), so a symbol used anywhere is alive.
const DEFINITION_ROOTS = ["api/src", "modules"];
const IGNORE_DIRS = new Set(["node_modules", "dist", "build", ".git", "coverage", "_tmp"]);

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (IGNORE_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const TOKEN_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;

// ── Pass 1: global identifier frequency over the ENTIRE repo ──────────────
const repoFiles = walk(ROOT);
const freq = new Map<string, number>();
for (const f of repoFiles) {
  const text = readFileSync(f, "utf8");
  const m = text.match(TOKEN_RE);
  if (!m) continue;
  for (const tok of m) freq.set(tok, (freq.get(tok) ?? 0) + 1);
}

// ── Pass 2: collect exported symbols in the definition roots ──────────────
// Named declaration exports only. Re-export barrels (`export { X } from`), `export *`, and
// `export default <anon>` are skipped: a barrel's `X` already counts as a reference, and
// a default export has no stable name to track.
const EXPORT_RE =
  /^export\s+(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/;

interface DeadExport {
  file: string; // repo-relative
  name: string;
  line: number;
}
const dead: DeadExport[] = [];
for (const rootRel of DEFINITION_ROOTS) {
  for (const f of walk(join(ROOT, rootRel))) {
    if (/\.(test|spec)\.(ts|tsx)$/.test(f)) continue; // test files don't define prod exports
    const lines = readFileSync(f, "utf8").split("\n");
    lines.forEach((line, i) => {
      const m = EXPORT_RE.exec(line);
      if (!m) return;
      const name = m[1]!;
      if ((freq.get(name) ?? 0) <= 1) {
        dead.push({ file: relative(ROOT, f), name, line: i + 1 });
      }
    });
  }
}

// ── Baseline diff ─────────────────────────────────────────────────────────
interface BaselineEntry {
  file: string;
  name: string;
  reason: string;
}
const key = (d: { file: string; name: string }) => `${d.file}::${d.name}`;

if (process.argv.includes("--update-baseline")) {
  const byKey = new Map<string, BaselineEntry>();
  for (const d of dead) {
    if (!byKey.has(key(d))) {
      byKey.set(key(d), { file: d.file, name: d.name, reason: "baselined 2026-07-30 — pre-existing dead/half-wired export; remove or wire up, never grow." });
    }
  }
  const fresh = [...byKey.values()].sort((a, b) => key(a).localeCompare(key(b)));
  writeFileSync(BASELINE_PATH, JSON.stringify(fresh, null, 2) + "\n");
  console.log(`Wrote ${fresh.length} baseline entries to ${relative(ROOT, BASELINE_PATH)}`);
  process.exit(0);
}

const baseline: BaselineEntry[] = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : [];
const baselined = new Set(baseline.map(key));
const isNew = dead.filter((d) => !baselined.has(key(d)));
const deadKeys = new Set(dead.map(key));
const stale = baseline.filter((b) => !deadKeys.has(key(b)));

console.log(`dead-exports lint: ${dead.length} dead export(s), ${baselined.size} baselined, ${isNew.length} NEW`);
if (stale.length) {
  console.log(`\n${stale.length} baseline entr${stale.length === 1 ? "y is" : "ies are"} now used — remove from the baseline:`);
  for (const b of stale) console.log(`  - ${b.file} :: ${b.name}`);
}
if (isNew.length) {
  console.error(`\n❌ ${isNew.length} NEW dead export(s) — exported but referenced nowhere in the repo:\n`);
  for (const d of isNew) console.error(`  ${d.file}:${d.line}  export ${d.name}`);
  console.error(`\nEither delete it, or wire up the caller it's waiting for (a dead export is often a half-`);
  console.error(`built feature — a mint fn whose send flow is missing, a seam nothing fires). If it's a`);
  console.error(`deliberate seam kept ahead of its feature, add it to scripts/dead-exports-baseline.json`);
  console.error(`with a reason (npx tsx scripts/lint-dead-exports.ts --update-baseline regenerates it).`);
  process.exit(1);
}
console.log("✓ no new dead exports");
