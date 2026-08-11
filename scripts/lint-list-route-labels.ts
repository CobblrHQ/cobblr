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
  `lint:list-route-labels - every non-baselined module list route resolves field labels ✓ ` +
    `(${BASELINE.size} baselined)`,
);
