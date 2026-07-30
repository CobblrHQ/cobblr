#!/usr/bin/env tsx
// The scan session header is ONE row, and its last three controls are always
// location -> file -> open.
//
// WHY THIS IS A LINT: the header is a flex row that every new session feature
// adds a control to, and each new control naturally gets appended at the end -
// which is exactly the slot the filing trio needs. It had already drifted to
// `location · file · Original · PO# · Re-parse · open`, so the trio sat in a
// different column depending on whether a session came from a receipt or a scan
// and the eye had to re-find it on every row (the author, 2026-07-30: "redo the
// ordering so the loc place open are the same 3 rightmost controls always").
//
// Nothing about appending a control fails a typecheck or a test, so the order
// is asserted here instead.
//
//   npx tsx scripts/lint-scan-session-header.ts   (npm run lint:scan-session-header)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = join(ROOT, "web", "src", "pages", "ScanPage.tsx");
const REL = relative(ROOT, FILE);
const src = readFileSync(FILE, "utf8");

const errors: string[] = [];

/** Where a marker sits in the file, or -1. Markers are the rendered strings, so
 *  they survive refactors that rename variables or reshape the JSX. */
const at = (needle: string) => src.indexOf(needle);

const LOCATION = at('"no location set"');
const FILE_ALL = at("File all {readyIds.length}");
const OPEN = at("open →");

for (const [name, idx] of [
  ["the location chip (\"no location set\")", LOCATION],
  ["the File-all button", FILE_ALL],
  ["the open → link", OPEN],
] as const) {
  if (idx === -1) errors.push(`could not find ${name} in ${REL} - if it was renamed, update this lint`);
}

if (errors.length === 0) {
  // The trio, in order.
  if (!(LOCATION < FILE_ALL)) {
    errors.push("the location chip must render BEFORE the File-all button (location -> file -> open)");
  }
  if (!(FILE_ALL < OPEN)) {
    errors.push("the File-all button must render BEFORE the open → link (location -> file -> open)");
  }

  // Per-session utilities belong LEFT of the trio, so the trio's column does not
  // move between a receipt session and a scanned one.
  const UTILITIES: Array<[string, number]> = [
    ["Original", at("/> Original")],
    ["PO#", at('{g.orderRef ? "PO#" : "+ PO#"}')],
    ["Re-parse", at("/> Re-parse")],
    ["End", at("End this scan session")],
  ];
  for (const [name, idx] of UTILITIES) {
    if (idx === -1) continue; // removed on purpose is fine; misplaced is not
    if (idx > LOCATION) {
      errors.push(
        `the "${name}" control renders AFTER the location chip - per-session utilities go to the LEFT of location/file/open`,
      );
    }
  }
}

// NOTHING AFTER THE TRIO. The order checks above only know about the controls
// that existed when they were written, so a BRAND NEW control appended at the
// end - the way every previous one arrived - would sail past them. This is the
// rule that actually holds the trio in place going forward: between the open →
// link and the end of the header bar there must be no element at all, only the
// closing tokens. Anything else means someone appended a fifth control, and the
// fix is to put it left of the location chip.
if (OPEN !== -1) {
  // The header bar's last child is the open → link; the next thing in the file
  // is the collapsed-body block. That gives a reliable end anchor without
  // having to balance JSX tags.
  const bodyStart = src.indexOf("{!collapsed && (", OPEN);
  if (bodyStart === -1) {
    errors.push(
      `could not find the end of the session header bar after "open →" in ${REL} - if the ` +
        `collapsed-body block moved, update this lint`,
    );
  } else {
    const tail = src.slice(OPEN + "open →".length, bodyStart);
    // Any JSX element start: a lowercase intrinsic (<button, <span) or a
    // component (<Link, <Modal). Closing tags and fragments are fine.
    const appended = tail.match(/<(?!\/)[A-Za-z][\w.]*/g) ?? [];
    if (appended.length > 0) {
      errors.push(
        `${appended.length} control(s) render AFTER the open → link (${[...new Set(appended)].join(", ")}) - ` +
          `the trio must be last, so new session controls go LEFT of the location chip`,
      );
    }
  }
}

// NOTHING BETWEEN LOCATION AND FILE either - they are one unit.
if (LOCATION !== -1 && FILE_ALL !== -1) {
  const slotStart = src.indexOf("{busy > 0 ?", LOCATION);
  if (slotStart !== -1 && slotStart < FILE_ALL) {
    const between = src.slice(src.indexOf('"no location set"}', LOCATION), slotStart);
    const wedged = between.match(/<(?!\/)(?:button|Link|a|input|select)\b/g) ?? [];
    if (wedged.length > 0) {
      errors.push(
        `${wedged.length} control(s) render BETWEEN the location chip and the file button - ` +
          `location → file → open is one unbroken group`,
      );
    }
  }
}

// One row. `flex-wrap` on the header bar would let a busy session spill onto a
// second line, which is the thing the ordering was meant to make scannable.
const headerBar = src.match(/<div className="flex w-full items-center gap-2[^"]*"/);
if (!headerBar) {
  errors.push(`could not find the session header bar in ${REL} - if its classes changed, update this lint`);
} else if (headerBar[0].includes("flex-wrap")) {
  errors.push("the session header bar must not use flex-wrap - it is deliberately a single row");
} else if (!headerBar[0].includes("overflow-hidden")) {
  errors.push(
    "the session header bar must keep overflow-hidden - without it a fully-loaded session pushes the page sideways instead of clipping",
  );
}

if (errors.length === 0) {
  console.log(
    "[lint:scan-session-header] ✓ one row, and location → file → open are the last three controls.",
  );
  process.exit(0);
}
console.error(`\n[lint:scan-session-header] ✗ ${errors.length} problem(s) in ${REL}:\n`);
for (const e of errors) console.error(`  - ${e}`);
console.error(
  `\nThe last three controls in a session header are always location → file → open, so the\n` +
    `filing controls sit in the same column on every row. New per-session controls go to the\n` +
    `LEFT of the location chip, not appended at the end.\n`,
);
process.exit(1);
