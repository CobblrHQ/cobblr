// Both browser print drivers must be handled together.
//
// THE BUG THIS EXISTS FOR, three times over. `browser-serial` was added beside
// `browser-bluetooth` as a second way to reach the same class of device — a roll
// label printer the server cannot touch. Every place that had branched on
// `browser-bluetooth` alone then quietly meant "Bluetooth only":
//
//   * the printer form gated its thermal fields on it, so editing a serial
//     printer demanded a manager URL and dropped its media settings on save;
//   * the label-size funnel gated roll media on it, so a freshly connected
//     serial printer defaulted to "US Letter 8.5 x 11, 2x2 square, 20 up";
//   * auto-print and the browser-print toolbar gate ignored serial printers
//     entirely.
//
// None of it was type-visible: `driver` is a string, so every check compiled and
// every test passed. The class is "a new member of a closed set was added and
// the existing branches were not swept", and a lint is the only thing that sees
// it.
//
// THE RULE: a source line comparing driver to "browser-bluetooth" must mention
// "browser-serial" nearby (same line, or within a couple of lines for a
// multi-line condition). Deliberate Bluetooth-only code opts out with an
// explicit `// bluetooth-only:` note saying why.

import { readFileSync, globSync } from "node:fs";

const ROOTS = ["web/src/**/*.ts", "web/src/**/*.tsx", "modules/*/src/**/*.ts", "modules/*/src/**/*.tsx", "packages/*/src/**/*.ts", "packages/*/src/**/*.tsx"];
const NEAR = 3;   // lines of context in which the sibling may appear

const findings: string[] = [];

for (const pattern of ROOTS) {
  for (const file of globSync(pattern, { cwd: process.cwd() })) {
    if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      // Only comparisons, not prose or a driver-kind list.
      if (!/["']browser-bluetooth["']/.test(line)) return;
      if (!/[=!]==\s*["']browser-bluetooth["']|["']browser-bluetooth["']\s*[=!]==/.test(line)) return;
      const window = lines.slice(Math.max(0, i - NEAR), i + NEAR + 1).join("\n");
      if (/browser-serial/.test(window)) return;
      if (/bluetooth-only:/i.test(window)) return;
      findings.push(`  ${file}:${i + 1}  ${line.trim().slice(0, 100)}`);
    });
  }
}

if (findings.length) {
  console.error("[lint:browser-driver-pairs] ✗ these branch on browser-bluetooth without browser-serial:\n");
  for (const f of findings) console.error(f);
  console.error(
    "\n  Both are browser-driven ROLL label printers the server cannot reach; they\n" +
    "  differ only in which browser API carries the bytes. A check that names one\n" +
    "  almost always means both — that gap has shipped three separate bugs.\n" +
    "  Handle both, or add `// bluetooth-only: <reason>` if the difference is real\n" +
    "  (e.g. code touching a GATT characteristic).\n",
  );
  process.exit(1);
}

console.log("[lint:browser-driver-pairs] ✓ browser driver kinds are handled together");
