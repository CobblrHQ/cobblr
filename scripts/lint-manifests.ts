// Guard: every module's manifest must pass defineModule's schema validation.
//
// The trap (core-mobility's assets slice hit it): a manifest can typecheck
// clean yet be INVALID against the runtime schema — e.g. `exposableFields`
// lists a field name that isn't declared in `provides.entityKinds[].fields`.
// TypeScript can't catch this (both are just `string`s); the check is a runtime
// zod refinement inside defineModule. So the error only surfaced when the API
// BOOTED in the `test` CI job — where one bad manifest makes the loader skip
// the WHOLE module, and dozens of unrelated tests go red with a confusing
// "module not registered" instead of the real "invalid manifest" cause.
//
// This lint imports every modules/<name>/src/module.ts (which runs
// defineModule and throws on an invalid manifest) and reports the FIRST failure
// per module with its real reason. Runs at pre-push + in the CI gate — same
// validation the loader does at boot, just moved left. Importing only evaluates
// the manifest literal; the module's `api()` thunk stays lazy, so this is a
// pure validation with no side effects.
//
// Run: npx tsx scripts/lint-manifests.ts

import { readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MODULES_DIR = "modules";

async function main(): Promise<void> {
  const modules = readdirSync(MODULES_DIR).filter((d) => {
    if (d.startsWith(".")) return false;
    const p = join(MODULES_DIR, d);
    return statSync(p).isDirectory() && existsSync(join(p, "package.json"));
  });

  const failures: Array<{ module: string; reason: string }> = [];

  for (const m of modules) {
    const entry = resolve(MODULES_DIR, m, "src", "module.ts");
    if (!existsSync(entry)) {
      // A module whose manifest source isn't at the conventional path — the
      // loader resolves package.json#main (dist) too, but for the lint we only
      // validate the checked-in source. Skip quietly rather than false-fail.
      continue;
    }
    try {
      const mod = (await import(pathToFileURL(entry).href)) as { default?: { name?: string } };
      if (!mod.default || typeof mod.default !== "object") {
        failures.push({ module: m, reason: "no default export (expected a defineModule(...) manifest)" });
        continue;
      }
      if (!mod.default.name) {
        failures.push({ module: m, reason: "manifest has no `name`" });
      }
    } catch (err) {
      // defineModule throws a multi-line "Invalid module manifest for …" here.
      failures.push({ module: m, reason: (err as Error).message });
    }
  }

  if (failures.length > 0) {
    console.error(`manifest lint: ${failures.length} module manifest(s) FAILED validation:\n`);
    for (const f of failures) {
      console.error(`  ❌ ${f.module}`);
      for (const line of f.reason.split("\n")) console.error(`       ${line}`);
      console.error("");
    }
    console.error(
      `A manifest that fails here would make the loader SKIP the whole module at\n` +
        `boot — every route/kind/action it owns vanishes, and unrelated tests fail\n` +
        `with "module not registered". Fix the manifest (e.g. every name in\n` +
        `exposableFields must be a declared field in provides.entityKinds[].fields,\n` +
        `or an implicit prop: id/title/subtitle/image_path/detailUrl).`,
    );
    process.exit(1);
  }

  console.log(`manifest lint: all ${modules.length} module manifest(s) valid ✓`);
}

void main();
