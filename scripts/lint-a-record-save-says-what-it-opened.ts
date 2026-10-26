#!/usr/bin/env tsx
// A page's save of a record sends what its fields were when the form opened: a PATCH of a bag of fields goes through an Edit from editOf, never a bare body.
//
// THE BUG THIS PREVENTS. an older tab's save put back a moved shelf, a title and a price with both saying saved (#7925)
//
// THE RULE. A page's PATCH to a kind's own update route (the routes every
// module.ts declares as updateEndpoint, and an instance's /items/{id}), the
// one the server judges, is judged here by its body:
//   - an Edit's `.body`, with the same Edit's `.headers` beside it: passes;
//   - an object literal of named fields (`{ qty }`, `{ checked }`): passes, a
//     named setter whose caller states the one value it means;
//   - anything else (a parameter bag, a spread of one, a `metadata` bag):
//     fails. A bag is a form's save, and a form's save says what it opened
//     with, or an older tab's copy goes back over a newer save in silence.
// A save that is not of a record (a printer's settings, a saved view's
// layout) opts out with `// UNJUDGED-SAVE: <why>` on one of the three lines
// above the call or above the helper that holds it.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. The named setters: a list
// line's Got it (`{ checked }`) and a queued label's count (`{ qty }`) are
// one-tap acts whose value is the person's intent, not a copy of what the
// form opened with, so the rule stops at bags. The request helpers
// themselves (`request(method, path, body)`) take the method as a variable
// and are not judged: their callers are. A PATCH to any other route (a
// provider, a field def, a printer, a line inside an order) is not one the
// kernel judges; a line the module judges itself (purchases' and sales'
// order lines) is held by its own test, not here.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-a-record-save-says-what-it-opened.ts   (pnpm lint a-record-save-says-what-it-opened)
import { readFileSync, readdirSync, statSync } from "node:fs";
import ts from "typescript";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src", "packages/platform-web/src", ...moduleUis()];

/** Each module's own UI: its api/ runs on the server and sends no form's save. */
function moduleUis(): string[] {
  try {
    return readdirSync("modules").map((m) => join("modules", m, "src", "ui"));
  } catch {
    return [];
  }
}

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
    // An embedded payload (a base64 build) holds no code to judge and is megabytes.
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !isEmbeddedPayload(p)) yield p;
  }
}

const WRITE = new Set(["PATCH"]);
const OPT_OUT = /\/\/ UNJUDGED-SAVE: \S/;

const isLit = (n: ts.Node | undefined): n is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
  !!n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n));

/** Is this body a bag of fields rather than an Edit or named fields? */
function bag(body: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(body) || ts.isAsExpression(body)) return bag(body.expression);
  if (ts.isObjectLiteralExpression(body)) {
    return body.properties.some((p) => {
      if (ts.isSpreadAssignment(p)) return !literalSpread(p.expression);
      const name = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : "";
      return name === "metadata";
    });
  }
  return true;
}

/** A spread that only adds named fields: `...(x ? { quantity } : {})`. */
function literalSpread(e: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(e)) return literalSpread(e.expression);
  if (ts.isConditionalExpression(e)) return literalSpread(e.whenTrue) && literalSpread(e.whenFalse);
  return ts.isObjectLiteralExpression(e) && !bag(e);
}

/** Every kind's update route, as its module declares it: "/parts/{id}". */
export function kindRoutes(): Array<{ module: string; collection: string }> {
  const out: Array<{ module: string; collection: string }> = [{ module: "*", collection: "items" }];
  for (const m of readdirSync("modules")) {
    let src = "";
    try {
      src = readFileSync(join("modules", m, "src", "module.ts"), "utf8");
    } catch {
      continue;
    }
    for (const hit of src.matchAll(/updateEndpoint:\s*"\/([a-z0-9-]+)\/\{id\}"/g)) out.push({ module: m, collection: hit[1]! });
  }
  return out;
}

