// A list that lets you tick things should tell Cobb what you ticked.
//
// The chip above the message box is what turns "delete these" from a guess
// into an instruction: it carries the record IDS, so the assistant acts on
// exactly what is on screen instead of going looking by name. A page with
// checkboxes that publishes nothing is a screen where that quietly does not
// work, and nothing fails to say so — the chat simply has less to go on.
//
// So: a page with a selection Set either publishes it, or says why not.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["web/src/pages", "modules"];
// A Set of ids is not enough on its own: pages keep expansion state and
// dismissed-prompt state the same way. What makes it a SELECTION is that it is
// named like one and there are checkboxes to fill it.
const SELECTION = /const \[(selected|checked)[A-Za-z]*,\s*set[A-Za-z]*\]\s*=\s*useState<Set<string>>/;
const CHECKBOXES = /type="checkbox"/;
const PUBLISHES = /usePublishSelectedRecords\s*\(|usePublishRowSelection\s*\(/;
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
    const src = readFileSync(file, "utf8");
    if (!SELECTION.test(src) || !CHECKBOXES.test(src)) continue;
    if (PUBLISHES.test(src) || EXEMPT.test(src)) continue;
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
console.log("[lint:selection-published] ✓ every list with a selection tells Cobb about it");
