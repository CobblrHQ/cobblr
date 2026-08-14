#!/usr/bin/env tsx
/**
 * lint:shipments-one-door — a carrier driver is reached through ONE path.
 *
 * core-shipments' rules live in the `core-shipments.track` action handler: is
 * this parcel even due, is it finished, how does the carrier's date rank
 * against the estimate the caller already had. A second caller that reaches
 * `driver.track()` directly gets NONE of them, and gets them silently.
 *
 * That shipped once. The HTTP /status route called the driver straight, so
 * opening an order that the user had already confirmed still spent a call on a
 * carrier -- metered on a real service, a page render behind a local bridge,
 * and pointless in both cases because the parcel was finished.
 *
 * The rule: only the action handler may invoke a driver. Everything else goes
 * through `platform().actions.invoke("core-shipments:track", …)`.
 *
 * Run: npx tsx scripts/lint-shipments-one-door.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const DIR = "modules/core-shipments/src";
/** The one file allowed to call a driver, plus the drivers themselves. */
const ALLOWED = [`${DIR}/api/action-handlers.ts`, `${DIR}/drivers/`];
const CALL = /\.track\s*\(/;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${e}`;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (rel.endsWith(".ts")) out.push(rel);
  }
  return out;
}

const offenders: string[] = [];
for (const file of walk(DIR)) {
  if (ALLOWED.some((a) => file.startsWith(a))) continue;
  const src = readFileSync(join(ROOT, file), "utf8");
  src.split("\n").forEach((line, i) => {
    if (CALL.test(line) && !line.trim().startsWith("//") && !line.includes("one-door ok")) {
      offenders.push(`${file}:${i + 1}  ${line.trim().slice(0, 90)}`);
    }
  });
}

if (offenders.length > 0) {
  console.error("lint:shipments-one-door FAILED — a driver is reached outside the action handler:\n");
  for (const o of offenders) console.error(`  ${o}`);
  console.error(
    "\nThe cadence, the confirmed check and the ETA ranking all live in the action.\n" +
      'Call platform().actions.invoke("core-shipments:track", …) instead, or mark a\n' +
      "genuine exception with `one-door ok` on the line.",
  );
  process.exit(1);
}
console.log("lint:shipments-one-door OK (drivers reached only through the action)");
