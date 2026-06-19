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

if (errors.length > 0) {
  console.error("self-heal lint: the default-module reconcile is broken —\n");
  for (const e of errors) console.error(`  ❌ ${e}`);
  console.error(
    `\nWithout it, workspaces created before a foundational/autoEnable capability\n` +
      `500 on every op touching that capability's tables. See CLAUDE.md §8.1.\n`,
  );
  process.exit(1);
}

console.log(`self-heal lint: ${FN} is defined, covers foundational + autoEnable, and is wired into boot ✓`);
