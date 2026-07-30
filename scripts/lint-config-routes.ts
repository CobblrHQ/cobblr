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
import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

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
const destinations: { label: string; to: string; section?: string }[] = [];
let lastLabel = "?";
let lastSection: string | undefined;
for (const m of region.matchAll(
  /label:\s*"([^"]+)"|to:\s*"([^"]+)"|section:\s*"([^"]+)"/g,
)) {
  if (m[1] !== undefined) lastLabel = m[1];
  else if (m[3] !== undefined) lastSection = m[3];
  else if (m[2] !== undefined)
    destinations.push({ label: lastLabel, to: m[2].split(/[?#]/)[0], section: lastSection });
}
if (destinations.length === 0) {
  console.error(`[lint:config-routes] parsed 0 destinations from ${NAV} — regex drift?`);
  process.exit(1);
}

// ── Check 0: every destination declares a SECTION ──────────────────────
// Without one the hub can't place it, so it would exist in the registry and
// appear on no card — invisible except through search.
const sectionless = destinations.filter((d) => !d.section);
if (sectionless.length > 0) {
  console.error(
    `[lint:config-routes] ${sectionless.length} destination(s) declare no \`section\`, so no hub card can show them:\n` +
      sectionless.map((d) => `   ✗ "${d.label}" → ${d.to}`).join("\n"),
  );
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
// EMPTY, and it should stay that way. The `/core-files|views|tags` aliases were
// retired when the nav noun became a manifest field (`nav`), and DigifabPage's
// second mount became a tab of the merged Devices page. (BrickLinkPage sat here
// for a while but never needed to: this check only scopes components whose URLs
// the registry advertises, and /bricklink is not one.)
//
// Do not add to this list. Pick a canonical URL and redirect the other.
const ALLOWED_MULTI_URL: Record<string, string> = {};

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

// ───── Check 3: no two registry entries share a route ─────
const byRoute = new Map<string, string[]>();
for (const d of destinations) {
  byRoute.set(d.to, [...(byRoute.get(d.to) ?? []), d.label]);
}
const sharedRoute = [...byRoute].filter(([, labels]) => labels.length > 1);
if (sharedRoute.length > 0) {
  console.error(
    `[lint:config-routes] ${sharedRoute.length} route(s) are claimed by more than one registry entry.\n` +
      `Two labels for one page means the sidebar lists it twice and the hub counts it twice:\n` +
      sharedRoute.map(([r, labels]) => `   ✗ ${r} ← ${labels.join(" + ")}`).join("\n"),
  );
  process.exit(1);
}

// ───── Check 4: the FEATURE index must not re-describe a registry page ─────
// feature-index.ts merges CURATED entries with CONFIG_DESTINATIONS and dedups
// by route, curated-wins. So a curated entry sharing a route with the registry
// silently shadows it: you edit the registry description and search keeps
// showing the old words. Keep them disjoint.
const FEATURES = "web/src/lib/feature-index.ts";
const featSrc = read(FEATURES);
const fStart = featSrc.indexOf("const CURATED: FeatureHit[] = [");
const fEnd = fStart === -1 ? -1 : featSrc.indexOf("\n];", fStart);
if (fStart === -1 || fEnd === -1) {
  console.error(`[lint:config-routes] could not locate CURATED in ${FEATURES} — regex drift?`);
  process.exit(1);
}
// Normalise EXACTLY as feature-index's dedup does (`route.split("?")[0]`) —
// not more strictly. A deep link that keeps a #fragment ("Email in" →
// /configuration/integrations#email-in) is a distinct key there, so it does not
// shadow the page's own entry and must not be flagged.
const curatedRoutes = [
  ...featSrc.slice(fStart, fEnd).matchAll(/route:\s*"([^"]+)"/g),
].map((m) => m[1]!.split("?")[0]!);
const collisions = [...new Set(curatedRoutes.filter((r) => destRoutes.has(r)))];
if (collisions.length > 0) {
  console.error(
    `[lint:config-routes] ${collisions.length} curated feature-index entr(ies) collide by route with a\n` +
      `settings destination. The dedup is curated-wins, so the registry's own description is silently\n` +
      `ignored for these — drop the curated entry and let the registry supply it:\n` +
      collisions.map((r) => `   ✗ ${r}`).join("\n"),
  );
  process.exit(1);
}

// ───── Check 5: no settings page rolls its own "back to Configuration" ─────
// ConfigurationLayout renders ONE breadcrumb for every settings route, derived
// from the registry. Before that, 6 of 26 pages hand-rolled a back link and the
// other 20 were a one-way trip — you arrived from a section card and the only
// exit was the browser's back button (phones don't get the sidebar). A page
// adding its own now double-renders it and, worse, points at the hub instead of
// the section you came from.
const backLinks = [
  ...appSrc.matchAll(/path="(\/configuration\/[^"]*)"\s+element=\{<(\w+)/g),
].map((m) => m[2]!);
// The hub and the section pages are exactly where the layout does NOT render a
// crumb (they ARE the navigation), so they legitimately own their way back.
const CRUMBLESS = new Set(["ConfigurationPage", "ConfigSectionPage"]);
const pageFiles = new Set(backLinks.filter((c) => !CRUMBLESS.has(c)));
const rogue: string[] = [];
for (const comp of pageFiles) {
  for (const dir of ["web/src/pages"]) {
    const f = join(ROOT, dir, `${comp}.tsx`);
    if (!existsSync(f)) continue;
    const src = readFileSync(f, "utf8");
    if (/to=["']\/configuration["']/.test(src)) rogue.push(`${dir}/${comp}.tsx`);
  }
}
if (rogue.length > 0) {
  console.error(
    `[lint:config-routes] ${rogue.length} settings page(s) hand-roll a back link to /configuration.\n` +
      `ConfigurationLayout already renders one breadcrumb for every settings route, pointing at the\n` +
      `SECTION you came from. Delete the page's own link:\n` +
      rogue.map((r) => `   \u2717 ${r}`).join("\n"),
  );
  process.exit(1);
}

// ───── Check 6: settings pages do not set their own content column ─────
// Six different widths and both alignments had accumulated across 20 settings
// pages, so moving between two neighbours in the same section shifted the
// column under you. ConfigurationLayout owns it now, driven by the registry's
// optional `width`. A page that sets its own max-w + mx-auto fights it.
const columnOffenders: string[] = [];
for (const comp of pageFiles) {
  const f = join(ROOT, "web/src/pages", `${comp}.tsx`);
  if (!existsSync(f)) continue;
  const src = readFileSync(f, "utf8");
  // Order-independent, and NOT anchored to `className="`. The first version of
  // this check wanted `max-w-* mx-auto` inside a literal className attribute, so
  // ScanRulesPage slipped past on both counts at once: it wrote the classes the
  // other way round (`mx-auto max-w-3xl`) inside a ternary. It set its own column
  // for weeks with a green lint.
  const setsColumn = /\bmx-auto\b/.test(src) && /\bmax-w-(?:\d?xl|\d+|full|prose|screen-\w+)\b/.test(src);
  if (setsColumn) {
    columnOffenders.push(`web/src/pages/${comp}.tsx`);
  }
}
if (columnOffenders.length > 0) {
  console.error(
    `[lint:config-routes] ${columnOffenders.length} settings page(s) set their own content column.\n` +
      `ConfigurationLayout supplies one for every settings route; a page that adds max-w + mx-auto\n` +
      `makes the column jump between pages. Need a wider one? Set \`width: "wide"\` on the registry\n` +
      `entry instead:\n` +
      columnOffenders.map((r) => `   \u2717 ${r}`).join("\n"),
  );
  process.exit(1);
}

console.log(
  `[lint:config-routes] ok — ${destRoutes.size} settings destinations: all mounted, all sectioned, ` +
    `one canonical URL each (${Object.keys(ALLOWED_MULTI_URL).length} legacy alias allowlisted), ` +
    `no feature-index collisions.`,
);
process.exit(0);
