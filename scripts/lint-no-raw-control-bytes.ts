#!/usr/bin/env tsx
// No raw control bytes (NUL, etc.) in source files.
//
//   npx tsx scripts/lint-no-raw-control-bytes.ts   (npm run lint:control-bytes)
//
// A literal NUL byte in a .ts file — someone typed a control character as a
// delimiter instead of writing the `\x00` escape — makes `grep` and `rg` treat
// the ENTIRE file as binary and silently return zero matches. That is exactly how
// api/src/index.ts (the boot chain) became un-greppable: searching it for the
// function that boots the app returned nothing, with no error, for months.
//
// The escape `\x00` compiles to the identical byte at runtime, so this costs
// nothing — it only forbids the raw form that breaks tooling.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN = ["api/src", "web/src", "modules", "packages", "scripts"].map((d) => join(ROOT, d));
// NUL + the C0 control range, minus tab (\t=9), newline (\n=10), CR (\r=13).
const BAD = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;

const offenders: string[] = [];
function walk(dir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "dist") continue;
      walk(p);
    } else if (/\.(ts|tsx|mjs|js|json|md|sql|css|yml|yaml)$/.test(name)) {
      const buf = readFileSync(p);
      const m = BAD.exec(buf.toString("latin1"));
      if (m) {
        const line = buf.toString("latin1").slice(0, m.index).split("\n").length;
        offenders.push(`${relative(ROOT, p)}:${line}  (byte 0x${m[0].charCodeAt(0).toString(16).padStart(2, "0")})`);
      }
    }
  }
}
for (const d of SCAN) walk(d);

if (offenders.length === 0) {
  console.log("[lint:control-bytes] ✓ no raw control bytes in source (a NUL makes a whole file read as binary to grep).");
  process.exit(0);
}
console.error(
  `\n[lint:control-bytes] ✗ ${offenders.length} file(s) contain a RAW control byte — this makes grep/rg treat the whole file as binary and silently skip it. Write the escape (\\x00, \\t, …) instead:`,
);
for (const o of offenders) console.error(`  ${o}`);
process.exit(1);
