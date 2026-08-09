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
import { globSync } from "node:fs";

const ALLOWED = "packages/thermal-print/src/ble.ts";
const files = globSync("{packages,modules,web,api}/**/*.{ts,tsx}", {
  exclude: (p) => p.includes("node_modules") || p.includes("/dist/"),
});

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
