#!/usr/bin/env tsx
// A screen that shows a table (an instance) names its things with that table's own noun, never the base kind's: a literal like New part, Delete machine or 3 assets on a screen InstancePage hands an item noun to fails, because a Lego Sets table then reads New part for a set.
//
// THE BUG THIS PREVENTS. A Lego workspace's inventory said Parts, search parts
// and New part for whole sets on the homepage still (#5083, 2026-10-09). The
// tab and the button had been moved onto the table's noun; the confirm, the
// count after a bulk delete and the empty state had not, and nothing said so.
//
// THE RULE. The screens are DISCOVERED, not listed: every branch of
// web/src/pages/InstancePage.tsx that renders a module's page with an
// `itemNoun` is a screen a table's own noun reaches. A package UI
// (`@cobblr/<m>/ui`) is judged as its whole modules/<m>/src/ui folder; a page
// in web/src/pages is judged as that file. The base noun is the module's own
// declaration (the first `displayName` / `displayNamePlural` in
// modules/<m>/src/module.ts). In those files, a user-facing literal (a quoted
// string, a template's text, JSX text) that names the base noun as a word,
// singular or plural, fails. The words come from the table's noun pair
// instead: `itemNoun` / `itemNounPlural`, through countOf / wordForCount
// (@cobblr/platform-contract) for counts.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Copy that is about the base
// kind itself stays: a distributor's "Manufacturer part number", a laser
// sheet's "placed part", "stops being part of this item". Those carry
// `// base-noun-ok: <why>` on the line or the one above. Kind identifiers
// (`inventory:part`), query keys, route segments and a lone lower-case
// identifier (`"part"`, a type name) are not prose and are skipped. So is the
// one fallback a surface keeps for its base table, which says so with the
// same marker. A lone lower-case word is skipped as an identifier, so a
// fallback heading written as one ("projects") is not caught: a known gap,
// kept because the identifiers far outnumber it.
//
//   npx tsx scripts/lint-a-table-says-its-own-noun.ts   (pnpm lint a-table-says-its-own-noun)
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

interface Violation {
  file: string;
  line: number;
  what: string;
}

const INSTANCE_PAGE = "web/src/pages/InstancePage.tsx";

/** The screens a table's noun reaches, and each one's base noun. */
export function discoverSurfaces(): Array<{ module: string; files: string[]; singular: string; plural: string }> {
  const page = readFileSync(INSTANCE_PAGE, "utf8");
  const imports = new Map<string, string>();
  for (const m of page.matchAll(/import\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g)) {
    for (const name of m[1]!.split(",").map((s) => s.trim().replace(/^type\s+/, ""))) if (name) imports.set(name, m[2]!);
  }
  const out: Array<{ module: string; files: string[]; singular: string; plural: string }> = [];
  for (const b of page.matchAll(/module_name === "([a-z-]+)"\)\s*\{([\s\S]*?)\n  \}/g)) {
    const module = b[1]!;
    const body = b[2]!;
    if (!/itemNoun=/.test(body)) continue;
    const comp = body.match(/<([A-Z][A-Za-z]+)/)?.[1];
    const from = comp ? imports.get(comp) : undefined;
    if (!from) continue;
    const files = from.startsWith("@cobblr/") ? [...walk(`modules/${module}/src/ui`)] : [`web/src/pages/${from.replace(/^\.\//, "")}.tsx`];
    const manifest = `modules/${module}/src/module.ts`;
    if (!existsSync(manifest)) continue;
    const src = readFileSync(manifest, "utf8");
    const singular = src.match(/displayName: "([^"]+)",\s*displayNamePlural: "([^"]+)"/) ?? src.match(/entityKinds:[\s\S]*?displayName: "([^"]+)"/);
    if (!singular) continue;
    const one = singular[1]!.toLowerCase();
    out.push({ module, files, singular: one, plural: (singular[2] ?? `${one}s`).toLowerCase() });
  }
  return out;
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
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}

/** The prose pieces of a line: quoted strings, a template's text outside its
 *  ${…}, and JSX text between tags. */
function prose(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|`([^`]*)`|>([^<>{}]+)</g)) {
    const t = m[1] ?? m[2] ?? (m[3] !== undefined ? m[3].replace(/\$\{[^}]*\}/g, " ") : undefined) ?? m[4];
    if (t !== undefined) out.push(t);
  }
  return out;
}

export function check(file: string, src: string, singular: string, plural: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  const word = new RegExp(`\\b(${singular}|${plural})\\b`, "i");
  let inComment = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const s = line.trim();
    // Inside a /* ... */ block (a JSX {/* */} comment over several lines).
    if (inComment) {
      if (s.includes("*/")) inComment = false;
      continue;
    }
    if (/\/\*/.test(s) && !s.includes("*/")) inComment = true;
    if (s.startsWith("//") || s.startsWith("*") || s.startsWith("/*") || s.startsWith("{/*") || s.startsWith("import ")) continue;
    if (/base-noun-ok: \S/.test(line) || /base-noun-ok: \S/.test(lines[i - 1] ?? "")) continue;
    for (const t of prose(line)) {
      if (!word.test(t)) continue;
      // Not prose: a kind id, a route, a query key, a lone identifier.
      if (/\b[a-z-]+:[a-z_]+\b/.test(t) || /^\//.test(t.trim()) || /\/$/.test(t.trim())) continue;
      if (/^[a-z_-]+$/.test(t.trim())) continue;
      // A storage key, a route pattern, a kind prefix: no spaces and a . : or /.
      if (!/\s/.test(t.trim()) && /[.:/]/.test(t)) continue;
      if (/queryKey/.test(line)) continue;
      out.push({ file, line: i + 1, what: `"${t.trim().slice(0, 60)}" names the base ${singular} on a screen a table's own noun reaches` });
      break;
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const s of discoverSurfaces()) for (const file of s.files) violations.push(...check(file, readFileSync(file, "utf8"), s.singular, s.plural));

if (violations.length) {
  console.error(`lint:a-table-says-its-own-noun - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("build the words from the table's noun pair (itemNoun / itemNounPlural, countOf / wordForCount from @cobblr/platform-contract), or mark a copy that is genuinely about the base kind with // base-noun-ok: <why>");
  process.exit(1);
}
console.log(`lint:a-table-says-its-own-noun OK`);
