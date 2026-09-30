#!/usr/bin/env tsx
// A record detail that shows its attachments also mounts the panels other modules contribute to that kind, so a module's panel (a service schedule, a discussion) reaches every record it applies to.
//
// THE BUG THIS PREVENTS. An asset had no service schedule: the assets detail rendered attachments but never the contributed panels, while machines did (fundamentals audit, 2026-09-29).
//
// THE RULE. A file that renders `<EntityAttachments` (the tag, file, link and
// discussion pills on a record) is a record's detail, so it also renders
// `<ContributedDetailPanels`: the one place a module's panel for a kind (the
// maintenance schedule on anything physical, the fleet cockpit on a machine,
// tags and discussion everywhere) reaches that kind's page. Passes: both in
// the file. Fails: attachments without panels. A genuine exception carries
// `// contributed-panels-ok: <why>` on the line above the attachments.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. The trigger is the
// attachments component, not "a detail page", because that is what every
// record detail in the web has and what a list or a picker never has. The
// part page renders neither (it has its own panels), so it is out of scope,
// not exempt; nothing near-missed yet.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-record-detail-mounts-contributed-panels.ts   (pnpm lint record-detail-mounts-contributed-panels)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src", "modules"];

/** One offending place. `line` is 1-based for a clickable path:line. */
interface Violation {
  file: string;
  line: number;
  what: string;
}

function* walk(dir: string): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  if (!file.endsWith(".tsx") || src.includes("<ContributedDetailPanels")) return out;
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/<EntityAttachments\b/.test(lines[i] ?? "")) continue;
    if (/\/\/ contributed-panels-ok: \S/.test(lines[i - 1] ?? "")) continue;
    out.push({ file, line: i + 1, what: "shows a record's attachments but never mounts <ContributedDetailPanels>, so no module's panel for this kind appears here" });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:record-detail-mounts-contributed-panels - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:record-detail-mounts-contributed-panels OK`);
