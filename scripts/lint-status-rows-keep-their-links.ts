#!/usr/bin/env tsx
// A card that changes with a state keeps the links every state needs (Settings, Send a test, Rename, About) in all of its states: draw it with StatusRow, whose always slot is written once.
//
// THE BUG THIS PREVENTS. The bell's push row lost Settings the moment
// notifications were turned on: the owner asked "what are the settings
// options here and why are they gone once I press turn on". An audit of 39
// components found the same shape five more times: a minted token lost its
// link to API tokens, a turned-off label lost Rename, a verified Discord lost
// its test DM, a connected bridge lost what it can do and how to remove it
// (#5774, 2026-10-11). Every card wrote one JSX branch per state, and a link
// that belonged to all of them was typed into one.
//
// THE RULE. Inside one component, the JSX each state draws (the returns of an
// if-chain, the two sides of a `cond ? <A/> : <B/>`, or a pair of sibling
// blocks `{cond && <A/>}{!cond && <B/>}`) is compared for the
// controls a person needs whatever the state: a link or button labelled
// Settings, Send a test, Rename, Details, Manage, About this ..., or API
// tokens. One that appears in some state branches and not in others fails.
// The fix is StatusRow (@cobblr/platform-web): each state's own content in
// `states`, the shared links once in `always`. A branch that genuinely has no
// business offering the control says so: for a ternary on it or in the four
// lines above, for a chain of returns anywhere in the component:
//   // STATUS-ROW-OK: <why this state does not offer it>   (or {/* ... */} in JSX)
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Only those labels, and only
// branches that draw something to press: the Discord card's "Checking
// Discord…" and "Discord isn't set up on this server" are JSX with no
// control, flagged on the first run, and are not states the person acts in;
// nor is `if (!data) return null`.
// A modal's open and closed sides are not states of one card either; they
// are a ternary with null on one side, which is not compared.
//
// PROVE IT RED before you trust it green: on the merge-base of #5774 it names
// BellPushRow, the API tokens link and the label's Rename.
//
//   node scripts/lint-status-rows-keep-their-links.ts   (pnpm lint status-rows-keep-their-links)
import { readFileSync } from "node:fs";
import ts from "typescript";
import { repoFiles } from "./lib/repo-files.js";

const ROOTS = ["web/src", "modules", "packages/platform-web/src"];

/** The controls a person needs whatever state a card is in. */
const NEEDED: Array<[string, RegExp]> = [
  ["Settings", /^settings$/i],
  ["Send a test", /^send a test\b/i],
  ["Rename", /^rename$/i],
  ["Details", /^details$/i],
  ["Manage", /^manage\b/i],
  ["About", /^about this\b/i],
  ["API tokens", /^api tokens$/i],
];

