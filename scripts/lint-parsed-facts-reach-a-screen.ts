// A fact the receipt parser establishes, that nothing ever shows.
//
// Four reports in one day were the same shape, and none of them was a parse
// failure - the data was already there and nothing rendered it:
//
//   · "there is an entire Model # field in the email that did not get parsed"
//   · "and what about arriving tomorrow?"  - expected_arrival had been parsed
//     and stored for months; its only render site was a purchase Order
//   · the coupon a receipt takes off a line (line_discount / line_net) is
//     parsed, stored, and displayed nowhere
//   · "Acquired from ... is a dropdown thing" - choices were passed to a chip
//     that ignored them
//
// A parse that reaches nobody is indistinguishable from a parse that never
// happened, and the person who reported it each time was the user.
//
// So: every field of ReceiptRecord - the thing that exists precisely to keep
// what a receipt said - must either be READ somewhere in the web app, or be
// declared here as plumbing with a reason. Adding a field to the record and
// showing it nowhere now fails at commit rather than in a screenshot.
//
// Run: npx tsx scripts/lint-parsed-facts-reach-a-screen.ts

import { readFileSync, globSync } from "node:fs";

const RECORD = "modules/core-scan/src/services/receipt-record.ts";

/**
 * Fields that are deliberately not shown, and why.
 *
 * A key belongs here when a PERSON has no use for it - an id, a provenance
 * marker for machinery - never merely because showing it has not been done yet.
 * "We should render that eventually" is what this lint exists to catch.
 */
const PLUMBING: Record<string, string> = {
  group_id: "the batch's own id, for rejoining lines - not a fact about the thing",
  parse_method: "which tier read the receipt; diagnostic, and meaningless to a person",
  currency: "rendered as part of a price, never on its own",
};

const src = readFileSync(RECORD, "utf8");

// The interface's own field names. Reading the type keeps this honest: a field
// added to the record is a field this lint starts asking about.
const iface = src.match(/export interface ReceiptRecord \{([\s\S]*?)\n\}/);
if (!iface) {
  console.error(`✗ could not find ReceiptRecord in ${RECORD} - if it moved, update this lint`);
  process.exit(1);
}
const fields = [...iface[1]!.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]!);
if (fields.length === 0) {
  console.error(`✗ found ReceiptRecord but no fields in it - the shape changed, update this lint`);
  process.exit(1);
}

const web = globSync("web/src/**/*.{ts,tsx}")
  .filter((f) => !/\.test\.tsx?$/.test(f))
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");

/**
 * Facts that reach no screen. EMPTY, and it stays that way.
 *
 * It held six on 2026-08-25, all answers to "what did this actually cost me":
 * a receipt knew the list price, what came off it, the tax and what was really
 * charged, and no screen said any of it. The note here said that was worth
 * designing rather than quietly rendering six numbers onto a card at the end of
 * an unrelated fix. It was designed on 2026-09-01: the money the receipt states
 * is shown beside the document it was read from, and the marketplace seller -
 * a per-ITEM fact, not a receipt one - sits on the item's own line.
 *
 * The list may only ever SHRINK, so adding to it is not the way past this lint.
 * A new field on the record either reaches a screen or is declared PLUMBING
 * with the reason a person has no use for it.
 */
const BASELINE = new Set<string>([]);

const unseen = fields.filter((f) => !PLUMBING[f] && !new RegExp(`\\b${f}\\b`).test(web));
const fresh = unseen.filter((f) => !BASELINE.has(f));
const healed = [...BASELINE].filter((f) => !unseen.includes(f));

if (healed.length) {
  console.error("✗ these are rendered now - take them out of BASELINE so it cannot grow back:\n");
  for (const f of healed) console.error(`  ReceiptRecord.${f}`);
  process.exit(1);
}

if (fresh.length) {
  console.error("✗ parsed facts that reach no screen:\n");
  for (const f of fresh) console.error(`  ReceiptRecord.${f}`);
  console.error(
    "\n  A receipt established each of these and the app shows none of them, which is\n" +
      "  indistinguishable from never having parsed them. Render it, or add it to\n" +
      "  PLUMBING in this lint with the reason a person has no use for it.\n" +
      `  (${RECORD})`,
  );
  process.exit(1);
}

console.log(
  `✓ parsed-facts lint: ${fields.length - Object.keys(PLUMBING).length - BASELINE.size} of the receipt's ` +
    `user-facing facts reach a screen; ${BASELINE.size} known gap(s) baselined, none new.`,
);
