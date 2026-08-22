#!/usr/bin/env tsx
// A control that only exists on hover does not exist on a phone.
//
// `opacity-0 group-hover:opacity-100` looks like "fade in on hover". This
// project runs Tailwind with `hoverOnlyWhenSupported`, so every `hover:` and
// `group-hover:` variant is wrapped in `@media (hover: hover)` — and on a touch
// screen the reveal half never applies. The element stays at opacity 0 for
// good. Not dim: gone. Twenty-two controls were unreachable that way, the
// delete button on every row of four modules among them.
//
// AskCobbAbout's comment already stated the rule — "a control that appears on
// hover is one a phone in a workshop cannot reach" — which is why this is a
// lint and not another paragraph.
//
// Use `.hover-reveal` (web/src/index.css): visible by default, hidden only
// where hover exists, and shown on keyboard focus.
//
// An image OVERLAY on a tile that is itself tappable is the exception — the
// tile is the control and the overlay is decoration. Say so on the line:
//   // TOUCH-OK: <why>
//
// Run: npx tsx scripts/lint-touch-reachable.ts

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const STRINGS = /"[^"\n]*"|'[^'\n]*'|`[^`]*`/g;
const HIDDEN = /\bopacity-0\b/;
const REVEAL = /(?:group-)?hover:opacity-100/;
const ALLOW = /TOUCH-OK:/;

const files: string[] = [];
for (const r of ["web/src", "packages/platform-web/src", "modules"]) {
  try {
    (function walk(dir: string) {
      for (const e of readdirSync(join(ROOT, dir))) {
        if (e === "node_modules" || e === "dist" || e.startsWith(".")) continue;
        const rel = join(dir, e);
        if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
        else if (rel.endsWith(".tsx")) files.push(rel);
      }
    })(r);
  } catch { /* optional tree */ }
}

const bad: string[] = [];
for (const rel of files) {
  const lines = readFileSync(join(ROOT, rel), "utf8").split("\n");
  lines.forEach((line, i) => {
    // Two lines of lead-in, because a marker worth reading rarely fits on one.
    const context = [lines[i - 2], lines[i - 1], line].filter(Boolean).join("\n");
    if (ALLOW.test(context)) return;
    for (const lit of line.match(STRINGS) ?? []) {
      if (HIDDEN.test(lit) && REVEAL.test(lit)) {
        bad.push(`${rel}:${i + 1}  ${lit.slice(0, 78)}`);
      }
    }
  });
}

if (bad.length) {
  console.error("[lint:touch-reachable] ✗ invisible until hover — unreachable on a touch screen:\n");
  for (const b of bad) console.error("  " + b);
  console.error(
    "\n  Use `hover-reveal` instead of `opacity-0 group-hover:opacity-100`.\n" +
      "  It is visible by default, hides only where hover exists, and shows on keyboard focus.\n" +
      "  An overlay on an already-tappable tile is the exception: mark it `// TOUCH-OK: <why>`.",
  );
  process.exit(1);
}
console.log(`lint:touch-reachable ✓ ${files.length} files, no control hides behind hover alone.`);
