// A notification's `link_url` must be a RELATIVE path, never an absolute URL.
//
// The in-app bell routes it with React Router's navigate(), which takes a PATH.
// An absolute URL ("https://cobblr.me/w/x/scan") matches no route, falls
// through to the catch-all and dumps the user on the dashboard — which is what
// every emailed-receipt notification did until 2026-08-01. Outbound channels
// (email, Slack, Discord DM, webhook) absolutize it themselves at send time, so
// storing relative loses nothing.
//
// It matters more than a normal papercut because notification rows are
// IMMUTABLE: only read_at and delivered_via are ever updated, so a bad link is
// baked into that row forever. There is no migration that fixes it after the
// fact — only the bell's defensive origin-strip, which should stay a safety net
// rather than the mechanism.
//
// Flags: `link_url: absoluteAppUrl(...)`, `link_url: <ident>` where that ident
// was assigned from absoluteAppUrl in the same file, and string literals that
// start with a scheme.

import ts from "typescript";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOTS = ["api/src", "modules"];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (e === "node_modules" || e === "dist" || e === ".git") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.ts$/.test(p) && !/\.d\.ts$/.test(p)) out.push(p);
  }
  return out;
}

const violations: Array<{ file: string; line: number; text: string }> = [];

for (const r of ROOTS) {
  for (const file of walk(join(ROOT, r))) {
    const src = readFileSync(file, "utf8");
    if (!src.includes("link_url")) continue;
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

    // Locals in this file that hold an absoluteAppUrl(...) result.
    const absolutized = new Set<string>();
    const collect = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isCallExpression(node.initializer) &&
        node.initializer.expression.getText(sf) === "absoluteAppUrl"
      ) {
        absolutized.add(node.name.text);
      }
      ts.forEachChild(node, collect);
    };
    collect(sf);

    const flag = (node: ts.Node, why: string) => {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      violations.push({ file: relative(ROOT, file), line: line + 1, text: why });
    };

    const visit = (node: ts.Node): void => {
      if (
        ts.isPropertyAssignment(node) &&
        (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
        node.name.text === "link_url"
      ) {
        const init = node.initializer;
        if (ts.isCallExpression(init) && init.expression.getText(sf) === "absoluteAppUrl") {
          flag(node, "link_url: absoluteAppUrl(...) — store the path, let channels absolutize");
        } else if (ts.isIdentifier(init) && absolutized.has(init.text)) {
          flag(node, `link_url: ${init.text} — that variable holds an absoluteAppUrl(...) result`);
        } else if (ts.isStringLiteralLike(init) && /^https?:\/\//i.test(init.text)) {
          flag(node, `link_url: "${init.text.slice(0, 50)}…" — absolute URL literal`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
}

if (violations.length > 0) {
  console.error("lint:notification-links - link_url must be a relative path:\n");
  for (const v of violations) console.error(`  ${v.file}:${v.line}\n    ${v.text}\n`);
  console.error(
    "The in-app bell routes link_url with React Router (a PATH); an absolute URL\n" +
      "matches no route and lands the user on the dashboard. Notification rows are\n" +
      "immutable, so a bad link can never be corrected. Store the path and keep the\n" +
      "absolute form for email/DM body text.",
  );
  process.exit(1);
}

console.log("lint:notification-links - every link_url is a relative path.");
