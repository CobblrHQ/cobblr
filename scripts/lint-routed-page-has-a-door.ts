#!/usr/bin/env tsx
// Every page mounted in web/src/App.tsx is reached by at least one in-app link or nav entry, or is named on the lint's exemption list with the reason nothing inside the app links to it.
//
// THE BUG THIS PREVENTS. /scan/live shipped with no link from anywhere in the
// app, while the user guide and the changelog both said it was "linked from
// the inbox" (2026-09-23). A page nobody can reach is a capability nobody has:
// the only way in was to type the URL, which nobody does.
//
// THE RULE. For each `<Route path="/…">` in App.tsx, some source the app ships
// must spell that path as a string: a `to="/scan/live"`, a `navigate("/x")`, a
// nav entry's `route: "/x"`, a module manifest's link template, a bundle's
// `path`. A route with a parameter (`/locations/:id`) is reached by its static
// prefix followed by `/` or `${`; a splat (`/sales/*`) by its bare prefix.
//
// NOT JUDGED:
//   - a route whose element is a redirect (`<Navigate …>` or a `…Redirect`
//     component): it is an old URL kept for bookmarks, not a page;
//   - a route named for a module (`/bricklink-connector`): the nav gives every
//     enabled module that is not `core-*` a top entry at `/<its name>`
//     (useNavModules), a door no source spells as a string;
//   - the pages on EXEMPT below, each reached from OUTSIDE the app (an email,
//     a QR code, a signup link, an identity provider), with the reason.
// A new exemption is a line with its reason, never a count that grows.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. The first cut read only
// web/src and module.ts files and flagged /tags, /files, /maintenance and
// /configuration/catalogs/match, which ARE reached: the nav reads each
// module manifest's `nav.route` under modules/*/src, and core-catalogs builds
// the match link from a template there. So every shipping source is read,
// module src and bundles included, and a path counts wherever it is spelled.
// It cannot tell a link that renders from one behind a dead branch; it only
// guarantees the path is spelled somewhere a link could come from.
//
//   npx tsx scripts/lint-routed-page-has-a-door.ts   (pnpm lint routed-page-has-a-door)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { routesIn } from "./lib/web-routes.ts";

const APP = "web/src/App.tsx";

/** Pages reached from outside the app, so no in-app link is expected. */
const EXEMPT: Record<string, string> = {
  "/auth/callback": "the identity provider redirects here after sign-in",
  "/join/:token": "an invite link in an email",
  "/join-machines/:ownerOrg/:token": "a machine-sharing invite link sent to the other workspace",
  "/reset/:token": "the password-reset email",
  "/verify/:token": "the email-verification email",
  "/pair": "the QR code the desktop shows for phone sign-in",
  "/start/:app": "the managed app's own signup link on its landing page",
  "/try/ended": "a preview of the sandbox's ending, opened by hand on test-door boxes",
  "/email-change/:token": "the link sent to the new address when a person changes the address they sign in with",
  "/email-change/revert/:token": "the link sent to the old address that takes an address change back",
  "/bring": "the Continue on Cobblr button in a sandbox's email",
  "/try/join/:token": "the link sent to an address that already keeps a trial, to take another sandbox in",
};

function* walk(dir: string): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "tests" || name === "migrations") continue;
      yield* walk(p);
    } else if (/\.(ts|tsx|json)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}

const moduleRoots = readdirSync("modules").flatMap((m) => [join("modules", m, "src"), join("modules", m, "ui")]);
const ROOTS = ["web/src", "packages", "bundles", ...moduleRoots];

const app = readFileSync(APP, "utf8");
// Every source that could hold a link, App.tsx's own redirect targets included.
let hay = "";
for (const root of ROOTS) for (const file of walk(root)) if (file !== APP) hay += readFileSync(file, "utf8") + "\n";
for (const m of app.matchAll(/<Navigate\s+to="([^"]+)"/g)) hay += `"${m[1]}"\n`;

const routes = routesIn(app);

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function reached(path: string): boolean {
  const segs = path.split("/").slice(1);
  const fixed: string[] = [];
  for (const s of segs) {
    if (s.startsWith(":") || s === "*") break;
    fixed.push(s);
  }
  const prefix = "/" + fixed.join("/");
  if (prefix === "/") return true;
  const splat = path.endsWith("/*");
  const param = fixed.length < segs.length && !splat;
  const tail = param ? "(/|\\$\\{)" : "(?=[\"'`?#/{])";
  return new RegExp(`["'\`]${esc(prefix)}${tail}`).test(hay);
}

const navModules = new Set(readdirSync("modules").filter((m) => !m.startsWith("core-")).map((m) => `/${m}`));
const missing = routes.filter((r) => !r.redirect && !navModules.has(r.path) && !(r.path in EXEMPT) && !reached(r.path));
const stale = Object.keys(EXEMPT).filter((p) => !routes.some((r) => r.path === p));

if (missing.length || stale.length) {
  if (missing.length) {
    console.error(`lint:routed-page-has-a-door - ${missing.length} page(s) with no way in:`);
    for (const r of missing) console.error(`  ${APP}:${r.line}  ${r.path} is mounted, and nothing in the app links to it`);
    console.error("Add the link or nav entry where a person would look for it. A page reached only from outside the app (an email, a QR code) goes on EXEMPT with the reason.");
  }
  if (stale.length) console.error(`lint:routed-page-has-a-door - EXEMPT names route(s) App.tsx no longer mounts: ${stale.join(", ")}`);
  process.exit(1);
}
console.log(`lint:routed-page-has-a-door OK (${routes.length} routes, ${routes.filter((r) => r.redirect).length} redirects, ${Object.keys(EXEMPT).length} reached from outside)`);
