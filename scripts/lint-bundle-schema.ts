// Guard: every shipped bundle manifest must PASS the same structural schema
// (BundleManifest) that the install/update endpoint validates against — so a
// structurally-invalid bundle can NEVER reach production and break installs.
//
// The hole this closes (2026-07-15):
//   The flagship Yarn bundle shipped v0.6.0 with a computed field carrying a
//   `unit` ("Full skein", type:"computed", unit:"m"). BundleManifest's refine
//   rejects `unit` on non-number fields ("unit is only valid for type='number'"),
//   so the WHOLE manifest failed `BundleManifest.safeParse` — and every yarn
//   workspace that clicked "Update now" got "Bundle manifest failed validation".
//   Nothing caught it before prod: lint:bundle-quality checks discoverability,
//   lint:bundle-content checks version bumps, lint:bundles-synced checks the
//   json matches the source — but NONE ran the actual structural schema. This
//   lint does exactly that, for every bundle in bundles/*.json.
//
// Pure: BundleManifest.safeParse does no I/O. We set dummy env only because
// importing the route module eagerly validates process.env; the check never
// opens a DB.
//
// Run:  npx tsx scripts/lint-bundle-schema.ts

import fs from "node:fs";
import path from "node:path";

// BundleManifest lives in a route module that validates env at import time.
// safeParse itself touches no DB — supply throwaway values so the import loads.
process.env.DATABASE_URL ||= "postgres://lint/lint";
process.env.SUPERUSER_DATABASE_URL ||= "postgres://lint/lint";
process.env.JWT_SECRET ||= "lint-only-secret-000000";
process.env.TENANT_CREDS_ENCRYPTION_KEY ||=
  "0000000000000000000000000000000000000000000000000000000000000000";

async function main(): Promise<void> {
  const { BundleManifest } = await import("../api/src/routes/bundles.ts");

  const dir = path.join(process.cwd(), "bundles");
  const problems: string[] = [];
  let checked = 0;

  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith(".json") || f.includes("lock")) continue;
    let manifest: unknown;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as {
        manifest?: unknown;
      };
      manifest = raw.manifest ?? raw;
    } catch {
      problems.push(`${f}: unparseable JSON`);
      continue;
    }
    checked++;
    const r = BundleManifest.safeParse(manifest);
    if (!r.success) {
      for (const issue of r.error.issues) {
        const at = issue.path.join(".") || "<root>";
        problems.push(`${f}: ${at} — ${issue.message}`);
      }
    }
  }

  if (problems.length > 0) {
    console.error(
      `lint:bundle-schema: ${problems.length} bundle manifest issue(s) — these would fail install/update in production:\n`,
    );
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.error(
      `\nFix the manifest in web/src/lib/featured-bundles.ts (the source of truth), then re-run scripts/sync-bundles.ts.`,
    );
    process.exit(1);
  }

  console.log(`lint:bundle-schema: ${checked} bundle manifest(s) pass BundleManifest structural validation ✓`);
}

void main();
