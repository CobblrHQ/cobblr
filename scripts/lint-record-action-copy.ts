#!/usr/bin/env tsx
// Record actions declare a description and use labels that identify what they do.
// The record's Put away and Restore buttons gave no clue what left the register.
// Workspace and internal actions are not record buttons. Arguments with labels
// are not actions either; inspect declarations, rather than every label property.
import ts from "typescript";
import { existsSync, readdirSync, readFileSync } from "node:fs";

interface Action { file: string; line: number; id: string; label: string; description: string }

export function readActions(file: string, text: string): Action[] {
  const actions: Action[] = [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === "actions" && ts.isArrayLiteralExpression(node.initializer)) {
      for (const action of node.initializer.elements) {
        if (!ts.isObjectLiteralExpression(action)) continue;
        const props = new Map(action.properties.filter(ts.isPropertyAssignment).map((p) => [p.name.getText(source), p.initializer]));
        const text = (key: string) => { const value = props.get(key); return value && ts.isStringLiteralLike(value) ? value.text.trim() : ""; };
        if (text("scope") === "workspace" || props.get("userInvokable")?.kind === ts.SyntaxKind.FalseKeyword || props.get("internal")?.kind === ts.SyntaxKind.TrueKeyword) continue;
        actions.push({ file, line: source.getLineAndCharacterOfPosition(action.getStart(source)).line + 1, id: text("id"), label: text("label"), description: text("description") });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return actions;
}

export function checkActions(actions: Action[]): string[] {
const errors: string[] = [];
for (const a of actions) {
  const at = `${a.file}:${a.line} (${a.id})`;
  if (!a.description) errors.push(`${at}: a record button needs a description`);
  if (/^restore$/i.test(a.label)) errors.push(`${at}: say what Restore restores`);
  if (/^\w+$/.test(a.label) && actions.some((b) => b.id !== a.id && b.label.toLowerCase() === a.label.toLowerCase())) errors.push(`${at}: a bare verb shared by two actions needs an object`);
}
return errors;
}

if (process.argv[1]?.endsWith("lint-record-action-copy.ts")) {
  const actions: Action[] = [];
  for (const mod of readdirSync("modules")) {
    const file = `modules/${mod}/src/module.ts`;
    if (existsSync(file)) actions.push(...readActions(file, readFileSync(file, "utf8")));
  }
  const errors = checkActions(actions);
  if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
  console.log("lint:record-action-copy OK");
}
