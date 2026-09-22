#!/usr/bin/env tsx
// The dark theme's line colour reads on BOTH grounds it is drawn on: at least a quiet hairline against the page (canvas) and against a card (surface), and the dark:border-slate-700 lift is the same colour as the token.
//
// THE BUG THIS PREVENTS. A field or an outline button on the page ground in
// dark had no visible box: the line token (--c-line) and the slate-700 border
// most components pair both matched the page within 1.03:1, so "search
// types...", the selects beside it and "Set location" read as bare text on the
// page (#3232, from the #3222 phone walk, 2026-09-22). On a card the same
// elements were fine, because the card is the lighter slate-900 and the line
// sat a hairline darker than it.
//
// THE RULE. Read from web/src/index.css and web/tailwind.config.js, never
// typed in here: the dark --c-line token, the dark --c-canvas and --c-surface
// tokens, and the `html.dark .dark\:border-slate-700` lift.
//   - the line's WCAG contrast against the canvas is at least LINE_FLOOR, and
//     against the surface at least LINE_FLOOR: a hairline you can find with
//     your eye on either ground (the light theme's line sits at 1.25 on the
//     page and 1.61 on a card, so 1.3 is "as quiet as light, never quieter");
//   - the lift rules for `dark:border-slate-700` and `dark:border-slate-600`
//     exist and name the same colour as the token, so the ~1000 explicit
//     borders and the token cannot drift apart (the muted-text lift is the
//     precedent; the palette's 600 and 700 are both within 1.25:1 of the page).
// A genuine change of taste changes the numbers in index.css; nothing opts out
// here, because a line nobody can see is not a style.
//
// PROVE IT RED: on the values before #3232 (line 38 43 51 on canvas 30 41 59)
// the canvas contrast is 1.03 and this fails; that run is recorded in the PR.
//
//   npx tsx scripts/lint-dark-line-reads.ts   (pnpm run lint:dark-line-reads)
import { readFileSync } from "node:fs";

const CSS = "web/src/index.css";
const LINE_FLOOR = 1.3;

const css = readFileSync(CSS, "utf8");

/** The dark token block: `html.dark:not([data-ws-themed]) { ... }`. */
function darkToken(name: string): [number, number, number] {
  const block = css.match(/html\.dark:not\(\[data-ws-themed\]\)\s*\{([\s\S]*?)\}/);
  if (!block) throw new Error(`${CSS}: the dark token block is missing`);
  const m = block[1]!.match(new RegExp(`--${name}:\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)`));
  if (!m) throw new Error(`${CSS}: --${name} is not set in the dark token block`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function luminance([r, g, b]: [number, number, number]): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

const problems: string[] = [];
const line = darkToken("c-line");
const canvas = darkToken("c-canvas");
const surface = darkToken("c-surface");
const onPage = contrast(line, canvas);
const onCard = contrast(line, surface);
if (onPage < LINE_FLOOR) problems.push(`--c-line (${line.join(" ")}) against the dark page (${canvas.join(" ")}) is ${onPage.toFixed(2)}:1; a line needs at least ${LINE_FLOOR}:1 to be found by eye`);
if (onCard < LINE_FLOOR) problems.push(`--c-line (${line.join(" ")}) against a dark card (${surface.join(" ")}) is ${onCard.toFixed(2)}:1; a line needs at least ${LINE_FLOOR}:1 to be found by eye`);

// The lift: one rule whose selector list names both shades, or one rule each.
for (const shade of ["700", "600"]) {
  const rule = css.match(new RegExp(`html\\.dark\\s+\\.dark\\\\:border-slate-${shade}\\b[^{]*\\{\\s*border-color:\\s*(#[0-9a-fA-F]{6})`));
  if (!rule) { problems.push(`${CSS}: no \`html.dark .dark\\:border-slate-${shade} { border-color: #… }\` lift; those explicit borders would sit at the old shade while the token moved`); continue; }
  const lifted = hexToRgb(rule[1]!);
  if (lifted.join(" ") !== line.join(" ")) problems.push(`the dark:border-slate-${shade} lift is ${rule[1]} (${lifted.join(" ")}) but --c-line is ${line.join(" ")}; they must be one colour`);
}

if (problems.length) {
  console.error(`lint:dark-line-reads - ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  console.error("Set the dark --c-line in web/src/index.css to a shade that reads on both grounds, and keep the dark:border-slate-700 lift equal to it.");
  process.exit(1);
}
console.log(`lint:dark-line-reads OK - dark line ${onPage.toFixed(2)}:1 on the page, ${onCard.toFixed(2)}:1 on a card, lift matches`);
