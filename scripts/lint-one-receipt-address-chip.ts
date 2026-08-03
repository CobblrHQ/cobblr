// The receipt drop-box address is rendered by ONE component.
//
// It appears on the scan header and the Purchases header. Both used to inline
// their own chip + reveal + copy, which is how one fact ends up rendered two
// ways: Purchases showed a permanent wall of address text on its own line while
// Scan had already collapsed to a chip with a menu (the author, 2026-08-03,
// "standardize purchases to use the fancy new element").
//
// A third page will want it too. So: the address VALUE may be rendered only by
// ReceiptAddressChip.
//
// The rule is about RENDERING, not about the words. An early version banned the
// string "Email receipts to" and immediately flagged the scan header's phone
// overflow row - a MenuItem labelled "Email receipts to…" that copies to the
// clipboard. That row is a legitimately different affordance (a menu action, not
// a chip) and renders no address at all. Reading the value to copy it is fine;
// passing it as a prop is fine; printing it on screen yourself is the failure.
//
// And the rule is about HEADERS. A second over-broad pass flagged
// IntegrationsPage, which shows the address in full on purpose - it is the
// SETUP surface for receipt intake, where the whole point is to read and copy
// the thing. Forcing a settings page into a header chip would be worse than the
// duplication. So this governs the header surfaces listed below, where a chip
// is the right shape, and says nothing about anywhere else.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** The one file allowed to render it. */
const OWNER = join("web", "src", "components", "ReceiptAddressChip.tsx");
/** Header surfaces this rule governs - where a chip is the right shape. */
const HEADER_SURFACES = [
  join("web", "src", "pages", "ScanPage.tsx"),
  join("web", "src", "pages", "PurchasesPage.tsx"),
];

/** Blank comments so explaining the history is not a violation. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + m.slice(p1.length).replace(/./g, " "));
}

if (!existsSync(join(ROOT, OWNER))) {
  console.error(
    `lint:one-receipt-address-chip — ${OWNER} is missing.\n` +
      `If the component moved, update this lint rather than losing the check.`,
  );
  process.exit(1);
}

let failures = 0;
for (const rel of HEADER_SURFACES) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) {
    console.error(`lint:one-receipt-address-chip — ${rel} is missing; update this lint.`);
    process.exit(1);
  }
  const code = stripComments(readFileSync(abs, "utf8"));
  code.split("\n").forEach((line, i) => {
    // The address printed as JSX children: `{receiptAddress}` / `{address}` NOT
    // preceded by `=` (which would be a prop, e.g. address={receiptAddress}).
    if (!/(^|[^=])\{\s*(receiptAddress|address)\s*\}/.test(line)) return;
    console.error(
      `${rel}:${i + 1}  renders the receipt address itself\n` +
        `    ${line.trim().slice(0, 110)}\n` +
        `    Use <ReceiptAddressChip address={…} /> - one chip, one behaviour, every page.`,
    );
    failures++;
  });
}

if (failures > 0) {
  console.error(`\nlint:one-receipt-address-chip — ${failures} hand-rolled copy/copies.\n`);
  process.exit(1);
}
console.log(
  `lint:one-receipt-address-chip ✓ ${HEADER_SURFACES.length} header surfaces use the shared chip.`,
);
