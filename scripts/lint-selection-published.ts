// A list that lets you tick things should let you hand them to Cobb — by
// OFFERING, not by doing it for you.
//
// The chip above the message box is what turns "delete these" from a guess into
// an instruction: it carries the record IDS, so the assistant acts on exactly
// what is on screen instead of going looking by name. A page whose checkboxes
// reach Cobb by no route at all is a screen where that quietly does not work.
//
// This lint used to demand the opposite mistake. It required pages to PUBLISH
// the selection continuously, so ticking two racks to print their labels also
// made them the subject of your next message and lit their Cobb buttons as
// though you had pressed them. A checkbox and the Cobb button are different
// instructions — "do this to these" versus "let us talk about this" — and one
// should not perform the other. So the rule is now: offer it.
//
// A page with a selection Set either passes `onAskCobb` to its BulkActionBar
// (get the callback from `useAskCobbAboutSelection`), or says why not.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["web/src/pages", "modules"];
// A Set of ids is not enough on its own: pages keep expansion state and
// dismissed-prompt state the same way. What makes it a SELECTION is that it is
// named like one and there are checkboxes to fill it.
const SELECTION = /const \[(selected|checked)[A-Za-z]*,\s*set[A-Za-z]*\]\s*=\s*useState<Set<string>>/;
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
    if ((OFFERS.test(src) && WIRED.test(src)) || EXEMPT.test(readFileSync(file, "utf8"))) continue;
    offenders.push(file);
  }
}

if (offenders.length) {
  console.error("[lint:selection-published] a list with checkboxes that Cobb cannot see:");
  for (const f of offenders) console.error(`  - ${f}`);
  console.error(
    "\n  Publish it:  usePublishSelectedRecords(selected, rows, \"<module>:<kind>\", \"<noun>\")\n" +
      "  Or, if the ticked things are not records an assistant could act on (scan\n" +
      "  inbox rows, a wizard's steps, columns), say so:\n" +
      "    // SELECTION-NOT-CONTEXT: <why>",
  );
  process.exit(1);
}
console.log("[lint:selection-published] ✓ every list with a selection offers it to Cobb");
