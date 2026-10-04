#!/usr/bin/env tsx
// Record actions declare a registered group, and group names cannot duplicate existing vocabulary.
// Platform buttons once bypassed the action fold. Manifest actions and the
// platform's record contributions share one vocabulary; workspace labels are
// user data and are deliberately outside this check.
import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";
import { ACTION_GROUPS, actionGroupCollision, similarActionGroup } from "../packages/platform-contract/src/action-groups.ts";
const errors: string[] = [];
const collision = actionGroupCollision(ACTION_GROUPS);
if (collision) errors.push(`${collision.group.id}: looks like ${collision.existing.label}; use ${collision.existing.id}`);
for (const name of readdirSync("modules")) {
  const file = `modules/${name}/src/module.ts`;
  let source: string; try { source = readFileSync(file, "utf8"); } catch { continue; }
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  function visit(node: ts.Node) {
    if (ts.isObjectLiteralExpression(node)) {
      const props = new Map(node.properties.filter(ts.isPropertyAssignment).map((p) => [p.name.getText(tree).replace(/["']/g, ""), p.initializer]));
      if (props.has("id") && props.has("label") && (props.has("invokeHandler") || props.has("invokeRoute"))) {
        const id = props.get("id")!.getText(tree);
        const group = props.get("group")?.getText(tree).replace(/["']/g, "");
        if (!group || !ACTION_GROUPS.some((g) => g.id === group)) errors.push(`${file}:${tree.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${id}: use a registered action group${group && similarActionGroup(group) ? ` (${similarActionGroup(group)!.id})` : ""}`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
}
for (const file of ["RecordDisposition", "RecordSharing", "RecordPublic", "RecordSendBack"]) {
  const source = readFileSync(`packages/platform-web/src/${file}.tsx`, "utf8");
  for (const tag of source.matchAll(/<RecordActionItem\b([^>]*?)(?:>|\/>)/gs)) {
    const group = /\bgroup="([^"]+)"/.exec(tag[1]!)?.[1];
    if (!group || !ACTION_GROUPS.some((g) => g.id === group)) errors.push(`${file}: record contribution needs a registered group`);
  }
  if (!source.includes("<RecordActionItem")) errors.push(`${file}: record controls must contribute menu items`);
}
if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
else console.log("lint:action-groups OK");
