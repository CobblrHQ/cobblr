// A bundle app's `view` / `stat` block must name a view the bundle provides.
//
// Those two blocks bind to a saved view by database id. A bundle author has no
// id: the views the bundle provides do not exist until it is installed, and
// they get a different id in every workspace. So for a long time a bundle app
// simply could not use them, and both apps that shipped (Outfit Planner,
// Cataloging Bench) fell back to one enormous Tier-B `custom` HTML blob to
// render what should have been a table. Nobody wrote that down; the next author
// rediscovered it by reading the install code.
//
// Install now resolves a `view_name` against the views that bundle just seeded
// (api/src/routes/bundle-app-view-refs.ts). This lint is the other half: it
// makes the two ways of getting it wrong impossible to author.
//
//   1. A hardcoded `view_id`. It can never be a real row - whatever uuid the
//      author pasted belongs to their own workspace, if anywhere. Installed
//      elsewhere the block renders nothing, silently.
//   2. A `view_name` no saved_views entry in the same bundle declares. Same
//      silent-empty outcome, one typo away at all times.
//
// Both used to fail only at install, in a try/catch that logs and continues, on
// somebody else's machine.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "bundles");

const VIEW_BLOCK_TYPES = new Set(["view", "stat"]);

interface SavedView {
  name?: unknown;
  entity_kind?: unknown;
}
interface Instance {
  saved_views?: SavedView[];
}
interface App {
  slug?: unknown;
  pages?: Array<{ slug?: unknown; blocks?: unknown[] }>;
}
interface Feature {
  saved_views?: SavedView[];
  provides_instances?: Instance[];
  provides_apps?: App[];
}
interface Manifest {
  saved_views?: SavedView[];
  provides_instances?: Instance[];
  provides_apps?: App[];
  features?: Feature[];
}

/** Every saved view the bundle declares, from all four places it can declare one. */
function providedViews(m: Manifest): SavedView[] {
  const fromInstances = (list: Instance[] | undefined) =>
    (list ?? []).flatMap((i) => i.saved_views ?? []);
  return [
    ...(m.saved_views ?? []),
    ...fromInstances(m.provides_instances),
    ...(m.features ?? []).flatMap((f) => [...(f.saved_views ?? []), ...fromInstances(f.provides_instances)]),
  ];
}

function allApps(m: Manifest): App[] {
  return [...(m.provides_apps ?? []), ...(m.features ?? []).flatMap((f) => f.provides_apps ?? [])];
}

const violations: string[] = [];

for (const file of readdirSync(DIR).filter((f) => f.endsWith(".json"))) {
  let m: Manifest;
  try {
    // A generated bundle file wraps its manifest: { "manifest": { … } }.
    // Reading the top level instead makes every check pass vacuously, which is
    // exactly the silent-green this lint exists to prevent, so be explicit.
    const parsed = JSON.parse(readFileSync(join(DIR, file), "utf8")) as { manifest?: Manifest };
    if (!parsed.manifest) continue; // not a bundle file (e.g. the version lock)
    m = parsed.manifest;
  } catch {
    continue; // lint:bundle-schema owns malformed JSON
  }

  const views = providedViews(m);
  const names = new Set(views.map((v) => String(v.name)));

  for (const app of allApps(m)) {
    for (const page of app.pages ?? []) {
      for (const block of page.blocks ?? []) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (typeof b.type !== "string" || !VIEW_BLOCK_TYPES.has(b.type)) continue;
        const where = `${file}: app "${String(app.slug)}" page "${String(page.slug)}" ${b.type} block`;

        if (typeof b.view_id === "string") {
          violations.push(
            `${where} hardcodes view_id "${b.view_id}" — use view_name (install binds it per workspace)`,
          );
          continue;
        }
        if (typeof b.view_name !== "string") {
          violations.push(`${where} has no view_name — it cannot bind to anything`);
          continue;
        }
        if (!names.has(b.view_name)) {
          violations.push(
            `${where} references view "${b.view_name}", which this bundle does not provide` +
              (names.size > 0 ? ` (has: ${[...names].join(", ")})` : " (bundle declares no saved_views)"),
          );
          continue;
        }
        // Ambiguity is resolvable only with view_kind; install refuses to guess.
        const matches = views.filter((v) => v.name === b.view_name);
        if (matches.length > 1 && typeof b.view_kind !== "string") {
          violations.push(
            `${where} references view "${b.view_name}", provided ${matches.length}× on different kinds` +
              ` (${matches.map((v) => String(v.entity_kind)).join(", ")}) — add view_kind to say which`,
          );
        }
      }
    }
  }
}

if (violations.length > 0) {
  console.error(
    `Bundle app view references that cannot bind (${violations.length}):\n` +
      `${violations.join("\n")}\n\n` +
      `A view/stat block names a saved view the SAME bundle provides:\n` +
      `  { "type": "view", "view_name": "What's on hand" }\n` +
      `Install rewrites view_name into the id that view got in that workspace\n` +
      `(api/src/routes/bundle-app-view-refs.ts). Never paste a uuid.`,
  );
  process.exit(1);
}
console.log(`lint:bundle-app-view-refs - every bundle app view block binds to a provided view ✓`);
