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

console.log(`[lint:config-routes] ok — all ${new Set(destinations.map((d) => d.to)).size} settings destinations resolve to a mounted route.`);
process.exit(0);
