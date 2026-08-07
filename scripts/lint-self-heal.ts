// Guard: the default-module SELF-HEAL must stay defined AND wired into boot.
//
// A `foundational`/`autoEnable` capability's migrations run only for workspaces
// that existed when it shipped; older workspaces never get it and 500 on the
// first op touching its tables (`relation "<x>" does not exist`). The platform
// covers this with `reconcileDefaultModules()` in boot() — see CLAUDE.md §8.1.
//
// That generic reconcile makes the bug impossible to reintroduce *per module*
// (it heals every foundational/autoEnable module a workspace lacks) — so the ONE
// way the whole class comes back is if the reconcile is removed, unexported, or
// quietly unwired from boot. This lint fails if any of that happens, and checks
// the coverage filter still keys on BOTH band:foundational and autoEnable (so it
// can't be silently narrowed). Run: npx tsx scripts/lint-self-heal.ts

import { readFileSync } from "node:fs";

const ENABLE = "api/src/modules/enable.ts";
const INDEX = "api/src/index.ts";
const FN = "reconcileDefaultModules";
// Second reconcile guarded here for the same reason: per-tenant Postgres roles
// are cluster-global, so a deleted workspace leaks `tenant_<id>_user` unless
// something sweeps it, and the leak is invisible until roles pile up.
const ROLE_SWEEP_FILE = "api/src/platform/reconcile-tenant-roles.ts";
const ROLE_SWEEP_FN = "reconcileOrphanTenantRoles";

const errors: string[] = [];
const enable = readFileSync(ENABLE, "utf8");
const index = readFileSync(INDEX, "utf8");

// 1. Defined + exported in enable.ts.
if (!new RegExp(`export\\s+async\\s+function\\s+${FN}\\b`).test(enable)) {
  errors.push(`${ENABLE}: \`export async function ${FN}\` is missing — the self-heal is gone.`);
}

// 2. Its coverage filter still keys on BOTH band:foundational AND autoEnable, so
//    it can't be narrowed to silently drop capabilities from healing.
const body = enable.slice(enable.indexOf(`function ${FN}`));
const fnBody = body.slice(0, body.indexOf("\n}\n") + 1);
if (!/foundational/.test(fnBody) || !/autoEnable/.test(fnBody)) {
  errors.push(`${ENABLE}: ${FN} must heal both \`band: "foundational"\` and \`autoEnable: true\` modules — its filter looks narrowed.`);
}

// 3. Imported AND called in index.ts boot() — a definition that nobody calls
//    heals nothing.
if (!new RegExp(`import[^;]*\\b${FN}\\b[^;]*from\\s+["']\\./modules/enable`).test(index)) {
  errors.push(`${INDEX}: ${FN} is not imported from ./modules/enable — it won't run at boot.`);
}
if (!new RegExp(`\\b${FN}\\s*\\(`).test(index)) {
  errors.push(`${INDEX}: ${FN}() is never called in boot() — old workspaces won't self-heal. Add it to the reconcile chain.`);
}

// ── the tenant-role sweep (same class: an unwired reconcile heals nothing) ──
try {
  const sweep = readFileSync(ROLE_SWEEP_FILE, "utf8");
  if (!new RegExp(`export\\s+async\\s+function\\s+${ROLE_SWEEP_FN}\\b`).test(sweep)) {
    errors.push(`${ROLE_SWEEP_FILE}: ${ROLE_SWEEP_FN} must stay exported - it is the only thing that removes orphaned tenant_*_user roles.`);
  }
  if (!/DROP ROLE IF EXISTS/.test(sweep)) {
    errors.push(`${ROLE_SWEEP_FILE}: the sweep no longer issues DROP ROLE, so it heals nothing.`);
  }
  if (!/claimed\.has\(dbName\)/.test(sweep)) {
    errors.push(`${ROLE_SWEEP_FILE}: lost the org-row cross-check - a BROKEN workspace (db gone, org row present) must KEEP its role for a restore.`);
  }
} catch {
  errors.push(`${ROLE_SWEEP_FILE} is missing - deleted workspaces will leak their Postgres role again.`);
}
if (!new RegExp(`${ROLE_SWEEP_FN}\\(`).test(index)) {
  errors.push(`${INDEX}: ${ROLE_SWEEP_FN}() is not called in boot() - the sweep exists but never runs.`);
}
// The delete path must drop the role itself; the sweep is the backstop, not the
// primary mechanism (an instance that rarely reboots would accumulate orphans).
try {
  const del = readFileSync("api/src/platform/delete-org.ts", "utf8");
  if (!/DROP ROLE IF EXISTS/.test(del)) {
    errors.push("api/src/platform/delete-org.ts: no longer drops the tenant's own role - DROP DATABASE does not remove it (roles are cluster-global).");
  }
} catch {
  errors.push("api/src/platform/delete-org.ts is missing.");
}

if (errors.length > 0) {
  console.error("self-heal lint: a boot-time reconcile is broken —\n");
  for (const e of errors) console.error(`  ❌ ${e}`);
  console.error(
    `\nWithout it, workspaces created before a foundational/autoEnable capability\n` +
      `500 on every op touching that capability's tables. See CLAUDE.md §8.1.\n`,
  );
  process.exit(1);
}

console.log(`self-heal lint: ${FN} is defined, covers foundational + autoEnable, and is wired into boot ✓`);
