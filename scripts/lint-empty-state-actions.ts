// An action must not be reachable ONLY from an empty state.
//
// THE BUG THIS EXISTS FOR: the Printers page offered "Connect Bluetooth",
// "show all devices" and "connect as a serial port" inside a
// `items.length === 0 && (...)` block. The moment a workspace had one printer,
// all three vanished — so there was no way left to pair a second printer, and
// the serial route (the ONLY way to use a Bluetooth Classic printer) became
// unreachable entirely. The page still looked complete, because "Add printer"
// was still there; it just opened a manual form that could not pair anything.
//
// The class is general: onboarding affordances get written inside the
// zero-items branch, and then quietly become the only path to a capability.
//
// THE RULE: if a click handler is called inside an empty-state block, it must
// also be called somewhere outside one. Duplicating the action in a header, a
// menu or a per-row control all satisfy it. This does not object to empty-state
// UI — only to an empty state OWNING the sole route to an action.

import { readFileSync } from "node:fs";
import { globSync } from "node:fs";

const ROOTS = ["web/src/**/*.tsx", "modules/*/src/ui/**/*.tsx", "packages/*/src/**/*.tsx"];

/** `foo.length === 0 &&`, `!items.length &&`, `fooCount === 0 &&`. Ternary
 *  empty-states (`length === 0 ? A : B`) are NOT covered — the non-empty branch
 *  renders alongside, so the trapped-action failure mode does not apply. */
const EMPTY_GUARD = /(?:\w+(?:\.\w+)*)\.length\s*===\s*0\s*&&|!\s*\w+(?:\.\w+)*\.length\s*&&|\w+Count\s*===\s*0\s*&&/;

/** Identifier invoked from a handler: onClick={() => void connectX()} etc. */
const HANDLER_CALL = /\bvoid\s+(\w+)\s*\(|onClick=\{\s*(\w+)\s*\}|onClick=\{\(\)\s*=>\s*(\w+)\s*\(/g;

interface Finding {
  file: string;
  line: number;
  handler: string;
}

/** End of the block a guard opens, or -1 when the guard does not open one.
 *
 *  MUST be strict about where the block starts. A first attempt balanced from
 *  the guard and scanned forward for any opener, which for `x.length === 0 && (`
 *  followed later by unrelated JSX swallowed the rest of the component — every
 *  per-row handler below it then looked trapped in the empty state. Requiring
 *  the opener to be the very next token is what keeps the span honest. */
function blockEnd(src: string, guardEnd: number): number {
  let i = guardEnd;
  while (i < src.length && /\s/.test(src[i]!)) i++;
  const open = src[i];
  if (open !== "(" && open !== "{") return -1;   // inline condition, not a block
  const close = open === "(" ? ")" : "}";
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return src.length;
}

function handlersIn(chunk: string, declared: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const m of chunk.matchAll(HANDLER_CALL)) {
    const name = m[1] ?? m[2] ?? m[3];
    // Only component-level handlers count. Without this, `.set(...)` on a Map or
    // a local `copy(...)` helper inside a callback reads as a trapped action —
    // six such false positives on the first run, which would have made the lint
    // noise rather than a signal.
    if (!name || !declared.has(name)) continue;
    if (/^(set|toggle|open|close)[A-Z]/.test(name)) continue;
    out.add(name);
  }
  return out;
}

/** Handlers declared at component scope: `const doThing = () =>` / `async (`. */
function declaredHandlers(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(/^\s{0,4}const\s+(\w+)\s*=\s*(?:async\s*)?\(/gm)) out.add(m[1]!);
  return out;
}

const findings: Finding[] = [];

for (const pattern of ROOTS) {
  for (const file of globSync(pattern, { cwd: process.cwd() })) {
    const src = readFileSync(file, "utf8");
    if (!EMPTY_GUARD.test(src)) continue;

    // Collect every empty-state span in the file.
    const spans: [number, number][] = [];
    const re = new RegExp(EMPTY_GUARD.source, "g");
    for (const m of src.matchAll(re)) {
      const start = m.index ?? 0;
      const end = blockEnd(src, start + m[0].length);
      if (end > start) spans.push([start, end]);
    }
    if (!spans.length) continue;

    const declared = declaredHandlers(src);
    if (!declared.size) continue;

    const inside = new Set<string>();
    for (const [a, b] of spans) for (const h of handlersIn(src.slice(a, b), declared)) inside.add(h);
    if (!inside.size) continue;

    // Everything NOT inside an empty-state span.
    let outside = "";
    let cursor = 0;
    for (const [a, b] of spans.sort((x, y) => x[0] - y[0])) {
      if (a > cursor) outside += src.slice(cursor, a);
      cursor = Math.max(cursor, b);
    }
    outside += src.slice(cursor);
    const reachable = handlersIn(outside, declared);

    for (const h of inside) {
      if (reachable.has(h)) continue;
      const idx = src.search(new RegExp(`const\\s+${h}\\b`));
      findings.push({ file, handler: h, line: src.slice(0, idx).split("\n").length });
    }
  }
}

if (findings.length) {
  console.error("[lint:empty-state-actions] ✗ these actions are reachable ONLY from an empty state:\n");
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  ${f.handler}()`);
  }
  console.error(
    "\n  Once the list is non-empty the control disappears, taking the only route to\n" +
    "  that action with it. Offer it somewhere unconditional too — a header button,\n" +
    "  a menu item, a per-row control. Keep the empty-state copy as well; it is the\n" +
    "  EXCLUSIVITY that is the bug, not the empty state.\n",
  );
  process.exit(1);
}

console.log("[lint:empty-state-actions] ✓ no action is trapped in an empty state");
