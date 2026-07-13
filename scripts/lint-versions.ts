// Guard: a versioned unit that CHANGED must BUMP its version.
//
// The trap (yarn hit it): item_noun was added to the Yarn bundle's 0.4.0 manifest
// IN PLACE without bumping the version — so already-installed workspaces never saw
// an "update available" and kept the stale config. A version is the contract that
// surfaces the upgrade; changing content without bumping silently strands users.
//
// Scope (high-signal, low false-positive):
//   • BUNDLES (bundles/*.json) — ANY content change (excluding the release-metadata
//     keys version/changelog/released_at) requires a version bump. Bundles are the
//     user-facing upgrade unit.
//   • MODULES (modules/<name>/) — only a MIGRATIONS change (modules/<name>/migrations/**)
//     requires a module.ts version bump: a schema change = "how the module works"
//     changed. Routine code edits don't trip this.
//
// Diffs against main; no-ops when there's no base to compare (e.g. on main itself).
// Run: npx tsx scripts/lint-versions.ts
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

function git(cmd: string): string {
  return execSync(`git ${cmd}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}
function tryGit(cmd: string): string | null {
  try {
    return git(cmd);
  } catch {
    return null;
  }
}

function findBase(): string | null {
  for (const ref of ["origin/main", "forgejo/main", "main"]) {
    const mb = tryGit(`merge-base HEAD ${ref}`);
    if (mb) return mb;
  }
  return null;
}

const base = findBase();
if (!base) {
  console.log("[lint:versions] no base ref (origin/main) to compare — skipping");
  process.exit(0);
}
if (base === tryGit("rev-parse HEAD")) {
  console.log("[lint:versions] HEAD is the base — nothing to check");
  process.exit(0);
}

const changed = git(`diff --name-only ${base}...HEAD`).split("\n").filter(Boolean);
const violations: string[] = [];

// ── bundles ──
const META = new Set(["version", "changelog", "released_at"]);
function stripMeta(j: unknown): string {
  const obj = j as { manifest?: Record<string, unknown> } & Record<string, unknown>;
  const m = (obj?.manifest ?? obj) as Record<string, unknown>;
  if (m && typeof m === "object") {
    const c: Record<string, unknown> = { ...m };
    for (const k of META) delete c[k];
    return JSON.stringify(c);
  }
  return JSON.stringify(j);
}
function ver(j: unknown): string | undefined {
  const o = j as { manifest?: { version?: string }; version?: string };
  return o?.manifest?.version ?? o?.version;
}
// Only real bundle MANIFESTS — not the generated content-lock, which carries
// per-bundle versions under bundle-id keys (no top-level manifest version), so
// it would always read as "version undefined, content changed" and false-trip.
// It's a derived artifact; a manifest bump is what the lock records, not a thing
// that itself needs bumping.
const BUNDLE_LOCK = "bundles/bundle-versions.lock.json";
for (const f of changed.filter((f) => /^bundles\/[^/]+\.json$/.test(f) && f !== BUNDLE_LOCK)) {
  const oldRaw = tryGit(`show ${base}:${f}`);
  if (!oldRaw || !existsSync(f)) continue; // newly added / deleted — fine
  let oldJson: unknown, newJson: unknown;
  try {
    oldJson = JSON.parse(oldRaw);
    newJson = JSON.parse(readFileSync(f, "utf8"));
  } catch {
    continue;
  }
  if (stripMeta(oldJson) !== stripMeta(newJson) && ver(oldJson) === ver(newJson)) {
    violations.push(`${f}: content changed but version stayed "${ver(newJson)}" — bump it (semver) + add a changelog line.`);
  }
}

// ── modules: a migrations change must bump module.ts version ──
const modsWithMigrationChange = new Set<string>();
for (const f of changed) {
  const m = f.match(/^modules\/([^/]+)\/migrations\//);
  if (m) modsWithMigrationChange.add(m[1]);
}
for (const mod of modsWithMigrationChange) {
  const mt = `modules/${mod}/src/module.ts`;
  const oldMt = tryGit(`show ${base}:${mt}`);
  if (!oldMt || !existsSync(mt)) continue;
  const oldVer = oldMt.match(/version:\s*"([^"]+)"/)?.[1];
  const newVer = readFileSync(mt, "utf8").match(/version:\s*"([^"]+)"/)?.[1];
  if (oldVer && newVer && oldVer === newVer) {
    violations.push(`modules/${mod}: migrations changed but module.ts version stayed "${newVer}" — bump it.`);
  }
}

if (violations.length) {
  console.error("[lint:versions] ✗ version bump required:\n" + violations.map((v) => "  - " + v).join("\n"));
  process.exit(1);
}
console.log("[lint:versions] ✓ versioned units that changed were bumped");
