// A computed context must not filter on the kind it was handed.
//
// registerComputedContext is called with the PRESENTATION kind: "inventory:part"
// for a module's default instance, but "<instance>:item" for a skinned one —
// "tea:item", "vehicles:item", "filament-types:item". Almost everything that
// WRITES a row writes the BASE kind, so a provider that does
//
//     .where("entity_kind", "=", kind)
//
// matches nothing the moment its kind is used by an instance. What makes this
// worth a lint rather than a code review note is the failure MODE: the provider
// returns an empty bag, every computed column renders blank, and blank is also
// the honest "not enough data yet" state. So a whole table of empty cells looks
// like a cold start and nobody investigates. It shipped exactly once, in
// core-cadence, and cost a deploy to find.
//
// The fix is one line — resolve through platform().entities.baseKindOf() and
// match both — so the rule is: if a provider body mentions the kind parameter
// in a filter, it must also call baseKindOf. A provider that ignores its kind
// entirely (inventory's `_kind`) is fine and passes untouched.
//
//   npx tsx scripts/lint-computed-context-kind.ts

import { readFileSync } from "node:fs";
import { sourceFiles } from "./lib/glob-exclude.mjs";

const files = sourceFiles("{api,modules,packages}/**/*.ts").filter((f) => !f.endsWith(".test.ts"));

const problems: string[] = [];

for (const file of files) {
  const src = readFileSync(file, "utf8");
  if (!src.includes("registerComputedContext(")) continue;

  // Each registration, from its opening paren to a closing "});" at the same
  // indent. Crude but the shape is consistent and a false positive here is a
  // one-line comment away from resolved.
  const re = /registerComputedContext\(\s*["'`][^"'`]+["'`]\s*,\s*async\s*\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const params = (m[1] ?? "").split(",").map((s) => s.trim());
    const kindParam = params[1] ?? "";
    // An underscore-prefixed param is the author saying "I do not use this".
    if (!kindParam || kindParam.startsWith("_")) continue;

    const body = src.slice(m.index, src.indexOf("\n  });", m.index) + 6);
    const filtersOnKind = new RegExp(
      `\\.where\\([^)]*kind[^)]*\\b${kindParam}\\b|entity_kind[^\\n]*\\b${kindParam}\\b|\\b${kindParam}\\b[^\\n]*entity_kind`,
    ).test(body);
    if (!filtersOnKind) continue;

    if (!body.includes("baseKindOf")) {
      const line = src.slice(0, m.index).split("\n").length;
      problems.push(
        `${file}:${line} — this provider filters on \`${kindParam}\` but never calls baseKindOf().\n` +
          `      An instance passes "<instance>:item" here while the rows carry the base kind,\n` +
          `      so it will silently return nothing and every computed column will render blank.\n` +
          `      Fix: const base = await platform().entities.baseKindOf(orgId, ${kindParam});\n` +
          `           .where("entity_kind", "in", base === ${kindParam} ? [${kindParam}] : [${kindParam}, base])`,
      );
    }
  }
}

if (problems.length) {
  console.error(`lint:computed-context-kind: ${problems.length} provider(s) filter on the presentation kind:\n`);
  for (const p of problems) console.error(`  ✗ ${p}\n`);
  process.exit(1);
}
console.log("lint:computed-context-kind: every computed context resolves the kind it filters on ✓");
