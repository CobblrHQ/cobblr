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
// Wire-only actions (`wireOnly: true`) and internal ones are exempt: they
// are event targets, never buttons and never offered to the assistant.
// `userInvokable: false` used to be the exemption, as "wire-only", and since
// #3195 that is not what it means: such an action is not a button but IS
// offered to the assistant, which invokes it ON a record. The exemption
// outlived its reason and hid machines:record-usage, whose handler read
// `args.machineId` and never `ctx.entity`, so "the Rostock Max ran four
// hours yesterday" was refused as "no machineId" on every bench run for a
// week while its marker blamed the prompt (#3142, the 2026-09-22 nightly).

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
/** handler name -> does it ASSERT a record (requireActionEntity throws with none)? */
const handlerRequiresEntity = new Map<string, boolean>();

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
        /\brequireActionEntity\s*\(/.test(body) ||
        // Hands the WHOLE context on, record included: a deprecated alias
        // delegating to its canonical action (digifab:run-command). Read as
        // "ignores the record", it accused the one shape that cannot (#3378).
        /\binvoke\([^)]*,\s*ctx\s*\)/.test(body);
      handlerRequiresEntity.set(name, /\brequireActionEntity\s*\(/.test(body) || (handlerRequiresEntity.get(name) ?? false));
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

/** Actions the narrowed exemption exposed (2026-09-22) that are not yet
 *  resolved, each with the call it needs; #3378 retires them one by one.
 *  A name here is a known debt with an owner, never a reason to add
 *  another: a new violation is a red, whatever this list says. */
/** Actions the narrowed exemption exposed (2026-09-22) that are not yet
 *  resolved, each with the call it needs; #3378 retires them one by one.
 *  A name here is a known debt with an owner, never a reason to add
 *  another: a new violation is a red, whatever this list says.
 *  Emptied 2026-09-22: four handlers took the record they run on, four
 *  kind-wide sweeps said `scope: "workspace"`, and the ninth was this
 *  check not knowing that handing the whole ctx on carries the record. */
const STILL_IGNORING_THE_RECORD: Record<string, string> = {};

const violations: Array<{ file: string; line: number; id: string; handler: string }> = [];
const optionalButRequired: string[] = [];
const carried: string[] = [];

for (const f of files.filter((x) => x.endsWith("module.ts") || /\/src\/families\/[^/]+\/manifest\.ts$/.test(x) || /\/src\/actions\/[^/]+\.ts$/.test(x))) {
  const sf = parse(f);
  const visit = (n: ts.Node): void => {
    if (ts.isObjectLiteralExpression(n)) {
      const id = prop(n, "id");
      const handler = prop(n, "invokeHandler");
      if (id && handler) {
        const scope = text(prop(n, "scope")) || "entity";
        const wireOnly = text(prop(n, "wireOnly")) === "true";
        const internal = text(prop(n, "internal")) === "true";
        const name = text(handler);
        const known = handlerUsesEntity.has(name);
        // `recordOptional: true` says the action runs with no record; a handler
        // that asserts one (requireActionEntity) throws on exactly that call,
        // so the door would let through what the handler cannot serve (#3255).
        if (text(prop(n, "recordOptional")) === "true" && handlerRequiresEntity.get(name)) {
          const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
          optionalButRequired.push(`${relative(ROOT, f)}:${line + 1}  ${text(id)} is recordOptional but its handler ${name} calls requireActionEntity, which throws with no record; read ctx.entity when it is there instead`);
        }
        if (scope === "entity" && !wireOnly && !internal && known && !handlerUsesEntity.get(name)) {
          if (STILL_IGNORING_THE_RECORD[text(id)]) carried.push(text(id));
          else {
            const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
            violations.push({ file: relative(ROOT, f), line: line + 1, id: text(id), handler: name });
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

if (optionalButRequired.length > 0) {
  console.error("lint:entity-action-uses-entity - an action that runs with no record, whose handler requires one:\n");
  for (const v of optionalButRequired) console.error(`  ${v}`);
  process.exit(1);
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
      "If it is only ever a wire target, set `wireOnly: true` (`userInvokable: false`\n" +
      "still offers it to the assistant, which runs it on a record).\n",
  );
  process.exit(1);
}

// A name on the list that no longer violates is a debt paid: say so, and
// make its line go, so the list only ever shrinks.
const paid = Object.keys(STILL_IGNORING_THE_RECORD).filter((id) => !carried.includes(id));
if (paid.length) {
  console.error(`lint:entity-action-uses-entity - ${paid.length} name(s) on STILL_IGNORING_THE_RECORD no longer violate; remove them: ${paid.join(", ")}`);
  process.exit(1);
}
console.log(
  `lint:entity-action-uses-entity ✓ ${handlerUsesEntity.size} handlers checked; every record button uses its record` +
  (carried.length ? ` (${carried.length} carried on #3378: ${carried.join(", ")})` : "") + ".",
);