/** The words a path is spelled with: its literal parts, and the strings
 *  handed to a helper inside it (`primaryBase(slug, "machines/machines")`). */
function spelled(path: ts.Expression): string {
  const parts: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) parts.push(n.text);
    else if (ts.isTemplateExpression(n)) {
      parts.push(n.head.text);
      for (const span of n.templateSpans) {
        visit(span.expression);
        parts.push(span.literal.text);
      }
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(path);
  return parts.join("/");
}

/** Does this path end at one record of a kind the server judges? */
function toAKind(file: string, path: ts.Expression | undefined, kinds: ReturnType<typeof kindRoutes>): boolean {
  if (!path || !ts.isTemplateExpression(path)) return false;
  if (path.templateSpans.at(-1)!.literal.text !== "") return false;
  const words = spelled(path).split("/").filter(Boolean);
  const collection = words.at(-1);
  const own = /^modules\/([^/]+)\//.exec(file)?.[1];
  return kinds.some((k) => k.collection === collection && (k.module === "*" ? words.includes("instances") : own === k.module || words.includes(k.module)));
}

/** `x.body` beside `x.headers`: an Edit handed on whole. */
function anEdit(body: ts.Expression | undefined, headers: ts.Expression | undefined): boolean {
  if (!body || !ts.isPropertyAccessExpression(body) || body.name.text !== "body") return false;
  return !!headers && ts.isPropertyAccessExpression(headers) && headers.name.text === "headers" && headers.expression.getText() === body.expression.getText();
}

/** The check. Return every violation in one file; an empty array is a pass. */
export function check(file: string, src: string, kinds = kindRoutes()): Violation[] {
  if (!/"PATCH"|"PUT"|'PATCH'|'PUT'/.test(src)) return [];
  const tree = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lines = src.split("\n");
  const out: Violation[] = [];
  const optedOut = (node: ts.Node): boolean => {
    for (let n: ts.Node | undefined = node; n && !ts.isSourceFile(n); n = n.parent) {
      if (!(ts.isCallExpression(n) || ts.isStatement(n) || ts.isClassElement(n) || ts.isPropertyAssignment(n) || ts.isObjectLiteralElement(n))) continue;
      const at = tree.getLineAndCharacterOfPosition(n.getStart(tree)).line;
      for (let i = Math.max(0, at - 3); i <= at; i++) if (OPT_OUT.test(lines[i] ?? "")) return true;
    }
    return false;
  };
  const report = (node: ts.Node, method: string) => {
    if (optedOut(node)) return;
    out.push({ file, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1, what: `a ${method} of a bag of fields with no Edit: build it with editOf(opened, next) and pass edit.body with edit.headers, or say why it is not a record's save (UNJUDGED-SAVE:)` });
  };
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const args = node.arguments;
      const m = args.findIndex((a) => isLit(a) && WRITE.has(a.text));
      if (m >= 0 && args.length > m + 2 && toAKind(file, args[m + 1], kinds)) {
        const body = args[m + 2]!;
        if (!anEdit(body, args[m + 3]) && bag(body)) report(node, (args[m] as ts.StringLiteral).text);
      }
      for (const a of args) {
        if (!ts.isObjectLiteralExpression(a)) continue;
        const prop = (name: string) => a.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name);
        const method = prop("method")?.initializer;
        const sent = prop("body")?.initializer;
        if (!isLit(method) || !WRITE.has(method.text) || !sent || !toAKind(file, args[0], kinds)) continue;
        const inner = ts.isCallExpression(sent) && sent.expression.getText() === "JSON.stringify" ? sent.arguments[0] : sent;
        if (inner && bag(inner)) report(node, method.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) main();

function main(): void {
const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
const kinds = kindRoutes();
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8"), kinds));

if (violations.length) {
  console.error(`lint:a-record-save-says-what-it-opened - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:a-record-save-says-what-it-opened OK`);
}
