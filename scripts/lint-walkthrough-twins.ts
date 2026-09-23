#!/usr/bin/env tsx
// A full-sidebar walkthrough page is its top-nav page with the layout banner, the picture folder and the regenerate command swapped, and nothing else; scripts/walkthrough-twins.mjs --write derives it.
//
// THE BUG THIS PREVENTS. Six sidebar twins were hand-maintained copies of
// their top-nav pages. When the tier-1 reshoot rewrote three top-nav pages
// (a dropdown that is a picker now, a bundle that no longer exists, a scan
// card door that was retired), their twins kept the retired prose with no
// signal at all; two more had a regenerate command missing the TOUR_NAV=side
// that the twin's own pictures need (#3341).
//
// THE RULE. For every docs/walkthroughs/<name>-sidebar-walkthrough.md with a
// <name>-walkthrough.md beside it, the twin's text equals
// deriveTwin(topNav, name) from scripts/walkthrough-twins.mjs, byte for byte.
// There is no opt-out: a twin that needs prose of its own is not a twin, and
// takes a name that does not end in -sidebar-walkthrough.md.
//
// PROVED RED 2026-09-22 against main's five drifted twins (bjorn, bramble,
// home-life, wardrobe, yarn); green after
// `node scripts/walkthrough-twins.mjs --write`.
//
//   npx tsx scripts/lint-walkthrough-twins.ts   (pnpm run lint walkthrough-twins)
import { checkTwins } from "./walkthrough-twins.mjs";

interface Twin {
  name: string;
  twinPath: string;
  drifted: boolean;
}

const rows = checkTwins() as Twin[];
const drifted = rows.filter((r) => r.drifted);

if (drifted.length) {
  console.error(`lint:walkthrough-twins - ${drifted.length} twin(s) drifted from their top-nav page:`);
  for (const r of drifted) console.error(`  ${r.twinPath}:1  differs from deriveTwin(${r.name}-walkthrough.md)`);
  console.error("Run node scripts/walkthrough-twins.mjs --write and commit the twin; never edit a twin by hand.");
  process.exit(1);
}
console.log(`lint:walkthrough-twins OK (${rows.length} twins match their top-nav pages)`);
