// Guard: a flagship/community bundle whose CONTENT changed in
// web/src/lib/featured-bundles.ts must BUMP its manifest version.
//
// Why this exists (the hole it closes):
//   featured-bundles.ts is the SINGLE SOURCE OF TRUTH for bundle manifests
//   (scripts/build-extensions-index.ts reads `manifest.version` straight from
//   it to build the marketplace registry index; the web app installs off it).
//   `bundles/*.json` are GENERATED from it by scripts/sync-bundles.ts — and
//   that sync AUTO-BUMPS the generated json's patch version when the web
//   version didn't move. So `lint:versions` (which only inspects bundles/*.json)
//   ALWAYS sees a bumped version there and can never catch a content change that
//   didn't bump the version IN THE SOURCE. That's exactly how a 2026-07-11 laser
//   default change reached the file without a version bump: the marketplace kept
//   serving the old version, so already-installed workspaces got no "update
//   available" prompt.
//
// The mechanism (diff-friendly, TS-source-proof):
//   featured-bundles.ts is TypeScript, not diff-friendly JSON, so we don't diff
//   it — we IMPORT FEATURED_BUNDLES, hash each manifest's content (excluding the
//   release-metadata keys version/changelog/released_at, mirroring lint-versions),
//   and compare against a committed snapshot lockfile
//   bundles/bundle-versions.lock.json = { "<bundle id>": { version, hash } }.
//   • hash changed while version stayed put  → HARD FAIL: bump the version.
//   • version bumped / bundle added / removed → the lock is stale → run --write.
//   The lock is committed, so a reviewer sees the version+hash move in the diff.
//
// Run:   npx tsx scripts/lint-bundle-content.ts          (CI/pre-push check)
// Write: npx tsx scripts/lint-bundle-content.ts --write  (regenerate the lock)
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { FEATURED_BUNDLES } from "../web/src/lib/featured-bundles.js";

const LOCK = path.join(process.cwd(), "bundles", "bundle-versions.lock.json");
const WRITE = process.argv.includes("--write");

// Release-metadata keys excluded from the content hash (mirrors lint-versions.ts
// and sync-bundles.ts `sig()`): moving these alone is a release, not a content
// change, and is not what we're guarding.
const META = new Set(["version", "changelog", "released_at"]);

/** Deterministic JSON with recursively sorted object keys, so a cosmetic key
 *  reorder in the source doesn't spuriously change the hash. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) out[k] = canonical(o[k]);
    return out;
  }
  return v;
}

function contentHash(manifest: Record<string, unknown>): string {
  const { version: _v, changelog: _c, released_at: _r, ...rest } = manifest;
  return createHash("sha256").update(JSON.stringify(canonical(rest))).digest("hex");
}

type LockEntry = { version: string; hash: string };
type Lock = Record<string, LockEntry>;

// ── current state from the source of truth ──
const current: Lock = {};
for (const fb of FEATURED_BUNDLES) {
  const manifest = fb.manifest as unknown as Record<string, unknown>;
  const id = String(manifest.id ?? "");
  if (!id.startsWith("cobblr.")) continue; // flagship + community only
  current[id] = { version: String(manifest.version ?? "0.0.0"), hash: contentHash(manifest) };
}
const sortedCurrent: Lock = {};
for (const id of Object.keys(current).sort()) sortedCurrent[id] = current[id];

if (WRITE) {
  writeFileSync(LOCK, JSON.stringify(sortedCurrent, null, 2) + "\n");
  console.log(`[lint:bundle-content] wrote lock for ${Object.keys(sortedCurrent).length} bundles → ${LOCK}`);
  process.exit(0);
}

if (!existsSync(LOCK)) {
  console.error(
    `[lint:bundle-content] ✗ ${path.relative(process.cwd(), LOCK)} is missing.\n` +
      `  Seed it:  npx tsx scripts/lint-bundle-content.ts --write   and commit it.`,
  );
  process.exit(1);
}

let lock: Lock;
try {
  lock = JSON.parse(readFileSync(LOCK, "utf8")) as Lock;
} catch {
  console.error(`[lint:bundle-content] ✗ ${path.relative(process.cwd(), LOCK)} is not valid JSON.`);
  process.exit(1);
}

const noBump: string[] = []; // the dangerous case: content moved, version didn't
const stale: string[] = []; // lock needs regenerating (bump / add / remove)

for (const [id, cur] of Object.entries(current)) {
  const prev = lock[id];
  if (!prev) {
    stale.push(`${id}: new bundle not yet in the lock`);
    continue;
  }
  if (prev.hash === cur.hash) {
    if (prev.version !== cur.version) stale.push(`${id}: version moved to ${cur.version} with no content change`);
    continue;
  }
  // content changed
  if (prev.version === cur.version) {
    noBump.push(`${id}: content changed but version stayed "${cur.version}" — bump it (semver) + add a changelog line.`);
  } else {
    stale.push(`${id}: content + version changed (${prev.version} → ${cur.version}) — lock not regenerated`);
  }
}
for (const id of Object.keys(lock)) {
  if (!current[id]) stale.push(`${id}: removed from featured-bundles.ts but still in the lock`);
}

if (noBump.length) {
  console.error(
    "[lint:bundle-content] ✗ bundle content changed without a version bump:\n" +
      noBump.map((v) => "  - " + v).join("\n") +
      "\n\n  featured-bundles.ts is the source the marketplace registry serves; a content\n" +
      "  change with no version bump strands already-installed workspaces (no upgrade\n" +
      "  prompt). Bump `version` on the manifest, then regenerate the lock:\n" +
      "    npx tsx scripts/lint-bundle-content.ts --write   (and re-run sync-bundles.ts)",
  );
  process.exit(1);
}
if (stale.length) {
  console.error(
    "[lint:bundle-content] ✗ the content lock is out of date:\n" +
      stale.map((v) => "  - " + v).join("\n") +
      "\n\n  Regenerate + commit it:\n    npx tsx scripts/lint-bundle-content.ts --write",
  );
  process.exit(1);
}

console.log(`[lint:bundle-content] ✓ ${Object.keys(current).length} bundles: content matches the locked versions`);
