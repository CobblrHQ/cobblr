#!/usr/bin/env tsx
// Every scan row the API returns must go through withTitle().
//
// WHY THIS IS A LINT: the item's displayed title is DERIVED (the stored name
// plus the resolved colour). It is derived precisely because storing it did not
// work - NINE passes write `suggested_name`, two of them detached after the
// response, so a composed title was silently dropped by whichever finished last.
// That bug was "fixed" three times by patching write sites before the derivation
// landed (the author, 2026-07-30: "at the end of the AI run the title lost blue").
//
// The derivation only holds if every response applies it. A new endpoint that
// returns a row raw would reintroduce the exact symptom - a card whose title is
// missing the colour - with nothing failing. Hence: a check, not a convention.
//
//   npx tsx scripts/lint-scan-row-title.ts    (npm run lint:scan-row-title)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = join(ROOT, "modules", "core-scan", "src", "api", "inbox.ts");
const src = readFileSync(FILE, "utf8");

// Variables that hold a scan ROW in this file. A res.json() of one of these
// (bare, or awaited) must be wrapped.
const ROW_VARS = ["row", "fresh", "resolvedRow", "updated", "created", "item"];
const offenders: Array<{ line: number; text: string }> = [];

src.split("\n").forEach((text, i) => {
  const t = text.trim();
  if (!t.includes("res.json(")) return;
  if (t.includes("withTitle(")) return; // already composed
  for (const v of ROW_VARS) {
    // res.json(row)  |  res.json(await fresh())  |  res.json({ item: resolvedRow
    const bare = new RegExp(`res\\.json\\(\\s*(await\\s+)?${v}\\b`);
    const keyed = new RegExp(`res\\.json\\(\\{[^}]*\\b(item|items)\\s*:\\s*(await\\s+)?${v}\\b`);
    if (bare.test(t) || keyed.test(t)) {
      offenders.push({ line: i + 1, text: t.slice(0, 100) });
      return;
    }
  }
  // The inbox LIST (its signature is items + batches). Deliberately narrow:
  // other endpoints return `items` that are not scan rows - the photo-options
  // strip returns image candidates - and flagging those would train people to
  // ignore this lint.
  if (/res\.json\(\{\s*items\s*,[^)]*batches/.test(t)) {
    offenders.push({ line: i + 1, text: t.slice(0, 100) });
  }
});

if (offenders.length === 0) {
  console.log("[lint:scan-row-title] ✓ every scan row returned by the API composes its title.");
  process.exit(0);
}
console.error(
  `\n[lint:scan-row-title] ✗ ${offenders.length} response(s) return a scan row WITHOUT withTitle(), so the` +
    ` card would show a title missing its colour:\n`,
);
for (const o of offenders) console.error(`  ${relative(ROOT, FILE)}:${o.line}  ${o.text}`);
console.error(
  `\nWrap it: res.json(withTitle(row)) / items.map(withTitle).\n` +
    `The title is DERIVED (stored name + resolved colour) because storing it lost it:\n` +
    `nine passes write suggested_name and two run detached after the response.\n`,
);
process.exit(1);
