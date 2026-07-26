// Guard: the printer form's Driver dropdown must offer EXACTLY core-print's
// DRIVER_KINDS — no more, no fewer.
//
// The trap this catches: an option value is just a string, so TypeScript, the
// tests and every other lint are perfectly happy with a dropdown that offers a
// driver the API rejects. The user picks it, fills the form, hits save, and gets
// "unknown driver 'x'" — a dead end that looks like a server bug.
//
// This shipped for real: when the `edge` driver kind was removed (routing through
// a bridge became a TRANSPORT, chosen by a cobblr-edge:// manager URL, not a
// driver), the <option value="edge"> stayed behind in the form. A comment saying
// "keep these in sync" was left in its place; a comment reminds one person, this
// stops everyone.
//
// The reverse direction matters too: a driver kind the API accepts but the form
// never offers is unreachable from the UI, which is how a shipped feature ends up
// curl-only.
// Run: npx tsx scripts/lint-print-driver-options.ts

import { readFileSync } from "node:fs";

const REGISTRY = "modules/core-print/src/drivers/registry.ts";
const FORM = "web/src/pages/PrintPage.tsx";

const registry = readFileSync(REGISTRY, "utf8");
const kindsMatch = /export const DRIVER_KINDS = \[([^\]]*)\]/.exec(registry);
if (!kindsMatch) {
  console.error(`print-driver-options lint: could not find DRIVER_KINDS in ${REGISTRY}.`);
  console.error(`If it moved or was renamed, update this lint — do not delete it.`);
  process.exit(1);
}
const kinds = [...kindsMatch[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);

// Scope to the Driver <select> specifically; the form has other selects (command
// dialect, orientation) whose values are unrelated to driver kinds.
const form = readFileSync(FORM, "utf8");
const selectStart = form.indexOf("value={driver}");
if (selectStart === -1) {
  console.error(`print-driver-options lint: could not find the driver <select> (value={driver}) in ${FORM}.`);
  process.exit(1);
}
const selectEnd = form.indexOf("</select>", selectStart);
const block = form.slice(selectStart, selectEnd);
const offered = [...block.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]!);

const dead = offered.filter((o) => !kinds.includes(o));      // form offers, API rejects
const missing = kinds.filter((k) => !offered.includes(k));   // API accepts, form hides

if (dead.length > 0 || missing.length > 0) {
  console.error(`print-driver-options lint: the Driver dropdown does not match DRIVER_KINDS.\n`);
  if (dead.length > 0) {
    console.error(`  Offered by the form but REJECTED by the API (saving 400s):`);
    for (const d of dead) console.error(`    ❌ <option value="${d}">`);
  }
  if (missing.length > 0) {
    console.error(`  Accepted by the API but NOT offered in the form (unreachable from the UI):`);
    for (const m of missing) console.error(`    ❌ ${m}`);
  }
  console.error(
    `\n  DRIVER_KINDS (${REGISTRY}): ${kinds.join(", ")}` +
      `\n  form options  (${FORM}): ${offered.join(", ")}` +
      `\n\nFix whichever side is wrong. A driver kind is only real if the API accepts it` +
      `\nAND the form offers it.`,
  );
  process.exit(1);
}

// Third direction: code that CREATES printers with a hardcoded driver string.
// The dropdown check above cannot see these — the serial connect flow shipped
// `driver: "browser-serial"` from two pages while the registry lacked the kind,
// so every save 400d as an unknown driver, and only a live click could reveal
// it. A driver literal in a create/update call must name a registered kind.
import { globSync } from "node:fs";

const literalFindings: string[] = [];
for (const pattern of ["web/src/**/*.tsx", "web/src/**/*.ts", "modules/*/src/**/*.tsx", "modules/*/src/**/*.ts"]) {
  for (const file of globSync(pattern, { cwd: process.cwd() })) {
    if (file.includes("core-print/src/drivers")) continue;   // the registry itself
    const src = readFileSync(file, "utf8");
    // "driver" is an overloaded word (backup drivers, machine drivers), so only
    // literals inside a createPrinter(...) call are in scope.
    for (const call of src.matchAll(/createPrinter\s*\(/g)) {
      const window = src.slice(call.index ?? 0, (call.index ?? 0) + 800);
      const m = /\bdriver:\s*"([^"]+)"/.exec(window);
      if (!m) continue;
      const kind = m[1]!;
      if (kinds.includes(kind)) continue;
      const line = src.slice(0, (call.index ?? 0) + m.index).split("\n").length;
      literalFindings.push(`    ❌ ${file}:${line}  driver: "${kind}"`);
    }
  }
}
if (literalFindings.length > 0) {
  console.error(`print-driver-options lint: driver literals that the API will reject:\n`);
  for (const f of literalFindings) console.error(f);
  console.error(`\n  DRIVER_KINDS: ${kinds.join(", ")}` +
    `\n  Creating a printer with an unregistered driver 400s at save. Register the` +
    `\n  kind in ${REGISTRY} (and the form dropdown) or fix the literal.`);
  process.exit(1);
}

console.log(`print-driver-options lint: dropdown + driver literals match DRIVER_KINDS (${kinds.join(", ")}) ✓`);
