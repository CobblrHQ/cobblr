// Guard: a versioned unit that CHANGED must BUMP its version.
//
// The trap (yarn hit it): item_noun was added to the Yarn bundle's 0.4.0 manifest
// IN PLACE without bumping the version — so already-installed workspaces never saw
// an "update available" and kept the stale config. A version is the contract that
// surfaces the upgrade; changing content without bumping silently strands users.
//
// Scope (high-signal, low false-positive):
//   • BUNDLES (bundles/*.json) — ANY content change (excluding the release-metadata
//     keys, scripts/lib/bundle-release-keys.ts) requires a version bump. Bundles are
//     the user-facing upgrade unit. And a bump must add a `releases` entry for the
//     new version: the update prompt lists those, and a bump without one showed
//     the previous release's notes as the new one's.
//   • MODULES (modules/<name>/) — only a MIGRATIONS change (modules/<name>/migrations/**)
//     requires a module.ts version bump: a schema change = "how the module works"
//     changed. Routine code edits don't trip this.
//
// Diffs against main; no-ops when there's no base to compare (e.g. on main itself).
// Run: npx tsx scripts/lint-versions.ts
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { bundleContent } from "./lib/bundle-release-keys.js";

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
// `catalog` is offer-curation metadata (which tier the platform lists a bundle
// in — see docs/design-decisions/bundle-catalog-tiers.md), NOT content an
// installed workspace has to re-sync. Changing it must NOT force a version bump:
// a bump would show every existing install an "update available" for a bundle the
// operator is DEMOTING, which is backwards.
function stripMeta(j: unknown): string {
  const obj = j as { manifest?: Record<string, unknown> } & Record<string, unknown>;
  const m = (obj?.manifest ?? obj) as Record<string, unknown>;
  if (m && typeof m === "object") return JSON.stringify(bundleContent(m));
  return JSON.stringify(j);
}
// A version bump with no notes of its own is how an update prompt came to
// show notes from months before the version on offer: the bump was automatic
// and the old `changelog` string rode along untouched.
function releaseFor(j: unknown, version: string): boolean {
  const o = j as { manifest?: { releases?: Array<{ version?: string }> }; releases?: Array<{ version?: string }> };
  return (o?.manifest?.releases ?? o?.releases ?? []).some((r) => r?.version === version);
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
    violations.push(`${f}: content changed but version stayed "${ver(newJson)}" — bump it (semver) + add a releases entry.`);
  }
  const newVer = ver(newJson);
  if (newVer && newVer !== ver(oldJson) && !releaseFor(newJson, newVer)) {
    violations.push(
      `${f}: version moved to "${newVer}" with no releases entry saying what changed in it. Add ` +
        `{ version: "${newVer}", released_at, notes } at the top of the manifest's \`releases\` ` +
        `(web/src/lib/featured-bundles.ts for a featured bundle, then scripts/sync-bundles.ts).`,
    );
  }
}

// ── modules: a migrations change must bump module.ts version ──
const modsWithMigrationChange = new Set<string>();
for (const f of changed) {
  const mod = f.match(/^modules\/([^/]+)\/migrations\//)?.[1];
  if (mod) modsWithMigrationChange.add(mod);
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
