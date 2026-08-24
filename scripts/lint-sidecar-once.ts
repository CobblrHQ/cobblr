// Guard: a record's side-cars appear ONCE per page.
//
// There are two ways a detail view gets tags and discussion, and both are
// correct for who they serve:
//
//   EntityAttachments        — the web app's own pages import it directly.
//   a universal detail PANEL — module-owned pages, which may not import from
//                              web/src, receive it through the panel seam.
//
// A page that renders BOTH gets two tag rows and two conversation cards for
// the same record. Nothing errors. It just looks broken, and only to whoever
// opens that particular page — which on 2026-08-24 was machines, the single
// page in the app that happened to host both.
//
// So this fails the build on a page that renders both without saying which
// half it is dropping. The fix is one prop:
//
//   <EntityAttachments … omit={["tags", "discussion"]} />
//
// Run: npx tsx scripts/lint-sidecar-once.ts

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["web/src", "modules"];

/** Side-cars that ALSO arrive as a universal panel, and so can double up. */
const DOUBLED = ["tags", "discussion"] as const;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(p)) out.push(p);
  }
  return out;
}

const problems: string[] = [];

for (const root of ROOTS) {
  for (const file of walk(root)) {
    const src = readFileSync(file, "utf8");
    // The component being USED, not merely imported or defined.
    const usesAttachments = /<EntityAttachments\b/.test(src);
    const usesPanels = /<ContributedDetailPanels\b/.test(src);
    if (!usesAttachments || !usesPanels) continue;

    const omitted = new Set<string>();
    for (const m of src.matchAll(/omit=\{\[([^\]]*)\]\}/g)) {
      for (const part of (m[1] ?? "").split(",")) {
        const t = part.trim().replace(/^["']|["']$/g, "");
        if (t) omitted.add(t);
      }
    }
    const missing = DOUBLED.filter((d) => !omitted.has(d));
    if (missing.length > 0) {
      problems.push(
        `${file}\n    renders EntityAttachments AND ContributedDetailPanels, so ${missing
          .map((m) => `"${m}"`)
          .join(" and ")} would appear twice.\n` +
          `    Fix: <EntityAttachments … omit={[${DOUBLED.map((d) => `"${d}"`).join(", ")}]} />`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error("lint:sidecar-once — a record's side-cars must appear once per page:\n");
  for (const p of problems) console.error(`  ${p}\n`);
  process.exit(1);
}

console.log("lint:sidecar-once — no page renders a record's side-cars twice.");
