// Guard: a bundle's scan_keywords never claim a noun that another featured
// bundle IS (its instance name, display name, or item noun).
//
// Two consumers read the same vocabulary and both break on a shared noun:
//   - the scan matchmaker routes on it, so "bookshelf" in the Home Inventory
//     list sends a bookshelf to a home table while a Bookshelf bundle exists;
//   - suggest-featured.ts treats a term two bundles share as carrying NO
//     signal, so typing "bookshelf" on the Build page suggests nothing.
// The second one is how it surfaced (2026-09-02, CI on the home keywords).
// Keep the keyword to the thing itself; if another bundle IS that thing, it
// is that bundle's word. Same stem rule as suggest-featured.ts.
//
// Run:  npx tsx scripts/lint-bundle-keyword-collisions.ts

import fs from "node:fs";
import path from "node:path";

const WORD = /[a-z][a-z0-9-]{2,}/g;
const stem = (w: string): string => w.replace(/(ies|es|s)$/, (m) => (m === "ies" ? "y" : ""));

interface Inst { instance_name?: string; display_name?: string; item_noun?: string; scan_keywords?: string[] }
interface Manifest { id: string; provides_instances?: Inst[]; features?: Array<{ provides_instances?: Inst[] }> }

function main(): void {
  const dir = path.join(process.cwd(), "bundles");
  const bundles: Array<{ id: string; nouns: Set<string>; keywords: Map<string, string> }> = [];
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith(".json") || f.includes("lock")) continue;
    const m = (JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as { manifest?: Manifest }).manifest;
    if (!m) continue;
    const insts = [...(m.provides_instances ?? []), ...(m.features ?? []).flatMap((ft) => ft.provides_instances ?? [])];
    const nouns = new Set<string>();
    const keywords = new Map<string, string>();
    for (const inst of insts) {
      for (const t of [inst.instance_name, inst.display_name, inst.item_noun]) {
        for (const w of (t ?? "").toLowerCase().match(WORD) ?? []) nouns.add(stem(w));
      }
      for (const k of inst.scan_keywords ?? []) keywords.set(stem(k.toLowerCase()), k);
    }
    bundles.push({ id: m.id, nouns, keywords });
  }
  const problems: string[] = [];
  for (const a of bundles) {
    for (const b of bundles) {
      if (a === b) continue;
      for (const [s, raw] of a.keywords) {
        if (b.nouns.has(s)) problems.push(`${a.id}: scan_keyword "${raw}" is what ${b.id} IS - it is that bundle's word`);
      }
    }
  }
  if (problems.length) {
    console.error(`[lint:bundle-keyword-collisions] ✗ ${problems.length} problem(s):`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`[lint:bundle-keyword-collisions] ✓ ${bundles.length} bundles, no keyword claims another bundle's noun`);
}
main();
