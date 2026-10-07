#!/usr/bin/env tsx
// Money is shown and taken only through @cobblr/platform-contract/money (formatMoney, MoneyInput): no hand-made currency strings, no cents divided by 100, no cents column rendered raw.
//
// THE BUG THIS PREVENTS. An asset's Paid showed a bare 4300 and its History read purchase price cents -> 430000 (2026-10-01)
//
// THE RULE. A currency format, a "$" glued to a number, a cents column
// divided by 100 or multiplied into one, a money-named value rounded with
// toFixed(2), and a `*_cents` value dropped into JSX or String() all fail,
// anywhere in shipping code outside packages/platform-contract/src/money.ts.
// Show money with formatMoney / formatStoredMoney, take it with MoneyInput /
// moneyForStorage. A genuine exception (a cost per million tokens is not a
// price anyone pays; a dedup key) says why on the line or the line above:
// `// MONEY-OK: <reason>`. There is no baseline: every line is decided.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. `Math.round(x * 100)` is
// as often a percentage (a battery, a zoom, a colour channel) as cents, so it
// fires only on a line that names money, and never on a ratio (a "/" inside
// the round: a bar's height, `Math.round((total / max) * 100)`). A quantity rounded with
// toFixed (a filament weight, a percentage) is not money, so the toFixed
// rule only fires on a money-named value (cost, price, paid, total, amount,
// refund, spend, budget). Parsers that READ a currency off a receipt
// (CURRENCY_RE, symbol maps) name a currency without formatting one and pass.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-money-goes-through-the-formatter.ts   (pnpm lint money-goes-through-the-formatter)
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src", "packages", "modules", "api/src"];

/** One offending place. `line` is 1-based for a clickable path:line. */
interface Violation {
  file: string;
  line: number;
  what: string;
}

function candidates(): string[] {
  // Each rule requires one of these literals. Git selects files before Node
  // reads them, including new files that have not yet been staged.
  const needles = ["currency", "${", "_cents", "Math.round", "toFixed", "minimumFractionDigits", "editFieldItem"];
  let paths: string;
  try {
    paths = execFileSync("git", ["grep", "-l", "-z", "-F", "--untracked", "--exclude-standard", ...needles.flatMap(needle => ["-e", needle]), "--", ...ROOTS.flatMap(root => [`:(glob)${root}/**/*.ts`, `:(glob)${root}/**/*.tsx`])], {encoding: "utf8", maxBuffer: 4 * 1024 * 1024});
  } catch (error) {
    if ((error as {status?: number}).status === 1) return [];
    throw error;
  }
  return paths.split("\0").filter(file => file && !/\.test\.tsx?$/.test(file) && !/\/(tests|scripts)\//.test(file) && !file.split("/").some(part => part === "node_modules" || part === "dist" || part.startsWith(".")));
}

/** The check. Return every violation in one file; an empty array is a pass. */
const RULES: Array<{ re: RegExp; also?: RegExp; what: string; tsxOnly?: boolean }> = [
  { re: /style:\s*["']currency["']/, what: "a hand-made currency format: use formatMoney" },
  { re: /`\$\$\{/, what: 'a "$" glued to a number: use formatMoney' },
  { re: /_cents\b[^\n]*\/\s*100\b|\/\s*100\b[^\n]*_cents\b/, what: "cents divided by 100 by hand: use formatStoredMoney / storedCents" },
  { re: /Math\.round\([^/\n]*\*\s*100\s*\)/, also: /\b\w*(cost|price|paid|budget|amount|cents|money|dollar)/i, what: "cents made by hand: use moneyForStorage / MoneyInput" },
  { re: /\b\w*(cost|price|paid|total|amount|refund|spend|budget)\w*\b[^\n]{0,40}\.toFixed\(2\)/i, what: "money rounded by hand: use formatMoney" },
  { re: /minimumFractionDigits:\s*2\b/, what: "two decimal places by hand (a money format): use formatMoney" },
  { re: /editFieldItem\(\s*"\w*(cost|price|paid|amount|budget|spend)\w*"[^\n]*numeric: true/, what: "a money column in a plain number input: use moneyFieldItem" },
  { re: /\{[^{}\n]*\b\w+_cents\s*\}/, what: "a cents value rendered raw: use formatStoredMoney", tsxOnly: true },
  { re: /String\([^)\n]*\b\w+_cents\b[^)\n]*\)/, what: "a cents value turned into text raw: use formatStoredMoney" },
];

const EXEMPT = new Set(["packages/platform-contract/src/money.ts"]);

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  if (EXEMPT.has(file)) return [];
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/MONEY-OK: \S/.test(line) || /MONEY-OK: \S/.test(lines[i - 1] ?? "")) continue;
    for (const r of RULES) {
      if (r.tsxOnly && !file.endsWith(".tsx")) continue;
      if (r.re.test(line) && (!r.also || r.also.test(line))) {
        out.push({ file, line: i + 1, what: r.what });
        break;
      }
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const file of candidates()) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:money-goes-through-the-formatter - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:money-goes-through-the-formatter OK`);
