// Guard: every workspace-settings destination the app advertises must resolve
// to a real mounted page. CONFIG_DESTINATIONS (web/src/lib/configuration-nav.ts)
// is the ONE registry the /configuration hub, the settings sidebar, and now the
// ⌘K search all read — so a destination with a `to` route that isn't mounted in
// App.tsx is a dead tile: a setting the UI lists but you can't actually reach.
// This is the precise, low-false-positive half of "lint for settings that
// should have a frontend control but don't" (the noisy half — does a backend
// field have SOME control — was deliberately not shipped; it can't tell a
// generic `enabled`/`name` field from a real gap without drowning CI in noise).
//
// Static + text-based on purpose: no web deps imported, no build needed. Exact
// route match, with a tight relative-nesting fallback (a genuinely relative
// mounted path like "ai" covers /configuration/ai). Lenient by design — it
// errs toward NOT flagging, so a real dead link is caught without ever
// reddening CI on a route that's actually fine.
//
// Run: npx tsx scripts/lint-config-routes.ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const NAV = "web/src/lib/configuration-nav.ts";
const APP = "web/src/App.tsx";

// Registry destinations. Slice to the CONFIG_DESTINATIONS array literal first so
// unrelated `label:` strings (CONFIG_GROUPS, LEGACY_GROUP_MAP) can't leak in,
// then walk label/to tokens in order — each `to` pairs with the nearest
// preceding `label` (in this file every object lists label before to), so a
// failure names the right tile.
const navSrc = read(NAV);
const start = navSrc.indexOf("CONFIG_DESTINATIONS: ConfigDestination[] = [");
const end = start === -1 ? -1 : navSrc.indexOf("\n];", start);
if (start === -1 || end === -1) {
  console.error(`[lint:config-routes] could not locate the CONFIG_DESTINATIONS array in ${NAV} — regex drift?`);
  process.exit(1);
}
const region = navSrc.slice(start, end);
const destinations: { label: string; to: string }[] = [];
let lastLabel = "?";
for (const m of region.matchAll(/label:\s*"([^"]+)"|to:\s*"([^"]+)"/g)) {
  if (m[1] !== undefined) lastLabel = m[1];
  else if (m[2] !== undefined) destinations.push({ label: lastLabel, to: m[2].split(/[?#]/)[0] });
}
if (destinations.length === 0) {
  console.error(`[lint:config-routes] parsed 0 destinations from ${NAV} — regex drift?`);
  process.exit(1);
}

// Mounted routes: every <Route path="..."> in App.tsx.
const appSrc = read(APP);
const mounted = [...appSrc.matchAll(/path="([^"]+)"/g)].map((m) => m[1]);
const mountedSet = new Set(mounted);
// Relative mounted paths (no leading slash) can nest under a parent route.
const relative = mounted.filter((p) => !p.startsWith("/"));

function covered(to: string): boolean {
  if (mountedSet.has(to)) return true; // exact absolute match
  // a relative child route "ai" covers ".../ai"; require the WHOLE last segment
  return relative.some((p) => to === p || to.endsWith("/" + p));
}

const dead = [...new Map(destinations.map((d) => [d.to, d])).values()].filter((d) => !covered(d.to));

if (dead.length > 0) {
  console.error(
    `[lint:config-routes] ${dead.length} settings destination(s) point at a route that isn't mounted in App.tsx.\n` +
      `Each is a dead tile — listed in Configuration / search but unreachable. Add the <Route>, or fix the \`to\` in ${NAV}:\n` +
      dead.map((d) => `   ✗ "${d.label}" → ${d.to}`).join("\n"),
  );
  process.exit(1);
}

// ─────────────── Check 2: one page, one canonical URL ───────────────
// A settings destination must not share its page component with a SECOND
// mounted URL. When it does, the two URLs compete: the workspace nav sends you
// to one, every link inside the page sends you to the other, and you get
// yanked between the plain shell and the settings shell mid-task. Locations
// shipped exactly that bug — a navbar entry at /locations whose every row
// linked to /configuration/locations, so one click dropped you into
// Configuration. See docs/design-decisions/configuration-revamp.md.
//
// Param variants (/assets + /assets/:id) and redirect elements are fine; only
// two DISTINCT page URLs for one component count.
const ALLOWED_MULTI_URL: Record<string, string> = {
  // Two genuinely different views from one component: the /configuration one
  // passes `setupOnly` (connections editor), /digifab is the job board.
  DigifabPage: "setupOnly vs full board; split the component to retire this",
  // Legacy rename alias, kept for old bookmarks.
  BrickLinkPage: "pre-rename alias /bricklink",
  // `/core-*` module-name aliases so a nav entry keyed on the module name
  // resolves. These are the same duplicate-URL debt Locations just paid off;
  // P2 of the configuration revamp clears them by making the nav noun
  // declarative in the manifest. Shrink this list as it lands.
  FilesPage: "/core-files module-name alias — clears in revamp P2",
  TagsPage: "/core-tags module-name alias — clears in revamp P2",
  ViewsPage: "/core-views module-name alias — clears in revamp P2",
};

const REDIRECT_ELEMENTS = /^(Navigate|.*Redirect|ConsoleEscape)$/;
const byComponent = new Map<string, Set<string>>();
for (const m of appSrc.matchAll(/path="([^"]+)"\s+element=\{<(\w+)/g)) {
  const [, path, component] = m;
  if (!path || !component) continue;
  if (REDIRECT_ELEMENTS.test(component)) continue;
  // Collapse param + splat variants: /assets/:id and /assets are one page.
  const base = path.replace(/\/(:[^/]+|\*)/g, "");
  if (!byComponent.has(component)) byComponent.set(component, new Set());
  byComponent.get(component)!.add(base);
}

const destRoutes = new Set(destinations.map((d) => d.to));
const doubled = [...byComponent]
  .filter(([component, paths]) => paths.size > 1 && !(component in ALLOWED_MULTI_URL))
  // Only settings pages are in scope: at least one of the URLs is advertised
  // by the registry.
  .filter(([, paths]) => [...paths].some((p) => destRoutes.has(p)));

if (doubled.length > 0) {
  console.error(
    `[lint:config-routes] ${doubled.length} settings page(s) are mounted at more than one URL.\n` +
      `Pick ONE canonical URL and make the other a redirect, or the nav and the page's own links\n` +
      `will fight over which shell you end up in (see docs/design-decisions/configuration-revamp.md):\n` +
      doubled.map(([c, p]) => `   ✗ ${c} → ${[...p].join(" + ")}`).join("\n"),
  );
  process.exit(1);
}

console.log(
  `[lint:config-routes] ok — all ${destRoutes.size} settings destinations resolve to a mounted route, ` +
    `each at one canonical URL (${Object.keys(ALLOWED_MULTI_URL).length} known aliases allowlisted).`,
);
process.exit(0);
