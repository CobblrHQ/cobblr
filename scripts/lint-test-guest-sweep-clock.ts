#!/usr/bin/env tsx
// Integration tests prune sandbox guests at the real clock and age their own fixtures, so a sweep cannot delete another test's guest during provisioning.
//
// A grace-period regression advanced the shared guest sweep twenty minutes.
// It deleted other files' newborn guests between account creation and
// membership creation, making their sandbox starts intermittently fail.
//
// In api/tests, calls to the global guest prune cannot override its clock.
// Age the test's own guest row to prove that grace ends. Unit tests outside
// this shared-database suite may still inject a clock into isolated fixtures.
import { readFileSync } from "node:fs";
import ts from "typescript";
import { repoFiles } from "./lib/repo-files.js";

interface Violation {
  file: string;
  line: number;
  what: string;
}

export function check(file: string, src: string): Violation[] {
  if (!file.startsWith("api/tests/") || !src.includes("pruneOrphanSandboxUsers")) return [];
  const tree = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const names = new Set<string>();
  const namespaces = new Set<string>();
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!/\/platform\/try-sandbox\.(?:js|ts)$/.test(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        if ((binding.propertyName ?? binding.name).text === "pruneOrphanSandboxUsers") names.add(binding.name.text);
      }
    } else if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
  }
  const violations: Violation[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const callee = node.expression;
      const direct = ts.isIdentifier(callee) && names.has(callee.text);
      const throughNamespace = ts.isPropertyAccessExpression(callee)
        && ts.isIdentifier(callee.expression) && namespaces.has(callee.expression.text)
        && callee.name.text === "pruneOrphanSandboxUsers";
      if (direct || throughNamespace) violations.push({
        file,
        line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
        what: "a global guest sweep overrides the clock shared with other tests' newborn guests",
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return violations;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = repoFiles(["api/tests"]).filter((file) => file.endsWith(".test.ts"));
  const violations = files.flatMap((file) => check(file, readFileSync(file, "utf8")));
  if (violations.length) {
    console.error(`lint:test-guest-sweep-clock - ${violations.length} violation(s):`);
    for (const violation of violations) console.error(`  ${violation.file}:${violation.line}  ${violation.what}`);
    console.error("Age the guest row this test created, then call pruneOrphanSandboxUsers() without a clock override.");
    process.exit(1);
  }
  console.log("lint:test-guest-sweep-clock OK");
}
