#!/usr/bin/env tsx
// A mutating route that names its action (// AI-REACH: action <id>) gates with requireCapability(req, res, "<id>"), so the page, the API and Cobb read one declaration and give every role one answer.
//
// THE BUG THIS PREVENTS. a member could add a purchase line on the page and was refused purchases:add-line through the API and Cobb (#5170, 2026-10-07)
//
// THE RULE. A route registered with post, put, patch or delete whose comment
// names the action it is (`// AI-REACH: action <id>` or `// AI-ACTION: <id>`,
// the pairings lint:ai-reach already asks every mutating route for) calls requireCapability(req, res,
// "<that id>") before it acts. requireCapability reads the action's own
// declaration (`runBy`, `grantedAs`; api/src/platform/action-gates.ts), which
// is what /actions/invoke and Cobb read, so the three doors cannot disagree.
// A literal requireRole(...) there, no gate, or a gate on another capability
// id each let the page answer differently from the action. A genuine
// exception says so beside the route: `// GATE: <why>`.
//
// AND A LOAN. A route for an action a loan turns off (OFF_WHILE_LENT: moving,
// sending home, labelling) also asks about the loan: requireCapability(req,
// res, "<that id>", <the record>), or refuseIfLent(req, res, "<that id>", refs)
// once it has read the records,
// so a lent thing is refused at every door the action is (#8235, 2026-10-27:
// the action refused a lent part, the placement route moved it).
//
// THE BOUNDARY. GET routes are not read: a read's rights are the field and
// kind scopes, not an action's. A route that names an exemption rather than an
// action is not paired, so not judged.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-route-and-action-gate-agree.ts   (pnpm lint route-and-action-gate-agree)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { onlyChanged } from "./lib/lint-only-files.ts";
import { OFF_WHILE_LENT } from "../packages/platform-contract/src/loan.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["modules", "api/src/routes"];

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
const PAIR = /\/\/\s*(?:AI-REACH:\s*action|AI-ACTION:)\s+([a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*)/;
const ROUTE = /\b\w+\.(get|post|put|patch|delete)\(/;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// The call as code, not as spelled: `requireCapability(req,res,"x")` and a line-broken call are the
// same gate as the spaced one (a false "gates on another capability id" on #5281, 2026-10-08).
const ARGS = (third: string) => `\\(\\s*req\\s*,\\s*res\\s*,\\s*${third}\\s*[),]`;
const gatesOn = (id: string) => new RegExp(`requireCapability${ARGS(`["'\`]${esc(id)}["'\`]`)}`);
const asksTheLoan = (id: string) =>
  new RegExp(`(refuseIfLent\\(\\s*req\\s*,\\s*res\\s*,\\s*["'\`]${esc(id)}["'\`]\\s*,|requireCapability\\(\\s*req\\s*,\\s*res\\s*,\\s*["'\`]${esc(id)}["'\`]\\s*,\\s*[^)\\s])`);

export function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = PAIR.exec(lines[i] ?? "");
    if (!m) continue;
    const id = m[1]!;
    // The route this comment heads: the first route registration within the
    // next few lines, and its body up to the next registration.
    let start = -1;
    for (let k = i + 1; k < Math.min(lines.length, i + 8); k++) if (ROUTE.test(lines[k] ?? "")) { start = k; break; }
    if (start < 0) continue;
    const verb = ROUTE.exec(lines[start]!)![1];
    if (verb === "get") continue;
    let end = lines.length;
    for (let k = start + 1; k < lines.length; k++) if (ROUTE.test(lines[k] ?? "") || PAIR.test(lines[k] ?? "")) { end = k; break; }
    const head = lines.slice(i, start + 1).join("\n");
    const body = lines.slice(start, end).join("\n");
    if (/\/\/ GATE: \S/.test(head)) continue;
    if (OFF_WHILE_LENT.has(id) && !asksTheLoan(id).test(body)) {
      out.push({ file, line: start + 1, what: `the route for ${id} moves or labels a thing a loan holds, and never asks: pass the record to requireCapability(req, res, "${id}", record), or call refuseIfLent(req, res, "${id}", [the records it touches])` });
    }
    if (gatesOn(id).test(body)) continue;
    // A same-file helper handed the id, that gates on what it was handed.
    const helper = new RegExp(`(\\w+)\\(\\s*req\\s*,\\s*res\\s*,\\s*["'\`]${esc(id)}["'\`]`).exec(body)?.[1];
    if (helper && new RegExp(`function ${helper}\\([^)]*\\)[^{]*\\{[\\s\\S]{0,400}?requireCapability${ARGS("[a-zA-Z_]\\w*")}`).test(src)) continue;
    const why = /requireRole\(/.test(body) ? "gates with a literal requireRole" : /requireCapability\(/.test(body) ? "gates on another capability id" : "has no gate";
    out.push({ file, line: start + 1, what: `the route for ${id} ${why}: gate with requireCapability(req, res, "${id}")` });
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:route-and-action-gate-agree - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:route-and-action-gate-agree OK`);
}
