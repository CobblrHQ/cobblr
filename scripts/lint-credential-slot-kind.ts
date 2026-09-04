// lint:credential-slot-kind — asking about a workspace's ACTIVE default
// connection must say which KIND of connection it means.
//
// `user_credential_orgs` holds every kind of connection a person can attach: an
// AI provider, a parcel-tracking bridge, whatever a module registers. Within it,
// `mode: workspace-default` + `active` means "the one this workspace uses" - of
// its own kind. Nothing in the schema says "of its own kind", so four separate
// queries asked the question across all kinds at once and got a confident wrong
// answer.
//
// What that cost, found on the hosted deployment 2026-09-04: a workspace held a
// Gemini key (approved, idle) and a parcel bridge (active). The bridge answered
// every "does this workspace already have one?", so the AI never went live and
// the workspace reported no AI connected - including to the heal written to fix
// exactly that state, which skipped the one workspace that needed it. The same
// conflation ran the other way: choosing an AI cleared `active` on every
// workspace-default row, switching the parcel bridge off as a side effect.
//
// So: a statement that filters on BOTH `workspace-default` and `active` must
// also constrain `kind`. The statement boundary is the terminating `.execute(`
// / `.executeTakeFirst(`, which is where a Kysely chain ends.

import { readFileSync, globSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const files = globSync("api/src/**/*.ts", { cwd: ROOT }).filter((f) => !f.endsWith(".test.ts"));

const problems: string[] = [];
for (const rel of files) {
  const src = readFileSync(`${ROOT}/${rel}`, "utf8");
  if (!src.includes("user_credential_orgs")) continue;
  // Split into statements at the chain terminators.
  const parts = src.split(/\.execute(?:TakeFirst)?\(\)/);
  let consumed = 0;
  for (const part of parts) {
    const stmtStart = consumed;
    consumed += part.length + 1;
    // A real Kysely chain over this table, not prose that mentions it. The
    // chunk before the first .execute() is the file header, and a schema file
    // is all doc comments; both matched a looser test.
    if (!/\.(?:selectFrom|updateTable|deleteFrom)\(\s*"user_credential_orgs/.test(part)) continue;
    if (!/\.where\(\s*"mode",\s*"=",\s*"workspace-default"/.test(part)) continue;
    if (!/\.where\(\s*"active",\s*"=",\s*true\)/.test(part)) continue;
    if (/lint-credential-slot-kind-ok/.test(part)) continue;
    // The chain names a kind, either directly or through the helper.
    if (/"kind"|credentialIdsOfKind|kindOfCredential/.test(part)) continue;
    const line = src.slice(0, stmtStart).split("\n").length;
    problems.push(`${rel}:${line}`);
  }
}

if (problems.length) {
  console.error("lint:credential-slot-kind FAILED\n");
  console.error("  A query about the workspace's ACTIVE default connection must say which KIND.");
  console.error("  Without it a parcel bridge answers \"does this workspace have an AI?\" with yes.\n");
  for (const p of problems) console.error(`  ✗ ${p}  (filters workspace-default + active, names no kind)`);
  console.error("\n  Scope it: .where(\"credential_id\", \"in\", credentialIdsOfKind(kind))");
  console.error("  or join user_credentials and filter c.kind.");
  console.error("  Genuinely kind-agnostic? say // lint-credential-slot-kind-ok and why.");
  process.exit(1);
}
console.log("lint:credential-slot-kind OK — every active-default query names the kind it means.");
