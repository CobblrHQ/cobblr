// A bundle's id must be the slug of the noun it serves.
//
// The rule was settled long ago ("a bundle title is the noun, not the use case"),
// and the 2026-08-08 pass fixed the TITLES — but titles only. Ids kept their
// original shape, so the catalog carried `food-cluster` for a bundle called
// "Groceries" (cluster is an internal ARCHITECTURE shape, never user-facing),
// plus `pet-care`/`plant-care`/`vehicle-maintenance` for Pets/Plants/Vehicles.
//
// That mismatch is not cosmetic. The id is what a developer greps, what the
// filename is derived from, and what a spec author scans when checking whether a
// use case already ships. It cost exactly that once: a groceries spec was
// written proposing a bundle that already existed, because `food-cluster.json`
// did not read as groceries.
//
// An id is IDENTITY (installed workspaces store it), so fixing one costs a data
// migration — cheap now, expensive after 1.0 ships to self-hosters. This lint
// keeps a NEW mismatch from being added, which is the whole point.
//
// Deliberately NOT enforced: an id that is a strict, sensible SUBSET of a longer
// title ("printer-parts" for "3D Printer Parts") — the slug rule would demand
// "3d-printer-parts", which is worse. So the test is: the id must be a slug the
// title can plausibly produce, i.e. every SEGMENT of the id must appear in the
// title's slug, and vice versa for the significant words.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "bundles");

const slugOf = (s: string) =>
  s.toLowerCase().replace(/&/g, " ").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const violations: string[] = [];

for (const file of readdirSync(DIR).sort()) {
  if (!file.endsWith(".json") || file.includes("lock")) continue;
  const raw = JSON.parse(readFileSync(join(DIR, file), "utf8")) as Record<string, unknown>;
  const m = (raw.manifest ?? raw) as { id?: string; name?: string };
  if (!m.id || !m.name) continue;
  const id = m.id.replace(/^cobblr\.(flagship|community|user)\./, "");
  const titleSlug = slugOf(m.name);
  if (id === titleSlug) continue;
  // Subset allowance: every segment of the id appears in the title's slug.
  const idParts = id.split("-");
  const titleParts = new Set(titleSlug.split("-"));
  if (idParts.every((p) => titleParts.has(p))) continue;
  const stray = idParts.filter((p) => !titleParts.has(p));
  violations.push(
    `  ${file}\n      id "${id}" vs title "${m.name}" (slug "${titleSlug}") — ` +
      `id carries ${stray.map((s) => `"${s}"`).join(", ")}, which the title does not`,
  );
}

if (violations.length > 0) {
  console.error(
    `Bundle id does not match the noun it serves (${violations.length}):\n` +
      `${violations.join("\n")}\n\n` +
      `An id is IDENTITY — installed workspaces store it in bundles.external_id and\n` +
      `bundle_resource_claims.source. Renaming one needs a data migration (see\n` +
      `api/migrations/platform/20260809-098-bundle-id-renames.sql for the pattern).\n` +
      `So: pick the noun's slug when you ADD a bundle, and it never comes up again.`,
  );
  process.exit(1);
}
console.log(`lint:bundle-id-noun - every bundle id matches its title's noun ✓`);
