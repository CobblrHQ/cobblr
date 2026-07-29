// Guard: the virtual BLE adapter must never be reachable in a shipped app.
//
// ble-bench.ts replaces navigator.bluetooth with a fake. That is exactly what
// makes it useful for driving the browser-BLE path without hardware, and
// exactly why it must not be present in a page a real user loads: a printer
// that silently is not their printer is worse than no printer, and a page that
// can be talked into faking hardware is a support nightmare nobody will
// diagnose from a screenshot.
//
// The rule is simple and checkable: NOTHING in the shipped web app or in any
// module may import it. It exists for tests and for the bench tooling, which
// install it deliberately and put the page back afterwards.
//
// A lint rather than a build-time flag because the failure mode is an ordinary
// import someone adds while debugging and forgets to remove — a flag would not
// notice, and the import is the thing that makes it shippable.
//
// Run: npx tsx scripts/lint-bench-not-shipped.ts

import { readFileSync, globSync } from "node:fs";

const FORBIDDEN = /["']([^"']*\/)?ble-bench(\.js)?["']/;

// Shipped surfaces: the web app, and every module's UI + api. Tests are exempt —
// installing it is their job — and so is the thermal package that owns it.
const files = [
  ...globSync("web/src/**/*.{ts,tsx}"),
  ...globSync("modules/*/src/**/*.{ts,tsx}"),
  ...globSync("packages/platform-web/src/**/*.{ts,tsx}"),
].filter((f) => !f.includes(".test.") && !f.includes("__tests__"));

const offenders: Array<{ file: string; line: number; text: string }> = [];
for (const file of files) {
  readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*")) return;
    if (/\b(import|require)\b/.test(t) && FORBIDDEN.test(t)) {
      offenders.push({ file, line: i + 1, text: t.slice(0, 100) });
    }
  });
}

if (offenders.length > 0) {
  console.error("bench-not-shipped lint: the virtual BLE adapter is imported by shipped code.\n");
  for (const o of offenders) console.error(`    ❌ ${o.file}:${o.line}\n       ${o.text}`);
  console.error(
    "\n  ble-bench replaces navigator.bluetooth with a fake. In a page a real user" +
      "\n  loads, that is a printer which silently is not their printer." +
      "\n\n  Install it from a TEST, or from bench tooling that restores the page after.",
  );
  process.exit(1);
}

console.log(`bench-not-shipped lint: ${files.length} shipped files, no virtual-BLE import ✓`);
