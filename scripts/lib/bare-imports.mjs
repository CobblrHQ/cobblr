// Which packages a file imports, and whether a file is part of what the API
// loads. Shared by lint:runtime-deps-are-declared (the source, in the repo) and
// scripts/ci/check-runtime-deps.mjs (the built files, inside the image), so the
// two judge the same thing the same way (#4944).
import { builtinModules } from "node:module";

const BUILTINS = new Set(builtinModules.map((m) => m.replace(/^node:/, "").split("/")[0]));

/** The package a bare specifier names: "@scope/name/sub" -> "@scope/name", "x/sub" -> "x"; null when it
 *  is not a package (relative, absolute, `node:`, a builtin, a `#` import). */
export function packageOf(spec) {
  if (!spec || spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("#") || spec.startsWith("node:")) return null;
  const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
  if (!name || BUILTINS.has(name)) return null;
  return name;
}

const FROM = /(?:^|[\n;])\s*(?:import|export)\b[^;'"`]*?\bfrom\s*["']([^"'\n]+)["']/g;
const BARE = /(?:^|[\n;])\s*import\s*["']([^"'\n]+)["']/g;
const DYNAMIC = /\bimport\(\s*["']([^"'\n]+)["']\s*\)/g;
const REQUIRE = /\brequire\(\s*["']([^"'\n]+)["']\s*\)/g;

/** Every package a file's source imports statically, dynamically, or requires:
 *  [{ name, spec, line, dynamic }] (spec is the whole specifier, subpath included). Type-only imports (`import type`) are skipped: they
 *  are gone from the built file, so they need nothing at runtime. */
export function importsOf(src) {
  const out = [];
  const lineAt = (i) => src.slice(0, i).split("\n").length;
  for (const [re, dynamic] of [[FROM, false], [BARE, false], [DYNAMIC, true], [REQUIRE, true]]) {
    for (const m of src.matchAll(re)) {
      const text = m[0];
      if (!dynamic && /^\s*(?:import|export)\s+type\b/.test(text.replace(/^[\n;]/, ""))) continue;
      const name = packageOf(m[1]);
      if (name) out.push({ name, spec: m[1], line: lineAt((m.index ?? 0) + text.lastIndexOf(m[1])), dynamic });
    }
  }
  return out;
}

/** Is this path code the browser bundles or a build/dev script, not code the API loads?
 *  The web build compiles `ui/` and every .tsx; tests and `scripts/` never run in the image. */
export function isNotLoadedByApi(path) {
  return (
    /(^|\/)(ui|web|scripts|tests?|__tests__|e2e|fixtures)\//.test(path) ||
    /\.(tsx|jsx)$/.test(path) ||
    /\.(test|spec)\.[cm]?[tj]sx?$/.test(path) ||
    /\.d\.[cm]?ts$/.test(path)
  );
}
