// A bundle's `default: true` may only be read in ONE place.
//
// It is a first-install concept: "most people setting this up want this", said
// while the checkbox is on screen. Read anywhere that also runs on an UPDATE, it
// silently opts a workspace into something nobody was asked about.
//
// That shipped. A groceries update turned on a feature that CREATES PLACES and
// made a Fridge, a Freezer and a Pantry inside a Kitchen somebody had already
// arranged, under a dialog reading "an update never adds or removes
// capabilities". The fix was to route every decision through
// `resolveEnabledFeatures`, which knows whether it is looking at an install or
// an update. This keeps it that way.
//
// The one legitimate exception is the modal's lazy initial state, which is only
// ever shown for a genuinely new install; it is allow-listed by path below.

import { readFileSync } from "node:fs";
import { sourceFiles } from "./lib/glob-exclude.mjs";

/** The one implementation, plus the surfaces allowed to read a raw default. */
const ALLOWED = new Set([
  "api/src/platform/feature-defaults.ts",
  "api/tests/feature-defaults.test.ts",
  // First-install-only: the marketplace modal's initial checkbox state for a
  // bundle that is NOT installed. Guarded by `props.mode === "featured"` and
  // overwritten from the installed set the moment the detail query lands.
  "web/src/components/BundleDetailModal.tsx",
]);

/** Reading a manifest feature's `default` to decide what gets enabled. */
const PATTERNS = [
  /\.features\s*[\s\S]{0,40}?\.filter\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\1\.default\s*\)/,
  /features\.filter\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\1\.default\s*\)/,
];

const files = sourceFiles("{api,web,modules,packages}/**/*.{ts,tsx}");

const offenders: string[] = [];
for (const f of files) {
  const rel = f.replace(/^\.\//, "");
  if (ALLOWED.has(rel)) continue;
  let src: string;
  try {
    src = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  if (!src.includes(".default")) continue;
  src.split("\n").forEach((line, i) => {
    if (PATTERNS.some((re) => re.test(line))) offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
  });
}

if (offenders.length > 0) {
  console.error(
    "[lint:feature-defaults] ✗ a bundle feature's `default` is being read outside feature-defaults.ts:\n" +
      offenders.map((o) => `  ${o}`).join("\n") +
      "\n\n  `default: true` means 'most people want this on a FIRST install', decided while\n" +
      "  the checkbox is on screen. Read on an update it opts somebody into something they\n" +
      "  never saw - a groceries update created a Fridge, Freezer and Pantry that way.\n" +
      "  Use resolveEnabledFeatures() from api/src/platform/feature-defaults.ts, which\n" +
      "  knows whether this is an install or an update.",
  );
  process.exit(1);
}

console.log("[lint:feature-defaults] ✓ feature defaults are resolved in one place");
