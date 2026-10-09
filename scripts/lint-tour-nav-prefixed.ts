#!/usr/bin/env tsx
// A guided tour navigates through W(), never to a bare ${WEB}/path: an un-prefixed app URL is a full document replacement, and a tour is a recording, so the boot scrim lands in the take.
//
// THE BUG THIS PREVENTS. App.tsx's PublicRoutes catch-all is LandingRedirect,
// which runs window.location.replace(`/w/<handle>/…`) so an old bookmark keeps
// working. That costs four to five main-frame document loads against one for
// the prefixed URL, and the recorder keeps filming through it. Measured over
// every second of every take at full resolution: five blank seconds in the
// yarn tour, five in the Lego one, three in the app tour, and four and two in
// the takes that were live on the homepage before them. A visitor watching a
// three-minute product tour saw the app blink to an empty page five times, for
// at least a month, because a single blank second is invisible to somebody
// scrubbing a contact sheet and the run log says nothing (#3422).
//
// THE RULE. In kiosk/guided-*.mjs, every page.goto to an app route goes
// through W() from lib.mjs. Bare is allowed only for the origin itself (the
// signup door) and for the routes App.tsx really does serve un-prefixed — READ
// FROM App.tsx (scripts/lib/unprefixed-routes.ts), never listed here. A
// hand-kept copy of that list was missing the operator console, and it
// prefixed /admin in a walkthrough: `/w/<slug>/admin` is ConsoleEscape, a
// second full navigation back out. /portal is NOT bare-allowed either, though
// it is a PublicRoutes row: its element is a redirect into the basename.
//
// The same rule holds for the e2e walks: e2e/*.mjs through W() from
// e2e/prod-look.mjs. There it costs a whole second app boot per page, and a
// walk timed across it measures the boot, not the page (#3422 counted 194
// bare navigations; widened here once that reached zero). A path already
// under /w/ is prefixed by hand and fine.
//
// PROVED RED 2026-09-22 against the pre-fix tours (11 bare navigations in each
// of guided-yarn.mjs and guided-lego.mjs); green once both went through W().
// Widened to e2e/ 2026-09-23: red on main's walks (123 bare navigations),
// green once #3506's conversions landed beside it.
//
//   npx tsx scripts/lint-tour-nav-prefixed.ts   (pnpm run lint:tour-nav-prefixed)
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { unprefixedRoutes } from "./lib/unprefixed-routes.ts";

const ROOTS: { dir: string; file: RegExp; seam: string }[] = [
  { dir: "kiosk", file: /^guided-.*\.mjs$/, seam: "kiosk/lib.mjs" },
  { dir: "e2e", file: /\.mjs$/, seam: "e2e/prod-look.mjs" },
  // The docs site's picture flows sit a folder down and were never read: one
  // navigated to bare paths and a dark capture came out blank (2026-10-09).
  { dir: "e2e/docs-shots/flows", file: /\.mjs$/, seam: "e2e/prod-look.mjs" },
];

const ROUTES = unprefixedRoutes(readFileSync("web/src/App.tsx", "utf8"));

interface Violation {
  file: string;
  line: number;
  base: string;
  path: string;
  seam: string;
}

const violations: Violation[] = [];
for (const root of ROOTS) {
  let names: string[] = [];
  try {
    names = readdirSync(root.dir);
  } catch {
    continue;
  }
  for (const name of names.filter((n) => root.file.test(n))) {
    const file = join(root.dir, name);
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        // `page.goto(`${WEB}/somewhere`…` — the bare form, under any of the
        // names a walk gives the app's origin. A goto to the origin itself
        // (no path, or "/") is the signup door and is fine.
        const m = /\.goto\(\s*`\$\{(WEB|BASE|web)\}(\/[^`]*)`/.exec(line);
        if (!m) return;
        const path = m[2]!;
        if (path === "/" || path.startsWith("/w/") || ROUTES.isUnprefixed(path)) return;
        violations.push({ file, line: i + 1, base: m[1]!, path, seam: root.seam });
      });
  }
}

if (violations.length) {
  console.error(`lint:tour-nav-prefixed - ${violations.length} bare navigation(s):`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  \`\${${v.base}}${v.path}\` -> W("${v.path.split("?")[0]}")  (${v.seam})`);
  }
  console.error(
    "An un-prefixed app URL is a full document replacement, and the recorder films through it.\n" +
      "Say useWorkspace(slug) once after signup, then navigate through W() (kiosk/lib.mjs, e2e/prod-look.mjs).\n" +
      "Check a rendered take with: node kiosk/scan-blank-frames.mjs <take>",
  );
  process.exit(1);
}
console.log(`lint:tour-nav-prefixed OK (every guided tour and e2e walk navigates through the workspace basename)`);
