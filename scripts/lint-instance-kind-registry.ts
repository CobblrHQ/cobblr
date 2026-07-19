// Guard: an INSTANCE kind must never be handed to a registry keyed by MODULE kinds.
//
// A workspace can name several instances of one module — a "supplies" and a
// "yarn" instance of `inventory`. Those get their own kind string
// (`supplies:item`), synthesized per-org at read time and NEVER written to
// `entity_kinds`. So every registry keyed by kind — actions, traits, and the
// event payload-key convention — misses on one and returns nothing. Not an
// error. Nothing. That is what makes this class so expensive:
//
//   - Every instance wire in every bundle was dead. `sourceIdKey("supplies:item")`
//     derived "itemId" while inventory's emitter sent "partId", so the id was
//     never found, the target set came out empty, and the wire silently did not
//     fire. Household Supplies promised "running low → shopping list" and
//     simply didn't do it (2026-07-19).
//   - `listApplicable` returned [] for any instance kind, so the wire composer's
//     Do… dropdown was empty and generated apps rendered no action buttons.
//   - Confirming a vehicle from the scan inbox 400'd on `assets:vehicles:item`.
//
// The rule this enforces is the narrow, mechanical one: the payload-key
// convention. `sourceIdKey()` turns a kind into the key emitters publish an id
// under, so BOTH ends must agree on the module's key, never an instance's.
// Every call must therefore take a string literal or a `baseKindOf(...)` result.
//
// Run: npx tsx scripts/lint-instance-kind-registry.ts

import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["api/src", "modules", "packages/platform-contract/src"];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules" || name === "dist" || name === "tests") continue;
      out.push(...sourceFiles(p));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const failures: string[] = [];
let calls = 0;

for (const root of ROOTS) {
  for (const file of sourceFiles(root)) {
    const src = readFileSync(file, "utf8");
    if (!src.includes("sourceIdKey(")) continue;
    // Names bound to a baseKindOf(...) result anywhere in the file — the
    // resolution usually happens a line or two above the call.
    const resolved = new Set(
      [...src.matchAll(/\b(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=[^;]*baseKindOf\s*\(/g)].map(
        (m) => m[1]!,
      ),
    );
    src.split("\n").forEach((line, i) => {
      const trimmed = line.trim();
      // Prose mentions the helper by name constantly; only code counts.
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
      const m = /\bsourceIdKey\(\s*([^)]*)\)/.exec(line);
      if (!m) return;
      // The declaration itself, not a call.
      if (/function sourceIdKey/.test(line)) return;
      const arg = (m[1] ?? "").trim();
      if (!arg) return; // no argument to judge
      calls++;
      const isLiteral = /^["'`]/.test(arg);
      const isBaseResolved =
        /baseKindOf/.test(arg) || resolved.has(arg.replace(/^await\s+/, ""));
      if (!isLiteral && !isBaseResolved) {
        failures.push(
          `${file}:${i + 1}: sourceIdKey(${arg}) — a raw kind. An instance kind ` +
            `("supplies:item") yields "itemId" while the module's emitter sends ` +
            `"partId", so the key misses and the wire silently never fires. ` +
            `Wrap it: sourceIdKey(await baseKindOf(orgId, ${arg}))`,
        );
      }
    });
  }
}

if (failures.length) {
  console.error("✗ lint-instance-kind-registry: raw kind passed to the payload-key convention:");
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(
  `✓ instance-kind-registry lint: ${calls} sourceIdKey call(s), all literal or base-kind resolved`,
);
process.exit(0);
