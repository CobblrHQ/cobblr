// Guard: a notification about a DATE says so.
//
// `dispatch()` takes `triggeredBy: "activity" | "schedule"`, and it decides
// which of two delivery windows a person's copy waits for — chat as it happens,
// things due today as one morning list. It defaults to "activity", which is
// right for almost everything and wrong for exactly the notifications this lint
// looks for.
//
// Getting it wrong is silent AND backwards: a "milk expires today" that forgot
// to say it is dated does not fail, it just interrupts somebody at 03:00 when
// the sweep happened to run, which is the precise noise the window exists to
// prevent. Nobody reads a stack trace for that; they turn the channel off.
//
// The signal is the payload. A dispatch carrying `daysUntil`, `expiresOn`,
// `scheduledAt` or `dueAt` is telling us, in its own data, that it is about a
// date. So it must also say so in the field that changes delivery.
//
// Run: npx tsx scripts/lint-dated-notifications.ts

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["modules", "api/src"];

/** Payload keys that mean "this is about a date". */
const DATE_KEYS = [
  "daysUntil",
  "days_until",
  "expiresOn",
  "expires_on",
  "scheduledAt",
  "scheduled_at",
  "dueAt",
  "due_at",
  "dueOn",
  "due_on",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.ts$/.test(p) && !/\.test\.ts$/.test(p)) out.push(p);
  }
  return out;
}

/** The text of one dispatch call, from `dispatch(` to its balanced close. */
function callsIn(src: string): Array<{ text: string; line: number }> {
  const out: Array<{ text: string; line: number }> = [];
  const re = /notifications\s*\.?\s*\n?\s*\.?dispatch\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    const start = i;
    for (; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push({
      text: src.slice(start, i + 1),
      line: src.slice(0, m.index).split("\n").length,
    });
  }
  return out;
}

const problems: string[] = [];

for (const root of ROOTS) {
  for (const file of walk(root)) {
    const src = readFileSync(file, "utf8");
    if (!src.includes("dispatch(")) continue;
    for (const call of callsIn(src)) {
      const dated = DATE_KEYS.filter((k) => new RegExp(`\\b${k}\\s*[,:}]`).test(call.text));
      if (dated.length === 0) continue;
      if (/triggeredBy\s*:/.test(call.text)) continue;
      problems.push(
        `${file}:${call.line}\n      carries ${dated.map((d) => `\`${d}\``).join(", ")}, so it is about a date, ` +
          `but does not pass triggeredBy.\n` +
          `      It will interrupt whenever the sweep runs instead of joining the reader's daily list.`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error("lint:dated-notifications — a notification about a date has to say so:\n");
  for (const p of problems) console.error(`  ✗ ${p}\n`);
  console.error(
    '  Add it to the dispatch:\n    triggeredBy: "schedule",\n\n' +
      "  If it genuinely is news rather than a date arriving, pass\n" +
      '    triggeredBy: "activity",\n  explicitly, so the next reader knows it was considered.\n',
  );
  process.exit(1);
}

console.log("lint:dated-notifications — every dated notification declares its delivery class.");
