#!/usr/bin/env node
// Derive every full-sidebar walkthrough page from its top-nav page.
//
//   node scripts/walkthrough-twins.mjs            # report which twins drift
//   node scripts/walkthrough-twins.mjs --write    # rewrite them
//
// docs/walkthroughs/<name>-full-walkthrough.md narrates a run in the default
// top-nav chrome; <name>-full-sidebar-walkthrough.md is the SAME narration over
// the same run captured with TOUR_NAV=side. The twin is a derivation, never
// prose of its own: the layout banner (line 3), the picture folder and the
// regenerate command are swapped, and nothing else. Six twins were
// hand-maintained copies until #3341, when three top-nav pages were rewritten
// for a reshoot and their twins kept the retired prose, silently. This is the
// one place the derivation lives; lint:walkthrough-twins holds each twin to it.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = "docs/walkthroughs";

/** The twin's text, from the top-nav page's text. */
export function deriveTwin(topNav, name) {
  const lines = topNav.split("\n");
  const banner = `> **Full-sidebar layout** — the top bar folds into the left rail (Cobblr's "completely sidebar" nav). Same walkthrough in top-nav: [${name}](./${name}-walkthrough.md).`;
  const bannerAt = lines.findIndex((l) => l.startsWith("> **Top-nav layout**"));
  if (bannerAt >= 0) lines[bannerAt] = banner;
  return lines
    .join("\n")
    .split(`./${name}/top-nav/`).join(`./${name}/sidebar/`)
    .split(`node e2e/${name}-walkthrough.mjs`).join(`TOUR_NAV=side node e2e/${name}-walkthrough.mjs`);
}

/** Every <name> that has both pages (none where docs/ is not checked out,
 *  such as the public export). */
export function twinNames() {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR)
    .filter((f) => f.endsWith("-full-sidebar-walkthrough.md"))
    .map((f) => f.replace(/-sidebar-walkthrough\.md$/, ""))
    .filter((name) => existsSync(join(DIR, `${name}-walkthrough.md`)));
}

/** [{ name, twinPath, drifted }] */
export function checkTwins() {
  return twinNames().map((name) => {
    const topNav = readFileSync(join(DIR, `${name}-walkthrough.md`), "utf8");
    const twinPath = join(DIR, `${name}-sidebar-walkthrough.md`);
    const want = deriveTwin(topNav, name);
    const have = readFileSync(twinPath, "utf8");
    return { name, twinPath, want, drifted: want !== have };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const write = process.argv.includes("--write");
  const rows = checkTwins();
  for (const r of rows) {
    if (!r.drifted) continue;
    if (write) {
      writeFileSync(r.twinPath, r.want);
      console.log(`rewrote ${r.twinPath}`);
    } else {
      console.log(`drifted ${r.twinPath}`);
    }
  }
  const drifted = rows.filter((r) => r.drifted).length;
  console.log(`${rows.length} twin(s), ${drifted} drifted${write && drifted ? ", rewritten" : ""}`);
  process.exit(!write && drifted ? 1 : 0);
}
