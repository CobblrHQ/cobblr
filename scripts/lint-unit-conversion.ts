// Guard: UNIT CONVERSION belongs to core-units, nowhere else. A module, route,
// importer, or UI must NOT hand-roll a conversion (a magic factor, a `*_TO_*`
// constant, metre/yard/inch/pound arithmetic). Store the RAW value + its unit and
// let core-units (`convertQuantity`) + the field's declared unit + the viewer's
// preference convert on DISPLAY.
//
// Why this exists: `ravelry-import.ts` converted `yards * YD_TO_M` inline at
// import time — reimplementing a platform capability in a module, and freezing a
// unit choice the units system is meant to own. That's the class this catches.
//
// Text-based + low-false-positive, like the other lints (no deps, no build):
//   A. `*_TO_*` conversion constants (YD_TO_M, MM_TO_IN) — near-zero FP.
//   B. the exact canonical SI factors from units-catalog.ts, but ONLY when used
//      in arithmetic (adjacent to `*` or `/`) — so a coincidental decimal that
//      isn't a conversion doesn't trip it.
// The ONLY allowed home is modules/core-units/ (the unit vocabulary + convert).
//
// Run: npx tsx scripts/lint-unit-conversion.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join, relative } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const ROOTS = ["modules", "api/src", "web/src", "packages"];
// core-units OWNS conversion; tests/scripts that assert the lint or fixtures are
// exempt. Paths are repo-relative prefixes.
const ALLOW_PREFIXES = ["modules/core-units/", "scripts/lint-unit-conversion.ts"];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e === "dist" || e === ".vite" || e === "migrations") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(p) && !p.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

// Strip comments so a doc line mentioning a factor isn't flagged as code.
const stripComments = (s: string) => s.replace(/\/\*[^]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

// A. conversion-constant identifiers: FOO_TO_BAR.
const TO_CONST = /\b[A-Z][A-Z0-9]{0,15}_TO_[A-Z][A-Z0-9]{0,15}\b/g;

// B. canonical SI factors (from units-catalog.ts) — length, mass, volume.
const FACTORS = [
  "0.9144", "0.3048", "0.0254", "1609.344", // yard/foot/inch/mile → metre
  "0.45359237", "453.59237", "28.349523125", // pound/ounce → kg/gram
  "3785.411784", "0.473176473", "29.5735295625", // gallon/pint/floz → mL/L
];
// factor immediately adjacent to a `*` or `/` (a conversion multiply/divide).
const FACTOR_RE = new RegExp(
  "(?:[*/]\\s*(?:" +
    FACTORS.map((f) => f.replace(/\./g, "\\.")).join("|") +
    ")\\b)|(?:\\b(?:" +
    FACTORS.map((f) => f.replace(/\./g, "\\.")).join("|") +
    ")\\s*[*/])",
  "g",
);

const violations: string[] = [];

for (const root of ROOTS) {
  for (const file of walk(join(ROOT, root))) {
    const rel = relative(ROOT, file);
    if (ALLOW_PREFIXES.some((p) => rel.startsWith(p) || rel === p.replace(/\/$/, ""))) continue;
    const src = stripComments(readFileSync(file, "utf8"));
    src.split("\n").forEach((line, i) => {
      const hit = line.match(TO_CONST) || line.match(FACTOR_RE);
      if (hit) violations.push(`${rel}:${i + 1}  ${line.trim().slice(0, 100)}   [${hit[0].trim()}]`);
    });
  }
}

if (violations.length) {
  console.error(
    "lint-unit-conversion: hand-rolled unit conversion found OUTSIDE core-units.\n" +
      "Conversion is core-units' job — store the raw value + its unit and convert on\n" +
      "display via convertQuantity + the view preference. Move this into core-units,\n" +
      "or store the value unconverted.\n",
  );
  for (const v of violations) console.error("  " + v);
  process.exit(1);
}
console.log("lint-unit-conversion: clean — no conversion math outside core-units.");
