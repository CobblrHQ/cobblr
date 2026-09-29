#!/usr/bin/env tsx
// On a phone the scan inbox's open search takes a line of its own under the
// header row and never covers the counts or Set location.
//
// THE BUG THIS PREVENTS. The search box on a phone was a magnifier that, once
// tapped, was laid absolutely over the whole header row (2026-08-10, because
// sharing the row left the field a stub). While a search held text it stayed
// open, so the counts and "Set location" were hidden for as long as you were
// looking for something: you could not see or change where the next scan
// files (2026-09-29, reported beside #3996). Now it opens as a full-width line
// under the row. Nothing in a typecheck or a unit test sees a class string
// move the box back over the row, and the page header is too entangled with
// the page to lay out on its own, so the shape is held here.
//
// THE RULE. In web/src/pages/ScanPage.tsx:
//   - the search box's OPEN classes (the `omniOpen ? "..."` branch on the
//     label that holds the "Search the inbox" input) carry `max-sm:basis-full`
//     and never `max-sm:absolute`, `max-sm:fixed` or `max-sm:inset-*`;
//   - the header row (`data-inbox-header`) turns on `max-sm:flex-wrap` while
//     the search is open, which is what gives the box its line.
// A different phone design opts out by changing this lint in the same change,
// with the reason, never by an annotation beside the class.
//
// THE BOUNDARY. Only the open branch is judged: the closed box is
// `hidden sm:flex` on a phone and covers nothing. Desktop classes (no
// `max-sm:` prefix) are not judged: there the box is elastic in the row.
//
//   npx tsx scripts/lint-inbox-search-keeps-the-row.ts   (pnpm lint inbox-search-keeps-the-row)
import { readFileSync } from "node:fs";
import { stripComments } from "./lib/source-scan.js";

const FILE = "web/src/pages/ScanPage.tsx";
const src = stripComments(readFileSync(FILE, "utf8"));
const errors: string[] = [];
const lineOf = (i: number) => src.slice(0, i).split("\n").length;

const INPUT = 'aria-label="Search the inbox, or paste a UPC or link to add"';
const inputAt = src.indexOf(INPUT);
if (inputAt === -1) {
  errors.push(`${FILE}: could not find the inbox search input (${INPUT}); if it was renamed, update this lint`);
} else {
  const labelAt = src.lastIndexOf("<label", inputAt);
  const box = src.slice(labelAt, inputAt);
  const open = /omniOpen\s*\?\s*"([^"]*)"/.exec(box);
  if (!open) {
    errors.push(`${FILE}:${lineOf(labelAt)}: the search box has no \`omniOpen ? "..."\` open classes to judge`);
  } else {
    const at = `${FILE}:${lineOf(labelAt + open.index)}`;
    const cls = open[1] ?? "";
    for (const bad of cls.split(/\s+/).filter((c) => /^max-sm:(absolute|fixed|inset)/.test(c))) {
      errors.push(`${at}: the open search uses \`${bad}\` on a phone, which lays it over the header row`);
    }
    if (!/(^|\s)max-sm:basis-full(\s|$)/.test(cls)) errors.push(`${at}: the open search on a phone must take its own line (\`max-sm:basis-full\`)`);
  }
}

const ROW = "data-inbox-header";
const rowAt = src.indexOf(ROW);
if (rowAt === -1) {
  errors.push(`${FILE}: could not find the ${ROW} anchor on the inbox header row`);
} else {
  const opening = src.slice(rowAt, src.indexOf(">", src.indexOf("}", rowAt)) + 1);
  if (!/omniOpen\s*\?\s*"[^"]*max-sm:flex-wrap/.test(opening)) {
    errors.push(`${FILE}:${lineOf(rowAt)}: the header row must wrap on a phone while the search is open (\`omniOpen ? "max-sm:flex-wrap ..."\`)`);
  }
}

if (errors.length) {
  console.error(`lint:inbox-search-keeps-the-row - ${errors.length} violation(s):`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log("lint:inbox-search-keeps-the-row OK - the open search has its own line on a phone");
