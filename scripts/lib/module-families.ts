// Where a file sits in a module's family seam, and what its relative imports
// reach (docs/modules/digifab-families.md, docs/architecture/module-parts.md).
// Shared by lint:core-imports-no-family and lint:family-imports-only-core.
import { dirname, join, normalize, relative } from "node:path";

export interface Place { module: string; family: string | null; root: boolean; rel: string }

/** modules/<m>/src/<rel>: its module, and its family when under families/<f>/.
 *  `root` is a file directly in families/ (the composition roots). */
export function placeOf(file: string): Place | null {
  const m = /^modules\/([^/]+)\/src\/(.+)$/.exec(normalize(file).replace(/\\/g, "/"));
  if (!m) return null;
  const rel = m[2]!;
  const f = /^families\/([^/]+)\/./.exec(rel);
  return { module: m[1]!, family: f ? f[1]! : null, root: /^families\/[^/]+\.tsx?$/.test(rel), rel };
}

/** Every relative module specifier in a source, with its line. */
export function relativeImports(src: string): Array<{ spec: string; line: number }> {
  const out: Array<{ spec: string; line: number }> = [];
  src.split("\n").forEach((text, i) => {
    for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["'](\.{1,2}\/[^"']+)["']/g)) out.push({ spec: m[1]!, line: i + 1 });
  });
  return out;
}

/** The file a relative specifier names, as a repo path (".js" read as ".ts"). */
export function target(file: string, spec: string): string {
  return relative(".", join(dirname(file), spec)).replace(/\\/g, "/").replace(/\.js$/, ".ts");
}
