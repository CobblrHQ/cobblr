// A bundle may not declare a field whose meaning a platform capability owns.
//
// The role vocabulary says which those are: an entry in FIELD_ROLE_LABELS with
// an `ownedBy` names the capability that already answers that question for
// every record in the workspace. Two places to write one fact end up
// disagreeing, and the copy in the custom field is the one nothing else can
// read.
//
// This is not theoretical. Home Inventory shipped a Room text field, retired it
// into real Locations at v0.4.0, and a scan matched the day before that upgrade
// still showed "room: Living room" beside the item's actual location, Den,
// eleven days later (reported 2026-09-03). The API refuses such a field now;
// this is the same refusal at authoring time, where a bundle is written.
//
//   npx tsx scripts/lint-platform-owned-roles.ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { FIELD_ROLE_LABELS, fieldRoleOwnedMessage, type FieldRole } from "../packages/platform-contract/src/index.js";

const OWNED = new Set(
  (Object.keys(FIELD_ROLE_LABELS) as FieldRole[]).filter((r) => FIELD_ROLE_LABELS[r].ownedBy),
);

interface Hit { file: string; field: string; role: string }
const hits: Hit[] = [];

function walk(node: unknown, file: string): void {
  if (Array.isArray(node)) {
    for (const x of node) walk(x, file);
    return;
  }
  if (!node || typeof node !== "object") return;
  const o = node as Record<string, unknown>;
  const role = typeof o.field_role === "string" ? o.field_role : null;
  if (role && OWNED.has(role as FieldRole)) {
    hits.push({ file, field: String(o.key ?? o.name ?? "(unnamed)"), role });
  }
  for (const v of Object.values(o)) walk(v, file);
}

let files = 0;
for (const name of readdirSync("bundles")) {
  if (!name.endsWith(".json")) continue;
  files++;
  try {
    walk(JSON.parse(readFileSync(join("bundles", name), "utf8")), name);
  } catch {
    /* a malformed bundle is lint:bundle-schema's business, not this one. */
  }
}

if (hits.length) {
  console.error(`[lint:platform-owned-roles] ✗ ${hits.length} bundle field(s) claim a role the platform already owns:`);
  for (const h of hits) {
    console.error(`  ${h.file}: "${h.field}" declares field_role "${h.role}"`);
    console.error(`    ${fieldRoleOwnedMessage(h.role as FieldRole)}`);
  }
  process.exit(1);
}
console.log(
  `[lint:platform-owned-roles] ✓ no bundle field claims a platform-owned role (${files} bundles, owned roles: ${[...OWNED].join(", ") || "none"}).`,
);
