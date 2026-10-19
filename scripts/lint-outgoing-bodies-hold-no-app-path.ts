#!/usr/bin/env tsx
// A message body never carries a hand-written app path: the page goes through emailableUrl or the sentence says there is no link.
//
// THE BUG THIS PREVENTS. A receipt reply, the stop link of an external message and the AI-share mail printed `/w/<slug>/scan` and friends as their link on any instance with no public address, text no mail client turns into a link (#7543). absoluteAppUrl is gone, so the old helper cannot do it; this holds the other way to do it, a path written into the body by hand.
//
// THE RULE. In a file of api/src or a module's server code (modules/*/src, not its ui) that sends (it names a sender: sendAuthEmail, sendFromWorkspace, sendTextFromWorkspace, sendEmailVia, postJson, notifyAccount, feedbackEmail, cobblrEmailHtml, sendExternalMessage, sendEmail, sendText, `notifications.dispatch(`, or it is a notification channel), a string or template literal that holds an app path (`/w/…`, `/m/…`, `/me/…`, `/modules/…`, `/configuration/…`, `/join/…`) is allowed only where it names a destination rather than prints one: the argument of emailableUrl(...), the value of link_url / route / path / href / to, a variable named like a path, route or url, an argument of a router or string method (`.get`, `.startsWith`, …). Anywhere else, in a body, it fails. A genuine exception says `// PATH-OK: <why>` on its line or the one above.
//
// KNOWN LIMIT. A body assembled from a path held in a variable named like a destination (`const route = …; text: route`) passes: the lint reads literals, not data flow. Senders are discovered from what a file names, not listed; the EXEMPT table in this file is the curated part, a file with the reason it holds a path that is not a body.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Route definitions in a file that also sends (`router.get("/m/stop/:token")`) name a path and print nothing, which is why a router or string-method argument passes. The rule is on literals, not on the word "path": a destination built through emailableUrl and handed to a body is the helper doing its job.
//
// PROVEN RED by scripts/lint-outgoing-bodies-hold-no-app-path.test.ts on a planted sender, and on main before #7543's senders were converted.
//
//   npx tsx scripts/lint-outgoing-bodies-hold-no-app-path.ts   (pnpm lint outgoing-bodies-hold-no-app-path)
import ts from "typescript";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. A test may point it elsewhere with LINT_ROOTS. */
const ROOTS = (process.env.LINT_ROOTS || "api/src,modules").split(",");

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
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !isEmbeddedPayload(p)) yield p;
  }
}

const SENDER = /\b(sendAuthEmail|sendFromWorkspace|sendTextFromWorkspace|sendEmailVia|postJson|notifyAccount|feedbackEmail|cobblrEmailHtml|sendExternalMessage|sendEmail|sendText)\b|\bnotifications\.dispatch\(/;

/** Files that send and are known to hold a path that is not a body. DISCOVER the senders, CURATE the exemptions: a file is here with the reason, never because it was easier than annotating a line. */
const EXEMPT: Record<string, string> = {};
const APP_PATH = /(^|[\s("'`:=>])\/(w|m|me|modules|configuration|join)\//;
const NAMING_PROPS = new Set(["link_url", "route", "path", "href", "to", "linkUrl", "deepLink", "next"]);
const NAMING_VARS = /(path|route|href|link|url|prefix)$/i;
const NAMING_CALLS = /(^|\.)(get|post|put|patch|delete|use|all|startsWith|endsWith|includes|replace|match|test|split|indexOf|emailableUrl|navigate|openRecordPath)$/;

/** The text a literal prints. A template's text after an interpolation does not start a path: `${base}/modules/x` continues an address the code already holds, so only its head and what follows whitespace count. */
function textOf(n: ts.Node): string[] {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return [n.text];
  if (ts.isTemplateExpression(n)) return [n.head.text, ...n.templateSpans.map((s) => " " + s.literal.text.replace(/^\//, "~/"))];
  return [];
}

/** A module's server code: its ui never sends, its tests are not shipping code. */
const inScope = (file: string) => !file.startsWith("modules/") || (/\/src\//.test(file) && !/\/src\/ui\//.test(file));

export function check(file: string, src: string): Violation[] {
  if (!inScope(file) || EXEMPT[file]) return [];
  const sender = /\/platform\/channels\//.test(file) || SENDER.test(src);
  if (!sender) return [];
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines = src.split("\n");
  const out: Violation[] = [];
  const named = (n: ts.Node): boolean => {
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
      if (ts.isCallExpression(p) && p.arguments.some((a) => a === n || a.pos <= n.pos && n.end <= a.end) && NAMING_CALLS.test(p.expression.getText(sf))) return true;
      if (ts.isPropertyAssignment(p) && NAMING_PROPS.has(p.name.getText(sf).replace(/["']/g, ""))) return true;
      if (ts.isVariableDeclaration(p) && NAMING_VARS.test(p.name.getText(sf))) return true;
      if (ts.isImportDeclaration(p)) return true;
      if (ts.isStatement(p)) return false;
    }
    return false;
  };
  const visit = (n: ts.Node): void => {
    const parts = textOf(n);
    if (parts.some((t) => APP_PATH.test(t))) {
      const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line;
      const ok = /PATH-OK:\s*\S/.test(lines[line] ?? "") || /PATH-OK:\s*\S/.test(lines[line - 1] ?? "");
      if (!ok && !named(n)) out.push({ file, line: line + 1, what: `an app path written into a message: build it with emailableUrl(...), or say // PATH-OK: <why>` });
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

if (process.argv[1]?.endsWith("lint-outgoing-bodies-hold-no-app-path.ts")) {
  const violations: Violation[] = [];
  for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));
  if (violations.length) {
    console.error(`lint:outgoing-bodies-hold-no-app-path - ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
    console.error("Build the address with emailableUrl(path) from api/src/platform/link-origin.ts (it gives a whole address or null; pointTo() says so plainly), or write // PATH-OK: <why>.");
    process.exit(1);
  }
  console.log(`lint:outgoing-bodies-hold-no-app-path OK`);
}
