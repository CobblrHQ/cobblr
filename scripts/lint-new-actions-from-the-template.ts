#!/usr/bin/env tsx
// An action a pull request adds comes from pnpm run new action: its handler at src/api/<slug>-action.ts, an api test that names its id, and an example sentence, or it says why not with ACTION-TEMPLATE.
//
// THE BUG THIS PREVENTS. 2026-10-13: only 2 actions in the tree had the scaffolder's layout; core-notifications message-someone (#6097) was hand-written
//
// The owner asked whether new actions use the scaffolder; they did not. What `pnpm run new action` guarantees
// (a handler stub that fails until written, a consequence test named after what a person asks for, an example
// sentence) was left to memory, and the ai-reach lints only hold an action to UI + API + MCP (#6236).
//
// THE RULE. An action ADDED by this change (an `actions: [...]` entry of a modules/*/src/module.ts whose id the
// merge base with main does not have) has what the scaffolder writes:
//   - its handler at modules/<module>/src/api/<slug>-action.ts;
//   - a test that names it: its id ("<module>:<slug>") or its handler key ("<module>.<slug>"), in api/tests or
//     under its module;
//   - at least one `examples` sentence.
// A genuine exception says why on the line above the entry or on its id line: `// ACTION-TEMPLATE: <why>`.
//
// THE BOUNDARY. Only actions this change adds: the tree's existing actions predate the scaffolder (all but two),
// and judging them would be a baseline nobody asked for. A renamed module keeps its ids and adds nothing. With no
// merge base to compare (a shallow clone with no main), it judges nothing and says so.
//
// PROVE IT RED: on #6097's merge-base, core-notifications:message-someone (hand-written at
// src/api/message-someone.ts) is named.
//
//   npx tsx scripts/lint-new-actions-from-the-template.ts   (pnpm lint new-actions-from-the-template)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { apiDirs, manifestSources } from "./lib/manifest-sources.ts";

export interface Action {
  id: string;
  line: number;
  examples: number;
  optOut: string | null;
}

/** PURE. The actions of one manifest source: each entry of an `actions: [...]` array with an id. */
export function actionsOf(src: string): Action[] {
  const sf = ts.createSourceFile("module.ts", src, ts.ScriptTarget.Latest, true);
  const lines = src.split("\n");
  const out: Action[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isPropertyAssignment(n) && n.name.getText(sf) === "actions" && ts.isArrayLiteralExpression(n.initializer)) {
      for (const el of n.initializer.elements) {
        if (!ts.isObjectLiteralExpression(el)) continue;
        let id = "";
        let examples = 0;
        let idLine = 0;
        for (const p of el.properties) {
          if (!ts.isPropertyAssignment(p)) continue;
          const name = p.name.getText(sf);
          if (name === "id" && ts.isStringLiteralLike(p.initializer)) {
            id = p.initializer.text;
            idLine = sf.getLineAndCharacterOfPosition(p.getStart(sf)).line;
          }
          if (name === "examples" && ts.isArrayLiteralExpression(p.initializer)) examples = p.initializer.elements.length;
        }
        if (!id) continue;
        const open = sf.getLineAndCharacterOfPosition(el.getStart(sf)).line;
        const near = [lines[open - 1] ?? "", lines[open] ?? "", lines[idLine] ?? ""].join("\n");
        const m = /\/\/[ \t]*ACTION-TEMPLATE:[ \t]*(\S.*)$/m.exec(near);
        out.push({ id, line: idLine + 1, examples, optOut: m ? m[1]!.trim() : null });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** PURE. What an added action lacks of the template, given what exists. */
export function missing(a: Action, has: { handler: boolean; test: boolean }): string[] {
  if (a.optOut) return [];
  const out: string[] = [];
  const [module, slug] = a.id.split(":");
  if (!has.handler) out.push(`its handler at modules/${module}/src/api/${slug}-action.ts`);
  if (!has.test) out.push(`a test naming "${a.id}" or "${module}.${slug}"`);
  if (a.examples === 0) out.push("an examples sentence");
  return out;
}

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }).trim();
  } catch {
    return null;
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const base = process.env.LINT_ACTIONS_BASE || (["origin/main", "forgejo/main", "main"].map((r) => git(["merge-base", "HEAD", r])).find(Boolean) ?? null);
  if (!base) {
    console.log("lint:new-actions-from-the-template: no merge base with main to compare; judged nothing");
    process.exit(0);
  }
  const violations: string[] = [];
  for (const mod of readdirSync("modules")) {
    const files = manifestSources(join("modules", mod));
    // Before, across the module's manifest files then and now: an action that
    // moved from module.ts into a family's manifest was not added.
    const before = new Set(files.flatMap((f) => actionsOf(git(["show", `${base}:${f}`]) ?? "")).map((a) => a.id));
    for (const file of files) for (const a of actionsOf(readFileSync(file, "utf8"))) {
      if (before.has(a.id)) continue;
      const [module, slug] = a.id.split(":");
      const handler = apiDirs(join("modules", module ?? mod)).some((d) => existsSync(join(d, `${slug}-action.ts`)));
      const named = git(["grep", "-l", "-F", "-e", `"${a.id}"`, "-e", `"${module}.${slug}"`, "--", "api/tests", `modules/${module}`]) ?? "";
      const test = named.split("\n").some((f) => /\.test\.[cm]?[jt]sx?$/.test(f));
      const lack = missing(a, { handler, test });
      if (lack.length) violations.push(`  ${file}:${a.line}  ${a.id} was added without ${lack.join(", ")}`);
    }
  }
  if (violations.length) {
    console.error(`lint:new-actions-from-the-template - ${violations.length} action(s) added by hand:`);
    for (const v of violations) console.error(v);
    console.error('Start an action with: pnpm run new action <module> <slug> --group … --label "…" --description "…" --example "…" --test "…"');
    console.error("A genuine exception says why above its entry: // ACTION-TEMPLATE: <why>");
    process.exit(1);
  }
  console.log("lint:new-actions-from-the-template OK");
}
