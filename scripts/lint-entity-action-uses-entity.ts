// An action that renders a button on a record must DO something with that
// record.
//
// `scope: "entity"` (the default) puts the action in every matching record's
// detail bar. `appliesTo: { any: true }` makes "every matching record" mean
// every record in the workspace. If the handler then never reads `ctx.entity`,
// the button is on the page under false pretences: it either ignores what you
// are looking at, or does nothing at all.
//
// Both shipped. On a location called "Rack 1" the bar offered "Fill fields from
// past receipts" (a workspace-wide sweep that does nothing TO Rack 1) and
// "Identify a thing" (args-driven - with no photo it returns
// `{ identified: false, reason: "nothing to identify" }`). They were on every
// record in the app, crowding the header enough to wrap the title (2026-08-23).
//
// The category already exists: `scope: "workspace"` runs on the workspace, is
// never rendered as an entity-detail button, and stays reachable through the
// same invoke_action rail - so Cobb and MCP keep it. That is the fix, not
// deleting the action.
//
// Wire-only actions (`userInvokable: false`) are exempt: they are event
// targets, never buttons.

import ts from "typescript";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (e === "node_modules" || e === "dist" || e === ".git") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

const files = walk(join(ROOT, "modules"));
const parse = (f: string) =>
  ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true,
    f.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

/** handler name -> does its body reach for the entity? */
const handlerUsesEntity = new Map<string, boolean>();

for (const f of files) {
  const sf = parse(f);
  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      n.expression.getText(sf).endsWith("registerHandler") &&
      n.arguments.length >= 2 &&
      ts.isStringLiteralLike(n.arguments[0]!)
    ) {
      const name = (n.arguments[0] as ts.StringLiteralLike).text;
      const body = n.arguments[1]!.getText(sf);
      // Three ways a handler reaches its record. The shared
      // `requireActionEntity(ctx)` helper is the common one and was missed by
      // the first version of this check, which then accused eleven perfectly
      // correct actions of ignoring their record.
      const uses =
        /\bctx\.entity\b/.test(body) ||
        /\{[^}]*\bentity\b[^}]*\}\s*=\s*ctx\b/.test(body) ||
        /\brequireActionEntity\s*\(/.test(body);
      handlerUsesEntity.set(name, uses || (handlerUsesEntity.get(name) ?? false));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

const prop = (o: ts.ObjectLiteralExpression, key: string): ts.Expression | null => {
  for (const p of o.properties) {
    if (ts.isPropertyAssignment(p) && p.name.getText() === key) return p.initializer;
  }
  return null;
};
const text = (e: ts.Expression | null): string => (e ? e.getText().replace(/["']| as const/g, "") : "");

const violations: Array<{ file: string; line: number; id: string; handler: string }> = [];

for (const f of files.filter((x) => x.endsWith("module.ts"))) {
  const sf = parse(f);
  const visit = (n: ts.Node): void => {
    if (ts.isObjectLiteralExpression(n)) {
      const id = prop(n, "id");
      const handler = prop(n, "invokeHandler");
      if (id && handler) {
        const scope = text(prop(n, "scope")) || "entity";
        const invokable = text(prop(n, "userInvokable"));
        const name = text(handler);
        const known = handlerUsesEntity.has(name);
        if (scope === "entity" && invokable !== "false" && known && !handlerUsesEntity.get(name)) {
          const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
          violations.push({ file: relative(ROOT, f), line: line + 1, id: text(id), handler: name });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

if (violations.length > 0) {
  console.error("lint:entity-action-uses-entity - a record button whose handler ignores the record:\n");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}\n    ${v.id} -> handler ${v.handler} never reads ctx.entity\n`);
  }
  console.error(
    'If it operates on the workspace rather than one record, declare\n' +
      '`scope: "workspace"`: it stops rendering as an entity-detail button and\n' +
      "stays reachable through invoke_action, so Cobb and MCP keep it.\n" +
      "If it is a wire target, set `userInvokable: false`.\n",
  );
  process.exit(1);
}

console.log(`lint:entity-action-uses-entity ✓ ${handlerUsesEntity.size} handlers checked; every record button uses its record.`);