const OPT_OUT = /\/[/*]\s*STATUS-ROW-OK: \S/;

interface Violation {
  file: string;
  line: number;
  what: string;
}

/** The words a JSX tree offers as a link or a button's own text. */
function offered(node: ts.Node, sf: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isJsxElement(n)) {
      const tag = n.openingElement.tagName.getText(sf);
      if (/^(a|button|Link|NavLink)$/.test(tag)) {
        const text = n.children
          .filter(ts.isJsxText)
          .map((c) => c.getText(sf))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        for (const [name, re] of NEEDED) if (re.test(text)) out.add(name);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

const isJsx = (n: ts.Node | undefined): boolean => {
  let e = n;
  while (e && ts.isParenthesizedExpression(e)) e = e.expression;
  return !!e && (ts.isJsxElement(e) || ts.isJsxFragment(e) || ts.isJsxSelfClosingElement(e));
};

/** The JSX a function returns directly from its own body (not from nested functions). */
function returnsOf(body: ts.Node): ts.Expression[] {
  const out: ts.Expression[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isFunctionLike(n) && n !== body) return;
    if (ts.isReturnStatement(n) && n.expression && isJsx(n.expression)) out.push(n.expression);
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(body, visit);
  return out;
}

/** Whether a JSX tree offers the person anything to press. */
function actsOn(node: ts.Node, sf: ts.SourceFile): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && /^(a|button|Link|NavLink)$/.test(n.tagName.getText(sf))) found = true;
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

function compare(all: ts.Node[], sf: ts.SourceFile, file: string, at: ts.Node, out: Violation[]) {
  // A branch with nothing to press (loading, "not set up here") is not a
  // state the person acts in, so it is not asked for the shared links.
  const branches = all.filter((b) => actsOn(b, sf));
  if (branches.length < 2) return;
  const sets = branches.map((b) => offered(b, sf));
  for (const [name] of NEEDED) {
    const have = sets.filter((s) => s.has(name)).length;
    if (have > 0 && have < sets.length) {
      const line = sf.getLineAndCharacterOfPosition(at.getStart(sf)).line + 1;
      out.push({ file, line, what: `"${name}" is in ${have} of ${sets.length} state branches; draw the states with StatusRow and put it in \`always\`` });
    }
  }
}

function check(file: string, src: string): Violation[] {
  if (!/\b(Settings|Send a test|Rename|Details|Manage|About this|API tokens)\b/.test(src)) return [];
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Violation[] = [];
  const visit = (n: ts.Node) => {
    if ((ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n.body && ts.isBlock(n.body)) {
      if (!OPT_OUT.test(n.getFullText(sf))) compare(returnsOf(n.body), sf, file, n, out);
    }
    if (ts.isConditionalExpression(n) && isJsx(n.whenTrue) && isJsx(n.whenFalse)) {
      // The opt-out sits on the ternary or within the few lines above it, so
      // one reason never silences the rest of a page.
      const startLine = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line;
      const from = sf.getPositionOfLineAndCharacter(Math.max(0, startLine - 4), 0);
      if (!OPT_OUT.test(src.slice(from, n.getEnd()))) compare([n.whenTrue, n.whenFalse], sf, file, n, out);
    }
    // The same choice written as two guarded blocks side by side:
    // {off && <A/>}{!off && <B/>} (the label's actions were drawn this way).
    if (ts.isJsxElement(n) || ts.isJsxFragment(n)) {
      const guarded = new Map<string, { yes?: ts.Node; no?: ts.Node }>();
      for (const child of n.children) {
        if (!ts.isJsxExpression(child) || !child.expression || !ts.isBinaryExpression(child.expression)) continue;
        const e = child.expression;
        if (e.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken || !isJsx(e.right)) continue;
        let cond = e.left;
        while (ts.isParenthesizedExpression(cond)) cond = cond.expression;
        const negated = ts.isPrefixUnaryExpression(cond) && cond.operator === ts.SyntaxKind.ExclamationToken;
        const key = (negated ? (cond as ts.PrefixUnaryExpression).operand : cond).getText(sf).replace(/\s+/g, "");
        const slot = guarded.get(key) ?? {};
        if (negated) slot.no = e.right;
        else slot.yes = e.right;
        guarded.set(key, slot);
      }
      for (const slot of guarded.values()) {
        if (!slot.yes || !slot.no) continue;
        const startLine = sf.getLineAndCharacterOfPosition(slot.yes.getStart(sf)).line;
        const from = sf.getPositionOfLineAndCharacter(Math.max(0, startLine - 4), 0);
        if (!OPT_OUT.test(src.slice(from, Math.max(slot.yes.getEnd(), slot.no.getEnd())))) compare([slot.yes, slot.no], sf, file, slot.yes, out);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const violations: Violation[] = [];
for (const file of repoFiles(ROOTS)) {
  if (!/\.tsx$/.test(file) || /\.test\.tsx$/.test(file) || /\/(node_modules|dist)\//.test(file)) continue;
  violations.push(...check(file, readFileSync(file, "utf8")));
}

if (violations.length) {
  console.error(`lint:status-rows-keep-their-links - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("A link every state needs is written once: StatusRow({ state, states, always }) from @cobblr/platform-web.");
  console.error("A state that genuinely does not offer it says so in the component:  // STATUS-ROW-OK: <why>");
  process.exit(1);
}
console.log("lint:status-rows-keep-their-links OK");
