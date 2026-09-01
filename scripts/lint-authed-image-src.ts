#!/usr/bin/env tsx
// A stored image path never goes straight into <img src>.
//
// THE BUG THIS PREVENTS. An entity's `image_path` is free-form. It is often an
// external catalog URL, which a browser fetches happily. But it is just as
// often a RELATIVE core-files path:
//
//   /api/v1/orgs/:slug/modules/core-files/files/:id/raw
//
// That route is authenticated, and the SPA holds its JWT in localStorage. An
// <img> element cannot send an Authorization header, so the request goes out
// bare, the api answers 401, and the user gets a broken-image icon. Nothing
// throws, no console error names the cause, and it looks fine in review because
// the markup is ordinary and the external-URL case works.
//
// It shipped: every cover in a bookshelf GALLERY view came back 401 while the
// LIST view beside it, showing the same books, was perfect. The list went
// through EntityThumb (which resolves properly) and ViewsPage's gallery
// renderer did not. It survived because the failure is data-dependent - seed a
// workspace from external catalog URLs and you will never see it.
//
// THE RULE. In a file that can hold an internal file path (it mentions
// image_path / image_field / fileRawUrl / core-files / a /raw route), every
// <img src={…}> must either:
//
//   1. render a value resolved by `useImageSrc(…)` - the one door, which passes
//      external URLs through untouched and fetches internal ones with the token,
//      handing back a blob: URL; or
//   2. carry `// EXTERNAL-IMAGE-OK: <why>` on or just above the tag, when the
//      value provably cannot be an internal path (a data: URI, an object URL
//      from a local File, a bundled asset, a remote camera snapshot).
//
// The judgement sits at the tag, where the person writing it knows where the
// URL came from.
//
//   cd <repo> && npx tsx scripts/lint-authed-image-src.ts

import { readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["web/src", "packages/platform-web/src", "modules"];
const SKIP = /(\.test\.|\.spec\.|\/dist\/|\/node_modules\/|\/__tests__\/)/;
const MARKER = "EXTERNAL-IMAGE-OK:";
/** A file mentioning any of these can be handed a core-files path. */
const INTERNAL_SOURCE = /image_path|imagePath|image_field|fileRawUrl|core-files|\/raw\b/;
/** How far above the tag the escape-hatch comment may sit. */
const LOOKBACK = 6;

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    if (SKIP.test(`/${p}/`)) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const findings: string[] = [];

for (const root of ROOTS) {
  for (const file of walk(root)) {
    const src = readFileSync(file, "utf8");
    if (!INTERNAL_SOURCE.test(src)) continue;

    // Names bound to a useImageSrc(...) result anywhere in the file. Cheap and
    // deliberately file-wide: these components are small, and a name that holds
    // a resolved src in one place is not a different thing ten lines down.
    const resolved = new Set<string>();
    for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*useImageSrc\s*\(/g)) {
      resolved.add(m[1]!);
    }

    const lines = src.split("\n");
    for (const [i, line] of lines.entries()) {
      const tag = /<img\b[^>]*?\bsrc=\{([^}]*)\}/.exec(line);
      if (!tag) continue;
      const expr = tag[1]!.trim();

      if (expr.includes("useImageSrc(")) continue;
      // The bare identifier (or the head of a member/optional chain) is what a
      // binding can be matched against: `resolvedThumb`, `resolved ?? x`.
      const head = /^([A-Za-z_$][\w$]*)/.exec(expr)?.[1];
      if (head && resolved.has(head)) continue;

      const window = lines.slice(Math.max(0, i - LOOKBACK), i + 1).join("\n");
      if (window.includes(MARKER)) continue;

      findings.push(`  ${file}:${i + 1}\n      <img src={${expr}}>`);
    }
  }
}

if (findings.length) {
  console.error(
    `✗ authed-image-src lint: ${findings.length} <img> that may be handed an ` +
      `authenticated core-files path\n`,
  );
  console.error(findings.join("\n"));
  console.error(
    "\nAn <img> cannot send the Bearer token, so a relative\n" +
      "/api/v1/orgs/:slug/modules/core-files/files/:id/raw src answers 401 and\n" +
      "renders as a broken image. Pick one:\n" +
      "  · resolve it first:  const resolved = useImageSrc(src)   (@cobblr/platform-web)\n" +
      "    then render <img src={resolved} …>; external URLs pass through untouched\n" +
      "  · use <EntityThumb src={…}> / <EntityTile …>, which already do that\n" +
      "  · annotate `// EXTERNAL-IMAGE-OK: <why>` above the tag when the value\n" +
      "    cannot be an internal path (a data: URI, a local object URL, a bundled\n" +
      "    asset, a remote camera snapshot).\n",
  );
  process.exit(1);
}
console.log("lint:authed-image-src ✓ no <img> is handed an authenticated file path unresolved.");
