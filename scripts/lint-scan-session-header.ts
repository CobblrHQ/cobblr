#!/usr/bin/env tsx
// The scan session header is ONE row, and its last three controls are always
// location -> file -> open.
//
// WHY THIS IS A LINT: the header is a flex row that every new session feature
// adds a control to, and each new control naturally gets appended at the end -
// which is exactly the slot the filing trio needs. It had already drifted to
// `location · file · Original · PO# · Re-parse · open`, so the trio sat in a
// different column depending on whether a session came from a receipt or a scan
// and the eye had to re-find it on every row (reported 2026-07-30: "redo the
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
const whole = readFileSync(FILE, "utf8");

const errors: string[] = [];

// Scope to the SESSION HEADER, not the whole file. These markers are rendered
// strings, and a rendered string is only a reliable marker while it is unique -
// "Set location" stopped being unique the moment the page header adopted the
// same label (deliberately: one action, one name at every width). The lint then
// measured every session utility against the PAGE header's chip and reported
// four misplacements when nothing had moved.
//
// `data-session-header` is a structural anchor: it cannot be captured by a
// string that happens to appear elsewhere.
// Comments are blanked (length-preserving) before anchoring, so the lint cannot
// match its OWN prose: the comment documenting this anchor names both the
// attribute and "Set location", and searching the raw file found the comment
// first - which made the slice start above the row and every check nonsense.
const withoutComments = whole
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + m.slice(p1.length).replace(/./g, " "));

const ANCHOR = "data-session-header";
const anchorAt = withoutComments.indexOf(ANCHOR);
if (anchorAt === -1) {
  console.error(
    `[lint:scan-session-header] ✗ could not find the ${ANCHOR} anchor in ${REL}.\n` +
      `This lint slices the file at that attribute; if the session header moved or was\n` +
      `renamed, put the anchor back on its container (or update this lint).`,
  );
  process.exit(1);
}
const src = withoutComments.slice(anchorAt);

/** Where a marker sits WITHIN the session header, or -1. */
const at = (needle: string) => src.indexOf(needle);

// Renamed 2026-08-01 (feedback: shorten this row rather than let it wrap): the
// unset chip says the ACTION now, and the verbs drop their long half below sm.
const LOCATION = at('"Set location"');
const FILE_ALL = at("File<span className=\"hidden sm:inline\">&nbsp;all</span> {readyIds.length}");
const OPEN = at("open →");

for (const [name, idx] of [
  ["the location chip (\"Set location\")", LOCATION],
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

// PURCHASE-ONLY CONTROLS MUST NAME THE PURCHASE GATE.
//
// An order number and a tracking number are facts about something you BOUGHT.
// They shipped with the gate hand-written at each site, and the tracking
// number's said only `g.batchId` - so "+ Tracking #" offered itself on every
// scan session, including a barcode just scanned (reported 2026-08-15). Two
// controls with one meaning and two hand-written gates is one gate waiting to
// be wrong, and nothing about a wrong gate fails a typecheck or a test.
//
// So the gate has a name, `isReceiptSession`, and each purchase-only control
// has to be gated on it. A control that needs the stored receipt FILE (Original,
// Re-parse) legitimately gates on `sourceFileId` instead - that is a capability
// check, a different question, and it is not what this rule is about.
const PURCHASE_ONLY: Array<[string, string]> = [
  ["PO#", "editingPo === g.batchId ?"],
  ["Tracking #", "editingTracking === g.batchId ?"],
];
for (const [name, marker] of PURCHASE_ONLY) {
  const idx = src.indexOf(marker);
  if (idx === -1) continue; // removed on purpose is fine
  // The gate opens the block immediately above the editing ternary.
  const gate = src.slice(Math.max(0, idx - 220), idx);
  if (!gate.includes("isReceiptSession")) {
    errors.push(
      `the "${name}" control is not gated on isReceiptSession - it is purchase-only, so it must ` +
        `not offer itself on a plain scan session. Use the named gate rather than spelling a new ` +
        `one out; that is how "+ Tracking #" ended up on every barcode scan.`,
    );
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
// Tolerates a multi-line opening tag: prettier splitting the attributes across
// lines is not a layout change, and the old single-line regex called it one.
const headerBar = src.match(/className="flex w-full items-center gap-2[^"]*"/);
if (!headerBar) {
  errors.push(`could not find the session header bar in ${REL} - if its classes changed, update this lint`);
} else if (headerBar[0].includes("flex-wrap")) {
  errors.push("the session header bar must not use flex-wrap - it is deliberately a single row");
} else if (!headerBar[0].includes("overflow-hidden")) {
  errors.push(
    "the session header bar must keep overflow-hidden - without it a fully-loaded session pushes the page sideways instead of clipping",
  );
}

// THE ROW HAS TO BE DRAWN AT ALL — including on the single-session page.
//
// Every rule above orders controls WITHIN the header, so all of them pass
// vacuously when the header is never rendered. That is what shipped:
// `sessionGroups` short-circuited to null whenever the inbox was scoped to one
// session (?batch), on the reasoning that one session needs no separator. True
// of the grouping, false of the header — the header is also the session's whole
// action surface. So the page you open to work ONE session became the only page
// with no way to act on it as a session: no select-all (its checkbox is the
// only one on the page), no Place & file all, no Original / PO# / Tracking # /
// Re-parse. Filing meant ticking every card by hand (reported 2026-08-15).
//
// Grouping a single session costs nothing; dropping its controls costs the
// page. So the memo may not bail out early — let each control decide for itself
// what applies (`open →` withholds itself when it would link to the current
// page; Merge withholds itself when there is no older session to fold into).
const MEMO = "const sessionGroups = useMemo(";
const memoAt = withoutComments.indexOf(MEMO);
if (memoAt === -1) {
  errors.push(`could not find the sessionGroups memo in ${REL} - if it was renamed, update this lint`);
} else {
  const memoEnd = withoutComments.indexOf("\n  }, [", memoAt);
  if (memoEnd === -1) {
    errors.push(`could not find the end of the sessionGroups memo in ${REL} - update this lint`);
  } else if (/\breturn\s+null\s*;/.test(withoutComments.slice(memoAt, memoEnd))) {
    errors.push(
      "sessionGroups returns null on some path, which drops the ENTIRE session header row " +
        "(select-all, Place & file all, Original / PO# / Tracking # / Re-parse) from whatever view " +
        "hits it - the single-session page lost exactly this. Group unconditionally and let each " +
        "control decide whether it applies.",
    );
  }
}

if (errors.length === 0) {
  console.log(
    "[lint:scan-session-header] ✓ one row, always rendered, and location → file → open are the last three controls.",
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
