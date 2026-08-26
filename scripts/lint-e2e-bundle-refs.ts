// Every bundle an e2e script installs must name a bundle that still exists.
//
// A walkthrough reads a manifest by name — `manifest("groceries")` or, in a
// loop, `for (const f of ["groceries", "grocery-spend"]) … bundles/${f}.json`.
// When a bundle is renamed (bundle ids now match the noun they serve, #1765:
// food-cluster -> groceries, kitchen-fitness -> grocery-spend) the SCRIPT keeps
// the old name and dies at runtime with `ENOENT bundles/food-cluster.json` —
// but only in the nightly e2e-suite, which is non-gating, so nobody sees it.
// home-life-full-walkthrough was red for weeks on exactly this.
//
// The e2e suite is not on the per-commit path, so a stale bundle name is
// invisible until 3am. This lint IS on that path: it resolves every bundle
// reference in e2e/ against the actual bundles/ dir at push time, so the rename
// and the walkthrough move together.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLES = join(ROOT, "bundles");
const E2E = join(ROOT, "e2e");

const known = new Set(
  readdirSync(BUNDLES)
    .filter((f) => f.endsWith(".json") && !f.includes("lock"))
    .map((f) => f.replace(/\.json$/, "")),
);

const suggest = (name: string) => {
  const near = [...known].filter((k) => k.includes(name.split("-")[0] ?? name) || name.includes(k.split("-")[0] ?? k));
  return near.length ? ` (did you mean ${near.map((k) => `"${k}"`).join(" / ")}?)` : "";
};

const violations: string[] = [];

for (const file of readdirSync(E2E).filter((f) => f.endsWith(".mjs"))) {
  const src = readFileSync(join(E2E, file), "utf8");
  const refs = new Map<string, number>(); // name -> 1-based line of first ref

  const record = (name: string, idx: number) => {
    if (!refs.has(name)) refs.set(name, src.slice(0, idx).split("\n").length);
  };

  // manifest("<name>") / manifest('<name>')
  for (const m of src.matchAll(/\bmanifest\(\s*["'`]([a-z0-9][a-z0-9-]*)["'`]/g)) record(m[1]!, m.index!);
  // literal bundles/<name>.json (not the ${…} template form). The lookbehind
  // keeps it to a real path segment, so a URL like "example.com/mybundles/
  // index.json" does not match the "bundles/index.json" tail inside "mybundles".
  for (const m of src.matchAll(/(?<![\w-])bundles\/([a-z0-9][a-z0-9-]*)\.json/g)) record(m[1]!, m.index!);
  // for (const f of ["a","b"]) … bundles/${f}.json — count the array names ONLY
  // when that exact loop var feeds a bundles template. Without the binding, an
  // unrelated instance/module loop (["tea","spices"], ["inventory","projects"])
  // in a file that mentions bundles/${…} elsewhere would match spuriously.
  for (const loop of src.matchAll(/for\s*\(\s*const\s+(\w+)\s+of\s*\[([^\]]*)\]/g)) {
    const varName = loop[1]!;
    if (!new RegExp(String.raw`bundles/\$\{${varName}\}`).test(src)) continue;
    for (const s of loop[2]!.matchAll(/["'`]([a-z0-9][a-z0-9-]*)["'`]/g)) record(s[1]!, loop.index!);
  }

  for (const [name, line] of refs) {
    if (!known.has(name)) violations.push(`  e2e/${file}:${line}  installs bundle "${name}" — no bundles/${name}.json${suggest(name)}`);
  }
}

if (violations.length > 0) {
  console.error(
    `e2e scripts reference bundles that no longer exist (${violations.length}):\n` +
      `${violations.join("\n")}\n\n` +
      `A bundle was renamed but the walkthrough kept the old name; it would die at\n` +
      `runtime with ENOENT, but only in the non-gating nightly e2e suite. Update the\n` +
      `reference to the current bundles/<name>.json when you rename a bundle.`,
  );
  process.exit(1);
}
console.log(`lint:e2e-bundle-refs - every e2e bundle reference resolves to a real bundle ✓`);
