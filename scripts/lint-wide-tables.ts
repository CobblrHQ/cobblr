// Guard: a page that IS a wide table asks for the width to be one.
//
// Every page is centred in a max-w-6xl column, which is right for a form or a
// record and wrong for a table with nine columns. At 6xl the inventory list
// either truncated a real product title or pushed its last column past the
// edge, while a wide monitor kept ~900px of empty margin on each side. Nothing
// failed; it just looked broken, and only to whoever opened that page on a big
// screen.
//
// So a page with a substantial table calls usePageWidth("wide"), and this says
// so when one forgets.
//
// NOT every table. A settings matrix inside a form is a table by markup and
// prose by nature, and stretching it across 1900px would be worse. Those say so
// on themselves:
//
//   // wide-table: exempt — a settings matrix, not a data table
//
// Run: npx tsx scripts/lint-wide-tables.ts

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

/** Below this many columns, a table is a detail block rather than the page. */
const COLUMNS = 5;

function candidates(): string[] {
  try {
    const out = execFileSync("git", ["grep", "-lF", "--", "<table", "--", "*.tsx"], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    return out.split("\n").filter(Boolean);
  } catch (e) {
    if ((e as { status?: number }).status === 1) return [];
    throw e;
  }
}

const problems: string[] = [];

for (const file of candidates()) {
  const src = readFileSync(file, "utf8");
  // A PAGE, not a dialog or a panel: pages set their own document title.
  if (!/usePageTitle\(/.test(src)) continue;
  // Header cells however they are SPELLED. The first version counted only
  // literal `<th`, and the inventory list — the page this lint was written for
  // — renders its columns through a local `<Th>` component, so it had two
  // literal ones and sailed past. A guardrail that misses its own motivating
  // case is worse than none, because it reports success.
  const columns =
    (src.match(/<th\b/g) ?? []).length + (src.match(/<Th\b/g) ?? []).length;
  if (columns < COLUMNS) continue;
  if (/usePageWidth\(/.test(src)) continue;
  if (/wide-table:\s*exempt/.test(src)) continue;
  problems.push(
    `${file}\n      renders ${columns} columns but never calls usePageWidth("wide"), so the table\n` +
      `      is squeezed into the prose column while the screen sits empty either side.`,
  );
}

if (problems.length > 0) {
  console.error("lint:wide-tables — a page that is a wide table should ask for the room:\n");
  for (const p of problems) console.error(`  ✗ ${p}\n`);
  console.error(
    '  Add it beside usePageTitle:\n    usePageWidth("wide");\n\n' +
      "  Or, if the table is a settings matrix rather than data, say so:\n" +
      "    // wide-table: exempt — <why>\n",
  );
  process.exit(1);
}

console.log("lint:wide-tables — every wide table page asks for the width it needs.");
