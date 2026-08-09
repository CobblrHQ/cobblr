// Guard: server code must NOT hand-build an entity's detail path by substituting
// `{id}` into a detail_route template. It must go through the ONE instance-aware
// resolver — `platform().entities.detailPathForEntity(orgId, kind, id)` (or the
// pure `resolveDetailPath(...)` in api/src/platform/instance-detail.ts when the
// caller already holds the entity's instance).
//
// The trap this catches: `getKind(kind).detail_route.replace("{id}", id)` looks
// correct and typechecks, but it is scoped to the DEFAULT instance. For an item
// in a NAMED instance (a Vehicle under `assets`, a 3D Printer under `machines`)
// the base detail_route routes to the empty base page instead of the instance
// page — silently, no error. resolveDetailPath consults the item's `instance`
// and picks the per-instance route.
//
// It drifted into THREE copies before it was unified (2026-07): the minted-QR
// resolver (api/src/routes/qr-scan.ts), the resolvable-providers detail path
// (api/src/platform/resolvable-providers.ts), and the scan-rule resolver
// (modules/core-scan/src/services/qr-resolver.ts). Each hand-substituted `{id}`
// and each was blind to instances. A user scanned a Vehicle's label and landed
// on "asset not found" (reported 2026-07). This lint stops copy #4.
//
// The rule, mechanically: in api/src/** and modules/<name>/src/**, no
// `.replace("{id}", …)` — except the canonical home instance-detail.ts, and
// except a line carrying an explicit `lint-allow-detail-substitution` comment
// (for a genuine non-detail template, e.g. an outbound API URL) on that line or
// the line above.
// Run: npx tsx scripts/lint-detail-path-substitution.ts

import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// Where the class lives: server code that resolves entity detail paths. The web
// client has its own instance-aware resolver (web/src/lib/useDetailRoute.ts) and
// is out of scope here.
const ROOTS = ["api/src", "modules"];
// The one place the substitution legitimately lives.
const CANONICAL = "api/src/platform/instance-detail.ts";
const ESCAPE_HATCH = "lint-allow-detail-substitution";
// `.replace("{id}"` / `.replace('{id}'` with any surrounding whitespace.
const SUBST = /\.replace\(\s*["']\{id\}["']/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules" || name === "dist") continue;
      out.push(...sourceFiles(p));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const failures: string[] = [];
let scanned = 0;

for (const root of ROOTS) {
  for (const file of sourceFiles(root)) {
    if (file === CANONICAL) continue;
    scanned++;
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (!SUBST.test(line)) continue;
      const prev = lines[i - 1] ?? "";
      if (line.includes(ESCAPE_HATCH) || prev.includes(ESCAPE_HATCH)) continue;
      failures.push(`${file}:${i + 1}: ${line.trim()}`);
    }
  }
}

if (failures.length) {
  console.error(
    "✗ lint-detail-path-substitution: server code hand-substitutes {id} into a detail route.",
  );
  console.error(
    "  Use the instance-aware resolver: platform().entities.detailPathForEntity(orgId, kind, id)",
  );
  console.error(
    "  (or resolveDetailPath(...) in api/src/platform when you already hold the instance),",
  );
  console.error(
    "  so an item in a NAMED instance routes to its instance page, not the empty base page.",
  );
  console.error(
    `  (Genuine non-detail template? add a \`${ESCAPE_HATCH}\` comment on the line.)`,
  );
  for (const f of failures) console.error(`    ${f}`);
  process.exit(1);
}
console.log(
  `✓ detail-path-substitution lint: ${scanned} server file(s), no hand-rolled {id} detail routes (all go through resolveDetailPath)`,
);
process.exit(0);
