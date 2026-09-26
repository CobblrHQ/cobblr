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
// The lint flags a raw file URL (api.fileRawUrl(...), a literal core-files
// /raw path, or one built from a variable: `${base}/files/${id}/raw`) handed
// straight to the browser: a src=/href= attribute, window.open(...), or a
// location assignment. Passing it as a plain VALUE (storing a path, feeding
// FilePreview, useImageSrc or openAuthedFile) is fine and not flagged.
//
// It reads every UI tree, module UIs included. A Design's pattern PDF link
// sat in modules/projects/src/ui with its path built from `${base}`, outside
// both the one directory and the one literal the first version read, and it
// 401'd for everyone who pressed it (#3753).
//
//   cd <repo> && npx tsx scripts/lint-authed-media.ts
//
// Local + CI, free, zero deps.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["web/src", "packages/platform-web/src", ...moduleUiRoots()];

function moduleUiRoots(): string[] {
  const out: string[] = [];
  for (const m of readdirSync("modules")) {
    const ui = join("modules", m, "src", "ui");
    try {
      if (statSync(ui).isDirectory()) out.push(ui);
    } catch {
      /* a module with no UI */
    }
  }
  return out;
}

// FilePreview auth-fetches internally — its src prop is the sanctioned home
// for a raw URL. Everything else must not put one in src/href directly.
const ALLOWED_ATTR_CONTEXT = /<FilePreview[\s\S]{0,200}$/;

// A raw file URL: the helper, a literal core-files path, or a files/…/raw
// path built from variables.
const RAW = String.raw`(?:fileRawUrl\(|\/modules\/core-files\/files\/[^\s"'\`]*\/raw\b|\/files\/\$\{[^}]*\}\/raw\b)`;
// ...handed to the browser directly.
const OFFENSE = new RegExp(
  String.raw`\b(?:src|href)=\{[^\n]*` + RAW + String.raw`|window\.open\([^\n]*` + RAW + String.raw`|\blocation(?:\.href)?\s*=\s*[^\n]*` + RAW,
);

function uiFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...uiFiles(p));
    else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

const findings: string[] = [];
for (const file of ROOTS.flatMap(uiFiles)) {
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
