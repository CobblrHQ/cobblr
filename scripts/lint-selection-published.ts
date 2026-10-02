// What a person has ticked on a list is what Cobb is talking about.
//
// The chip above the message box is what turns "file these" from a guess into
// an instruction: it carries the IDS, so the assistant acts on exactly what is
// ticked instead of going looking by name, or asking "which ones?".
//
// This lint has said both things in turn. First it required pages to publish
// the selection continuously; then, so ticking rows to print their labels did
// not also make them the subject of the next message, it required only an
// OFFER (an Ask Cobb button on the bar). The owner settled it on 2026-10-02,
// on the inbox, with eleven items ticked and Cobb asking which ones: "I
// shouldn't have to add them to Cobb just for Cobb to know the context." So
// the ticks ARE the context, shown as the chip the person can drop with its ×.
//
// A page with a selection (a ticked-ids Set, or useTickedRows) calls
// `useAskCobbAboutSelection`, which publishes the ticks as they change, and a
// page that draws a BulkActionBar also passes its `onAskCobb`. Or it says why
// not, with a reason that is true today.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["web/src/pages", "modules"];
// A Set of ids is not enough on its own: pages keep expansion state and
// dismissed-prompt state the same way. What makes it a SELECTION is that it is
// named like one and there are checkboxes to fill it.
const SELECTION = /const \[(selected|checked)[A-Za-z]*,\s*set[A-Za-z]*(?:,\s*[A-Za-z]+)?\]\s*=\s*(?:useState<Set<string>>|useTickedRows\s*\()/;
const BAR = /<BulkActionBar\b/;
const CHECKBOXES = /type="checkbox"/;
const OFFERS = /useAskCobbAboutSelection\s*\(/;
const WIRED = /onAskCobb\s*=\s*\{/;
const EXEMPT = /SELECTION-NOT-CONTEXT:\s*\S+/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules" || name === "dist") continue;
      walk(p, out);
    } else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const offenders: string[] = [];
for (const root of ROOTS) {
  for (const file of walk(root)) {
    // Comments do not count. A commented-out call satisfied an earlier version
    // of this check, which is the one way a lint can be worse than no lint: it
    // reports cover that is not there.
    const src = readFileSync(file, "utf8")
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n");
    if (!SELECTION.test(src) || !CHECKBOXES.test(src)) continue;
    // Both halves, because either alone is a page that does not actually work:
    // the hook without the prop hands Cobb nothing, and the prop without the
    // hook passes undefined.
    if ((OFFERS.test(src) && (!BAR.test(src) || WIRED.test(src))) || EXEMPT.test(readFileSync(file, "utf8"))) continue;
    offenders.push(file);
  }
}

if (offenders.length) {
  console.error("[lint:selection-published] a list with checkboxes that Cobb cannot see:");
  for (const f of offenders) console.error(`  - ${f}`);
  console.error(
    "\n  Publish it:  const askCobb = useAskCobbAboutSelection(selected, rows, \"<module>:<kind>\", \"<noun>\")\n" +
      "  and pass onAskCobb={askCobb ?? undefined} to the BulkActionBar.\n" +
      "  Or, if the ticked things are not things an assistant could act on (a\n" +
      "  wizard's steps, columns), say so:\n" +
      "    // SELECTION-NOT-CONTEXT: <why>",
  );
  process.exit(1);
}
console.log("[lint:selection-published] ✓ every list with a selection hands it to Cobb as it is ticked");
