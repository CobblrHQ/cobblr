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

console.log(`print-driver-options lint: dropdown matches DRIVER_KINDS (${kinds.join(", ")}) ✓`);
