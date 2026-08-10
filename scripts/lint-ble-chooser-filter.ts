// The BLE device chooser must stay FILTERED to printers.
//
// `acceptAllDevices: true` lists every Bluetooth object in range — headphones,
// phones, a neighbour's TV — and makes the user find their printer in that pile
// (reported 2026-07, comparing us unfavourably with niim.blue). It is a one-word
// change that silently undoes the filtering, and nothing else would catch it.
//
// requestPrinter() in packages/thermal-print/src/ble.ts is the ONE place allowed
// to say it, because it owns both the filtered path and the deliberate
// `{ all: true }` escape hatch for printers that advertise nothing recognisable.
import { readFileSync } from "node:fs";
import { sourceFiles } from "./lib/glob-exclude.mjs";

const ALLOWED = "packages/thermal-print/src/ble.ts";
// globSync hands `exclude` the DIRECTORY paths it walks, with no trailing slash
// ("packages/thermal-print/dist"), so a substring test for "/dist/" never matched and
// this exclusion did nothing at all.
//
// CI's clean tree hid it: with no local build there are no generated files to scan.
// Build locally and the .d.ts files come into scope, and a DOC COMMENT in
// packages/thermal-print/dist/ble.d.ts mentions acceptAllDevices. That failed the lint
// and, through the pre-push hook, blocked every push (2026-08-10, mid-release).
//
// Matching on path SEGMENTS works for a directory and a file alike.
const files = sourceFiles("{packages,modules,web,api}/**/*.{ts,tsx}");

const offenders: string[] = [];
for (const f of files) {
  if (f === ALLOWED) continue;
  const src = readFileSync(f, "utf8");
  src.split("\n").forEach((line, i) => {
    if (line.includes("acceptAllDevices")) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
  });
}

if (offenders.length) {
  console.error(
    "[lint:ble-chooser] acceptAllDevices outside requestPrinter — the chooser must be\n" +
      "filtered to printers. Use requestPrinter(services, { namePrefixes }) instead, and\n" +
      `pass { all: true } only for the user's explicit "I don't see my printer" fallback.\n`,
  );
  for (const o of offenders) console.error("  " + o);
  process.exit(1);
}
console.log(`lint:ble-chooser: chooser stays filtered (${files.length} files scanned) ✓`);
