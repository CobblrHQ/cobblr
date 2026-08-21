#!/usr/bin/env tsx
/**
 * lint:platform-affordances — the platform decides where its affordances go,
 * not each page.
 *
 * The Cobb button lived only in `EntityActionsBar`, a DETAIL-page component, so
 * every hand-rolled list quietly had no way to say "this one" to the assistant.
 * The obvious repair is to paste `<AskCobbAbout kind="core-locations:location"
 * …>` into the page that got noticed — and that is the trap: the affordance now
 * exists on exactly the screens someone complained about, each page hardcodes a
 * kind string, and the next list ships without it while nothing says so. That
 * edit was caught in review, one line before it shipped; this lint is what
 * replaces the review.
 *
 * The rule: a shared affordance is placed by `packages/platform-web` only.
 * A page declares WHAT a row is (`RecordRow` / `recordRowMarks`, or
 * `EntityActionsBar` on a detail page) and the platform decides what appears on
 * it — so adding something to every record row later happens in one file.
 *
 * Genuinely need one by hand? Say why:
 *     // PLATFORM-AFFORDANCE-OK: <reason>
 * on the line above.
 *
 * Run: npx tsx scripts/lint-platform-affordances.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
/** Where a page/module lives. The platform package itself is the author of
 *  these components and is exempt by definition. */
const CONSUMER_ROOTS = ["web/src", "modules"];
const PLATFORM_ROOT = "packages/platform-web";

/** Components the PLATFORM places. Add to this list when a new one ships —
 *  that is the moment to decide it belongs on every record, not on one page. */
const PLATFORM_PLACED = ["AskCobbAbout"] as const;

const EXEMPT = /PLATFORM-AFFORDANCE-OK:\s*\S+/;

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(join(ROOT, dir));
  } catch {
    return out;
  }
  for (const name of entries) {
    const rel = `${dir}/${name}`;
    if (name === "node_modules" || name === "dist") continue;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (/\.tsx?$/.test(name) && !name.includes(".test.")) out.push(rel);
  }
  return out;
}

const findings: string[] = [];
for (const file of CONSUMER_ROOTS.flatMap((r) => walk(r))) {
  if (file.startsWith(PLATFORM_ROOT)) continue;
  const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const name of PLATFORM_PLACED) {
      // A JSX use, not a mention in prose or an import of something else.
      if (!new RegExp(`<${name}[\\s/>]`).test(line)) continue;
      const prev = `${lines[i - 1] ?? ""}${lines[i - 2] ?? ""}`;
      if (EXEMPT.test(prev) || EXEMPT.test(line)) continue;
      findings.push(`  ${file}:${i + 1}  places <${name}> by hand`);
    }
  });
}

if (findings.length) {
  console.error(`❌ ${findings.length} page(s) placing a platform affordance directly:\n`);
  console.error(findings.join("\n"));
  console.error(
    "\nA page says what a row IS; the platform says what appears on it:\n" +
      "  a list row      → wrap the row's cluster in <RecordRow kind id label>\n" +
      "  a detail page   → <EntityActionsBar entityKind entityId entityLabel>\n" +
      "  neither fits    → // PLATFORM-AFFORDANCE-OK: <reason>\n" +
      "Otherwise the affordance exists only on the screens someone complained about.",
  );
  process.exit(1);
}
console.log(`platform-affordances lint: clean (${PLATFORM_PLACED.length} platform-placed component(s))`);
