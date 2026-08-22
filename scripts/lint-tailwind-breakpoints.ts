#!/usr/bin/env tsx
// A responsive prefix that is not a real breakpoint is a DEAD class.
//
// `className="hidden xs:inline"` reads like "hidden on the smallest screens,
// shown from xs up". Tailwind has no `xs` unless the project defines one, and
// this project does not — so the class is never generated and the element is
// simply hidden, at every width, forever. Nothing errors. The build is green.
// The label is just gone.
//
// This has now happened twice: once on the scan page (whose comment records
// it) and once on the locations page while fixing the phone layout. Twice is a
// class, and the failure mode — invisible, silent, only findable by opening
// the page at the right width — is exactly the kind a person does not catch in
// review.
//
// Run: npx tsx scripts/lint-tailwind-breakpoints.ts

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const CONFIG = "web/tailwind.config.js";

/** Tailwind's defaults. A project that declares `theme.screens` replaces them;
 *  one that declares `theme.extend.screens` adds to them. */
const DEFAULT_SCREENS = ["sm", "md", "lg", "xl", "2xl"];

function definedScreens(): string[] {
  let cfg = "";
  try {
    cfg = readFileSync(join(ROOT, CONFIG), "utf8");
  } catch {
    return DEFAULT_SCREENS;
  }
  const extra = [...cfg.matchAll(/screens:\s*\{([^}]*)\}/g)]
    .flatMap((m) => [...m[1]!.matchAll(/["']?([\w.-]+)["']?\s*:/g)].map((k) => k[1]!));
  // A bare `screens:` (not under `extend`) replaces the defaults; this project
  // has neither, so the union is right and errs toward NOT flagging.
  return [...new Set([...DEFAULT_SCREENS, ...extra])];
}

const SCREENS = definedScreens();
/** Every other prefix Tailwind ships that legitimately precedes a `:`. */
const NON_SCREEN = new Set([
  "hover", "focus", "focus-visible", "focus-within", "active", "visited", "target",
  "first", "last", "only", "odd", "even", "first-of-type", "last-of-type", "empty",
  "disabled", "enabled", "checked", "indeterminate", "default", "required", "valid",
  "invalid", "in-range", "out-of-range", "placeholder-shown", "autofill", "read-only",
  "before", "after", "placeholder", "file", "marker", "selection", "first-line",
  "first-letter", "backdrop", "dark", "motion-safe", "motion-reduce", "contrast-more",
  "contrast-less", "portrait", "landscape", "print", "rtl", "ltr", "open", "group",
  "peer", "aria", "data", "supports", "has", "not", "min", "max", "starting",
  "forced-colors", "inert", "nth", "sm-only",
]);

const files: string[] = [];
(function walk(dir: string) {
  for (const e of readdirSync(join(ROOT, dir))) {
    if (e === "node_modules" || e === "dist" || e.startsWith(".")) continue;
    const rel = join(dir, e);
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
    else if (/\.tsx$/.test(e)) files.push(rel);
  }
})("web/src");
for (const extra of ["packages/platform-web/src", "modules"]) {
  try {
    (function walk(dir: string) {
      for (const e of readdirSync(join(ROOT, dir))) {
        if (e === "node_modules" || e === "dist" || e.startsWith(".")) continue;
        const rel = join(dir, e);
        if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
        else if (/\.tsx$/.test(e)) files.push(rel);
      }
    })(extra);
  } catch { /* optional tree */ }
}

const bad: string[] = [];
for (const rel of files) {
  const src = readFileSync(join(ROOT, rel), "utf8");
  src.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/className=\{?["'`]([^"'`]+)["'`]/g)) {
      for (const cls of m[1]!.split(/\s+/)) {
        // Only the FIRST segment can be a breakpoint (sm:hover:… is legal).
        const head = cls.split(":")[0]!;
        if (!cls.includes(":") || head.startsWith("[") || head.includes("[")) continue;
        const name = head.replace(/^(?:group|peer)-/, "").replace(/^!/, "");
        if (SCREENS.includes(name) || NON_SCREEN.has(name)) continue;
        // `max-sm:` / `min-md:` — Tailwind's range variants over a REAL screen.
        // A typo inside one (`max-xs:`) is still caught, which is the point.
        const range = name.match(/^(?:max|min)-(.+)$/);
        if (range && SCREENS.includes(range[1]!)) continue;
        // @tailwindcss/typography element modifiers: prose-p:, prose-headings:…
        if (/^prose-[a-z0-9-]+$/.test(name)) continue;
        // A length-like prefix (min-[600px]) is handled above; anything left
        // that looks like a word is a suspected dead breakpoint.
        if (/^[a-z][a-z0-9-]*$/.test(name)) {
          bad.push(`${rel}:${i + 1}  ${cls}   ("${name}" is not a breakpoint here)`);
        }
      }
    }
  });
}

if (bad.length) {
  console.error("[lint:tailwind-breakpoints] ✗ dead responsive prefix — the class never applies:\n");
  for (const b of bad) console.error("  " + b);
  console.error(`\n  Breakpoints in ${CONFIG}: ${SCREENS.join(", ")}`);
  console.error("  Either use one of those, or add the screen to the Tailwind config.");
  process.exit(1);
}
console.log(
  `lint:tailwind-breakpoints ✓ ${files.length} files, every responsive prefix is a real breakpoint (${SCREENS.join(", ")}).`,
);
