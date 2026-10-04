#!/usr/bin/env tsx
// Dashboard totals read count or aggregate responses, never a page of records.
// A number on Home once stopped at 200 and missed low stock in the tail.
// Count expressions are followed through aliases. Query callbacks are an
// boundary: reading their response's items or returning disguised page counts
// is refused, while summing
// server totals is allowed. Instance metadata used to fetch those totals is
// not itself a displayed count. Home's move dialog legitimately pages rows,
// so page-limit refusal applies to registered widgets, not unrelated dialogs.
// Proven red on the original dashboard widgets.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export function dashboardViolations(src: string): number[] {
  if (!src.includes("DashboardTile")) return [];
  const tree = ts.createSourceFile("widget.tsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const definitions = new Map<string, ts.Expression[]>();
  const primaries: ts.Expression[] = [];
  const lines = new Set<number>();
  function collect(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const defs = definitions.get(node.name.text) ?? [];
      defs.push(node.initializer); definitions.set(node.name.text, defs);
    }
    if (ts.isJsxAttribute(node) && ["primary", "secondary", "attention"].includes(node.name.getText(tree)) && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) {
      primaries.push(node.initializer.expression);
    }
    if (src.includes("registerDashboardWidget(") && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) && /[?&]limit=/.test(node.getText(tree))) {
      lines.add(tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1);
    }
    ts.forEachChild(node, collect);
  }
  collect(tree);
  function followsPage(node: ts.Node, seen: Set<string>): boolean {
    if (ts.isConditionalExpression(node)) return followsPage(node.whenTrue, seen) || followsPage(node.whenFalse, seen);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return followsPage(node.right, seen);
    if (ts.isPropertyAccessExpression(node)) {
      if (["length", "items"].includes(node.name.text)) return true;
      return followsPage(node.expression, seen);
    }
    if (ts.isCallExpression(node) && node.expression.getText(tree) === "useQuery") return false;
    if (ts.isIdentifier(node)) {
      if (seen.has(node.text)) return false;
      const next = new Set(seen).add(node.text);
      return (definitions.get(node.text) ?? []).some((d) => followsPage(d, next));
    }
    let bad = false;
    ts.forEachChild(node, (child) => { if (followsPage(child, seen)) bad = true; });
    return bad;
  }
  function queryResults(node: ts.Node): void {
    if (ts.isPropertyAssignment(node) && node.name.getText(tree) === "queryFn") {
      const fn = node.initializer;
      if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
        function returned(value: ts.Expression): void {
          if (ts.isObjectLiteralExpression(value)) {
            for (const property of value.properties) if (ts.isPropertyAssignment(property) && /^(total|count|low|active|open|blocked|queued)$/.test(property.name.getText(tree))) {
              if (followsPage(property.initializer, new Set())) lines.add(tree.getLineAndCharacterOfPosition(property.getStart(tree)).line + 1);
            }
          } else if (ts.isIdentifier(value) || ts.isPropertyAccessExpression(value) || ts.isBinaryExpression(value)) {
            if (followsPage(value, new Set())) lines.add(tree.getLineAndCharacterOfPosition(value.getStart(tree)).line + 1);
          }
        }
        if (!ts.isBlock(fn.body)) returned(fn.body);
        else {
          function returns(child: ts.Node): void {
            if (ts.isReturnStatement(child) && child.expression) returned(child.expression);
            ts.forEachChild(child, returns);
          }
          returns(fn.body);
        }
      }
    }
    ts.forEachChild(node, queryResults);
  }
  queryResults(tree);
  for (const primary of primaries) if (followsPage(primary, new Set())) {
    lines.add(tree.getLineAndCharacterOfPosition(primary.getStart(tree)).line + 1);
  }
  return [...lines].sort((a, b) => a - b);
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield path;
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const violations: string[] = [];
  for (const root of ["modules", "web/src"]) for (const file of walk(root)) {
    for (const line of dashboardViolations(readFileSync(file, "utf8"))) violations.push(`${file}:${line}`);
  }
  if (violations.length) {
    console.error(`lint:dashboard-totals-counted: read a server count or aggregate, not a record page:\n${violations.join("\n")}`);
    process.exit(1);
  }
  console.log("lint:dashboard-totals-counted OK");
}
