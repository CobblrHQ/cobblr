// A detail header's action cluster must be allowed to shrink or wrap.
//
// The shape that breaks, every time:
//
//   <div className="flex items-start gap-4">
//     <Thumb />
//     <div className="flex-1 min-w-0"> …title… </div>
//     <div className="flex items-center gap-1"> …buttons… </div>   ← no shrink-0
//   </div>
//
// The title column says min-w-0, so it is the only thing willing to give ground.
// The buttons keep their intrinsic width. On a phone that is wider than the row,
// so the title column is squeezed to ZERO and its text paints outside its own
// box, on top of the buttons. Measured on the locations header at 390px: title
// box 0px wide, rendered across 3 lines, over the buttons.
//
// Why a static lint when e2e/mobile-audit.mjs already walks every route on a
// phone: the audit's detectors look for boxes that OVERLAP or spill past the
// page edge, and a zero-width box does neither. It also exits 0 by design — a
// detector, not a gate. This shape is visible in the source, so it can be caught
// before it renders, on every PR.
//
// The fix is one of: shrink-0 on the actions (they keep their size, the title
// wraps), flex-wrap on the row (the actions drop to their own line), or both,
// which is what the locations header does — full-width row on a phone, beside
// the title from sm up.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { globSync } from "node:fs";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const WEB = join(ROOT, "web/src");

/** The text column that will absorb all the squeeze. */
const FLEXIBLE = /className="[^"]*\bflex-1\b[^"]*\bmin-w-0\b|className="[^"]*\bmin-w-0\b[^"]*\bflex-1\b/;

/** A sibling cluster is safe if it may shrink, may wrap, or is width-bounded. */
const SAFE = /\b(shrink-0|flex-wrap|w-full|hidden|truncate|max-w-)/;

const files = globSync("**/*.tsx", { cwd: WEB }).filter((f) => !f.includes("__tests__"));

const bad: Array<{ file: string; line: number; snippet: string }> = [];

for (const rel of files) {
  const src = readFileSync(join(WEB, rel), "utf8");
  if (!FLEXIBLE.test(src)) continue;

  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!FLEXIBLE.test(line)) continue;

    // Walk forward to the sibling element that closes out this text column and
    // opens a control cluster. Bounded: a header row is a handful of lines.
    let depth = 0;
    for (let j = i; j < Math.min(i + 60, lines.length); j++) {
      const l = lines[j]!;
      depth += (l.match(/<div\b/g)?.length ?? 0) - (l.match(/<\/div>/g)?.length ?? 0);
      if (j === i || depth > 0) continue;
      // depth back to 0 → the text column closed. Find the next opening div,
      // skipping blank lines and JSX comments. (Looking only at the very next
      // line missed the real case: a comment sat between the two.)
      let sibLine = -1;
      let m: RegExpMatchArray | null = null;
      let inComment = false;
      for (let k = j + 1; k < Math.min(j + 14, lines.length); k++) {
        const raw = lines[k] ?? "";
        const t = raw.trim();
        // Track {/* … */} across LINES. Matching only single-line comments let
        // a multi-line one hide the very sibling this rule exists to inspect.
        if (inComment) {
          if (t.includes("*/}")) inComment = false;
          continue;
        }
        if (t.startsWith("{/*")) {
          if (!t.includes("*/}")) inComment = true;
          continue;
        }
        if (!t || t.startsWith("//")) continue;
        m = raw.match(/<div className="(flex[^"]*)"/);
        sibLine = k;
        break;
      }
      if (!m) break;
      const cls = m[1]!;
      // Only a CONTROL cluster matters — a row of buttons/links, not more text.
      const body = lines.slice(sibLine, Math.min(sibLine + 12, lines.length)).join("\n");
      if (!/<(button|Link|NavLink|EntityActionsBar|\w+ActionsBar)\b/.test(body)) break;
      if (!SAFE.test(cls)) {
        bad.push({ file: rel, line: sibLine + 1, snippet: cls.slice(0, 70) });
      }
      break;
    }
  }
}

if (bad.length) {
  console.error("[lint:header-rows] action cluster that cannot shrink or wrap:\n");
  for (const b of bad) {
    console.error(`  web/src/${b.file}:${b.line}`);
    console.error(`      <div className="${b.snippet}">  beside a flex-1 min-w-0 column`);
  }
  console.error(`
  The title column is the only sibling willing to shrink, so on a phone it is
  squeezed to zero width and its text paints on top of these buttons.

  Give the cluster room to move:

      shrink-0     buttons keep their width, the title wraps instead
      flex-wrap    (on the ROW) the cluster drops to its own line
      both         w-full on a phone, sm:w-auto beside the title above that

  The locations header does the last one.
`);
  process.exit(1);
}

console.log(`[lint:header-rows] ok — every action cluster beside a flexible column can shrink or wrap.`);
