#!/usr/bin/env tsx
// Authed-media lint — a browser-initiated load (<img src>, <a href>, <video>,
// <source>, <iframe src>) sends NO Authorization header, and Cobblr's auth is
// Bearer-only: pointing one of those straight at a core-files raw URL 401s
// and renders broken. That's the 2026-07-03 "/files is all broken images"
// bug, which had silently spread to other components. Authed media goes
// through the blob-fetch layer instead:
//   images    → useImageSrc(...)            (@cobblr/platform-web)
//   previews  → <FilePreview src={...} />   (auth-fetches internally)
//   downloads → openAuthedFile(...)          (web/src/lib/authed-file.ts)
//
// The lint flags DIRECT use of api.fileRawUrl(...) — or a literal
// core-files /raw path — as the value of a src=/href= JSX attribute.
// Passing fileRawUrl as a plain VALUE (storing a path, feeding FilePreview
// or useImageSrc) is fine and not flagged.
//
//   cd <repo> && npx tsx scripts/lint-authed-media.ts
//
// Local + CI, free, zero deps.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = "web/src";

// FilePreview auth-fetches internally — its src prop is the sanctioned home
// for a raw URL. Everything else must not put one in src/href directly.
const ALLOWED_ATTR_CONTEXT = /<FilePreview[\s\S]{0,200}$/;

const OFFENSE =
  /\b(?:src|href)=\{\s*(?:api\.fileRawUrl\(|[`"'][^}]*\/modules\/core-files\/files\/[^}]*\/raw)/;

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...tsxFiles(p));
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const findings: string[] = [];
for (const file of tsxFiles(ROOT)) {
  const src = readFileSync(file, "utf8");
  const lines = src.split("\n");
  lines.forEach((line, i) => {
    if (!OFFENSE.test(line)) return;
    // Allow <FilePreview src={api.fileRawUrl(...)}> — look back a little for
    // the opening tag (props are often on their own lines).
    const context = lines.slice(Math.max(0, i - 5), i + 1).join("\n");
    if (ALLOWED_ATTR_CONTEXT.test(context)) return;
    findings.push(`  ${file}:${i + 1}  ${line.trim().slice(0, 110)}`);
  });
}

if (findings.length > 0) {
  console.error(`✗ authed-media lint: ${findings.length} browser-initiated load(s) of a Bearer-authed file URL.\n`);
  console.error(findings.join("\n"));
  console.error(`\nA plain src=/href= carries no Authorization header → 401 → broken image/dead link.
Use useImageSrc (images), <FilePreview> (previews), or openAuthedFile (downloads/open-in-tab).
See web/src/lib/authed-file.ts + the 2026-07-03 /files fix (#570).`);
  process.exit(1);
}
console.log("✓ authed-media lint: no browser-initiated loads of Bearer-authed file URLs.");
