// A module's list route must resolve field labels, or it is a second read path
// that disagrees with the first.
//
// The generic entity resolver post-processes what it returns (computed →
// relation → member labels). A module's own list route runs an INDEPENDENT
// query over the same table, so unless it applies the same resolution, the same
// record reads differently depending on which URL you asked for it:
//
//   GET /entities/inventory:part   → "kept_in_label": "Shed"
//   GET /modules/inventory/parts   → metadata.kept_in = "f2e2f8b6-…", no label
//
// That shipped for `relation` when it landed and again for `member`, and in
// both cases the table showed users a raw uuid while every test passed. The
// durable fix is collapsing the two queries; until then this makes the omission
// impossible to add quietly.
//
// The rule: a module file that registers a LIST resolver (so its kind flows
// through the generic pipeline) and ALSO serves its own list route must call
// `platform().entities.withFieldLabels`. Existing offenders are baselined —
// this blocks NEW ones and shrinks as they are fixed.
//
// WHICH QUESTION THIS OWNS (written down, so the next gap is a named one):
// "what does a resolved row look like on a module's own route", and since
// #3061 that includes how a titled work's title READS for the person asking.
// The kernel composes `title` from a record's forms for the request's actor
// (served-title.ts) and withFieldLabels carries the same `title` beside the
// stored `name` on a flat row, so a module route that skips the helper shows
// the stored name where the generic door, search and the assistant show the
// person's format. The DETAIL route is the second place that happens: a
// person opening a book saw the stored name where the table beside it showed
// their format. So a module that serves its own `/:id` must call the helper
// in the file that serves it, with its own baseline of the routes that do
// not yet. Nothing composed is ever writable: the helper adds `title` and
// never touches `name`, and the update schemas do not take `title`.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODULES = join(ROOT, "modules");

/** Routes that list records today WITHOUT label resolution. Shrink this; never
 *  grow it. Each entry is a module whose list route still shows raw ids for a
 *  relation/member field the workspace has added to that kind. */
const BASELINE = new Set<string>([
  "assets",
  "machines",
  "projects",
  "purchases",
  "sales",
  "tracking",
  "records",
  "builds",
  "knowledge",
  "lists",
  "digifab",
  "core-locations",
  "core-catalogs",
]);

/** Modules whose DETAIL route (`/:id`) still answers the stored row alone,
 *  without the helper: a titled work reads in the stored name there while the
 *  list and the generic door read the person's format. Shrink this; never
 *  grow it. */
const DETAIL_BASELINE = new Set<string>([
  "assets",
  "machines",
  "projects",
  "purchases",
  "sales",
  "records",
  "core-locations",
  "core-catalogs",
]);

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e);
    if (/node_modules|dist|\.test\./.test(full)) continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

const offenders: string[] = [];

for (const modDir of readdirSync(MODULES)) {
  const dir = join(MODULES, modDir);
  if (!statSync(dir).isDirectory()) continue;

  const files = walk(dir);
  const sources = files.map((f) => ({ f, text: readFileSync(f, "utf8") }));

  // Does this module put a kind through the generic pipeline?
  const registersList = sources.some((s) => s.text.includes("registerListResolver"));
  if (!registersList) continue;

  // Does it also serve its own list route?
  const servesList = sources.some((s) => /Router\.get\(\s*\n?\s*"\/"/.test(s.text));
  if (!servesList) continue;

  const resolves = sources.some((s) => s.text.includes("withFieldLabels"));
  if (resolves) {
    if (BASELINE.has(modDir)) {
      offenders.push(
        `${modDir}: now resolves labels — remove it from BASELINE in ${relative(ROOT, fileURLToPath(import.meta.url))}`,
      );
    }
    continue;
  }
  if (!BASELINE.has(modDir)) {
    offenders.push(
      `modules/${modDir}: lists records through its own route but never calls ` +
        `platform().entities.withFieldLabels — relation/member fields will render raw ids there.`,
    );
  }
}

// The detail route: the file that serves `/:id` must be a file that calls the
// helper, or the record page shows the stored name (and raw ids) where the
// list and the generic door show the resolved row.
for (const modDir of readdirSync(MODULES)) {
  const dir = join(MODULES, modDir);
  if (!statSync(dir).isDirectory()) continue;
  const sources = walk(dir).map((f) => ({ f, text: readFileSync(f, "utf8") }));
  if (!sources.some((s) => s.text.includes("registerListResolver"))) continue;
  const detailFiles = sources.filter((s) => /Router\.get\(\s*\n?\s*"\/:id"/.test(s.text));
  if (detailFiles.length === 0) continue;
  const resolves = detailFiles.some((s) => s.text.includes("withFieldLabels"));
  if (resolves) {
    if (DETAIL_BASELINE.has(modDir)) {
      offenders.push(`${modDir}: its detail route now resolves the row — remove it from DETAIL_BASELINE in ${relative(ROOT, fileURLToPath(import.meta.url))}`);
    }
    continue;
  }
  if (!DETAIL_BASELINE.has(modDir)) {
    offenders.push(
      `modules/${modDir}: serves a record through its own /:id route but that file never calls ` +
        `platform().entities.withFieldLabels — the record page shows the stored name where the list shows the person's title (#3061).`,
    );
  }
}

if (offenders.length > 0) {
  console.error(
    `Module list routes that disagree with the generic entity API (${offenders.length}):\n` +
      offenders.map((o) => `  ${o}`).join("\n") +
      `\n\nApply it just before responding:\n` +
      `  const rows = await platform().entities.withFieldLabels(orgId, kind, items);\n` +
      `It is a no-op for kinds with no relation/member fields, so call it unconditionally.`,
  );
  process.exit(1);
}
console.log(
  `lint:list-route-labels - every non-baselined module list and detail route resolves the row ✓ ` +
    `(${BASELINE.size} list, ${DETAIL_BASELINE.size} detail baselined)`,
);
