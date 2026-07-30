// A settings page does not write its own page header. The layout draws it, from
// the registry.
//
// What this prevents, measured before the fix: 24 settings pages had grown TEN
// different <h1> treatments — two font families, three weights, two sizes, some
// with the sentence-case lift and some without, some flex and some not. Nobody
// decided that. Each page copied whichever neighbour happened to be open, and
// the drift is invisible in review because every one of those headers looks
// perfectly fine on its own page. You only see it by opening two in a row,
// which is what a user does and a reviewer does not.
//
// The description drifted the same way: it lives in the registry, the hub and
// section pages render it from there, and 8 pages ALSO wrote their own copy —
// so the same sentence was maintained twice and said two different things.
// Permissions printed its title three times on one screen (breadcrumb, header,
// then its own h1 again).
//
// If a page needs a button up top, it wraps it in <ConfigHeaderActions>, which
// the layout renders beside the title.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const NAV = join(ROOT, "web/src/lib/configuration-nav.ts");
const APP = join(ROOT, "web/src/App.tsx");
const PAGES = join(ROOT, "web/src/pages");

/** Pages that legitimately own a header: they are not settings DESTINATIONS, so
 *  the layout has no registry entry to draw one from. */
const EXEMPT = new Set([
  "ConfigurationPage", // the hub — its header IS the page
  "ConfigSectionPage", // a section — same
  "ConfigLauncherPages",
]);

const nav = readFileSync(NAV, "utf8");
const app = readFileSync(APP, "utf8");

const routes = [...nav.matchAll(/to:\s*"([^"]+)"/g)].map((m) => m[1]!);
const pages = new Set<string>();
for (const r of routes) {
  const m = app.match(
    new RegExp(`path="${r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s+element=\\{<(\\w+)`),
  );
  if (m?.[1]) pages.add(m[1]);
}

const bad: Array<{ page: string; snippet: string }> = [];
for (const page of [...pages].sort()) {
  if (EXEMPT.has(page)) continue;
  let src: string;
  try {
    src = readFileSync(join(PAGES, `${page}.tsx`), "utf8");
  } catch {
    continue; // route points at a component outside pages/
  }
  const h1 = src.match(/<h1[^>]*>/);
  if (h1) bad.push({ page, snippet: h1[0].slice(0, 96) });

  // The action slot is for CONTROLS. Prose in it is a page still trying to write
  // its own description: the slot is shrink-0 and sits beside the title, so a
  // paragraph there squeezes the heading to one word per line. That shipped on
  // Scan rules, where the sweep that removed the <h1> mistook the page's <p>
  // description for a button and moved it into the slot.
  // A justify-between row with ONE child is meaningless CSS (it lays out
  // identically to no wrapper) and is the fingerprint of a header row that lost
  // its other half. When the sweep removed each page's <h1>, any page whose
  // title and primary button shared a `justify-between` was left with a lone
  // button collapsed to the LEFT — which is how Apps ended up with "+ New app"
  // under the heading instead of opposite it. A page-level action belongs in
  // ConfigHeaderActions, where the layout right-aligns it beside the title.
  for (const m of src.matchAll(
    /<div className="[^"]*\bjustify-between\b[^"]*">\s*\n([\s\S]*?)\n(\s*)<\/div>/g,
  )) {
    const inner = m[1] ?? "";
    const kids = inner.match(/^\s{8}<[A-Za-z]/gm)?.length ?? 0;
    if (kids === 1 && /<(button|Link|NavLink)\b/.test(inner)) {
      bad.push({ page, snippet: "lone action in a justify-between row (header lost its title half)" });
    }
  }

  for (const m of src.matchAll(/<ConfigHeaderActions>([\s\S]*?)<\/ConfigHeaderActions>/g)) {
    const block = m[1] ?? "";
    const text = block.replace(/<[^>]+>/g, "").replace(/\{[^}]*\}/g, "").trim();
    const hasControl = /<(button|select|Link|NavLink|input|textarea)\b/.test(block);
    if (/<p\b/.test(block) || (!hasControl && text.length > 60)) {
      bad.push({ page, snippet: `prose in <ConfigHeaderActions>: "${text.slice(0, 60)}…"` });
    }
  }
}

if (bad.length) {
  console.error("[lint:page-headers] settings page writing its own header text:\n");
  for (const b of bad) {
    console.error(`  web/src/pages/${b.page}.tsx`);
    console.error(`      ${b.snippet}`);
  }
  console.error(`
  The layout draws the header for every settings destination, using the label,
  description and icon already declared in web/src/lib/configuration-nav.ts.
  A page that draws its own ends up a different size and weight from its
  neighbours, and repeats a description that is maintained elsewhere.

  Delete the <h1> and its subtitle. If the page needs a control up there:

      import { ConfigHeaderActions } from "../components/ConfigPageHeader";
      <ConfigHeaderActions><button …/></ConfigHeaderActions>

  Wrong title or description? Fix it in the registry, where the breadcrumb, the
  hub card and the search index all read it too.
`);
  process.exit(1);
}

console.log(
  `[lint:page-headers] ok — ${pages.size - EXEMPT.size} settings pages, none writing its own header.`,
);
