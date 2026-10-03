#!/usr/bin/env tsx
// A client never puts a list of record ids in a URL (ids=…, .set("…ids", …)): a long list is refused with 414 URI Too Long, so it rides in a POST body; a list that is bounded says id-list-in-url: <why>
//
// THE BUG THIS PREVENTS. A large collection's page asked for its cards'
// picture states with every record id in the query string, and the proxy in
// front of the api answered 414 URI Too Long on the assets list and every
// asset page, at every width (#4653, 2026-10). Nothing failed in development,
// where no proxy sits in front and the lists were short; two more clients
// (the scan session's theme, the assistant's offers) were one big session
// away from the same.
//
// THE RULE. In a web client (web/src, packages/*/src, module UIs), a URL may
// not carry a list of ids: a query parameter named `ids` or `<thing>_ids`
// set with URLSearchParams.set or written into a URL template (`ids=${…}`).
// Send the list in a POST body. A list that is bounded by something other
// than the data (the installed catalogs, a handful at most) opts out with
// `id-list-in-url: <why it stays short>` on the line or within the three above.
// Tests are not judged.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Lists of words (sort keys,
// action names, auth methods) are joined into query strings too and are
// bounded by the code, not the data, so the rule keys on the parameter NAME
// ending in "ids", not on .join(","). A cache key built by joining ids (the
// chat context's) is not a URL and is not judged.
//
// PROVE IT RED before you trust it green: it failed on photoSuggestions,
// scanSessionTheme, aiChatOffers and searchCatalogs at origin/main a82d3d54b
// (COBBLR_LINT_ROOT=<a checkout> points it at another tree).
//
//   npx tsx scripts/lint-id-lists-ride-in-the-body.ts   (pnpm lint id-lists-ride-in-the-body)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const BASE = process.env.COBBLR_LINT_ROOT?.trim() || ".";
const ROOTS = ["web/src", "packages", "modules"].map((r) => join(BASE, r));
/** Web clients only: module UIs and package sources, never the api side. */
const inScope = (rel: string) =>
  rel.startsWith("web/src/") || (rel.startsWith("packages/") && /\/src\//.test(rel)) || (rel.startsWith("modules/") && /\/ui\//.test(rel));
const IN_URL = [/\.set\(\s*["'][a-z_]*ids["']\s*,/, /[?&][a-z_]*ids=\$\{/];

/** One offending place. `line` is 1-based for a clickable path:line. */
interface Violation {
  file: string;
  line: number;
  what: string;
}

function* walk(dir: string): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!IN_URL.some((re) => re.test(line))) continue;
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*")) continue;
    const near = lines.slice(Math.max(0, i - 3), i + 1).join("\n");
    const note = /id-list-in-url:\s*(.*)/.exec(near);
    if (note && note[1]!.trim().length >= 8) continue;
    out.push({
      file,
      line: i + 1,
      what: note ? "an id-list-in-url: annotation with no reason" : "a list of ids in a URL; send it in a POST body (a long one is refused with 414), or say id-list-in-url: <why it stays short>",
    });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (inScope(BASE === "." ? file : file.slice(BASE.length + 1))) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:id-lists-ride-in-the-body - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:id-lists-ride-in-the-body OK`);
