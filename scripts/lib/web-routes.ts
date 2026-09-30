// The web app's routes, read from its router source. One reader, used by
// lint:routed-page-has-a-door and the coverage matrix's rows
// (scripts/lib/coverage-surfaces.ts), so the two cannot disagree about what
// a route is.
//
// A <Route> may span lines (`<Route\n path="…"\n element={…}`); a tag is read
// from `<Route` to its closing `/>` or `>`. `absolute: false` reads the
// relative paths a module's own router declares under its mount point.

export interface WebRoute {
  path: string;
  line: number;
  redirect: boolean;
}

export function routesIn(src: string, o: { absolute?: boolean } = {}): WebRoute[] {
  const absolute = o.absolute ?? true;
  const lines = src.split("\n");
  const out: WebRoute[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/<Route\b/.test(lines[i] ?? "")) continue;
    let tag = "";
    for (let j = i; j < Math.min(i + 12, lines.length); j++) {
      tag += (lines[j] ?? "") + "\n";
      if (/\/>\s*$|>\s*$/.test((lines[j] ?? "").trim()) && /path=|index/.test(tag)) break;
    }
    const path = (absolute ? /path="(\/[^"]*)"/ : /path="([^"]+)"/).exec(tag)?.[1];
    if (!path) continue;
    out.push({ path, line: i + 1, redirect: /element=\{\s*<(Navigate\b|\w*Redirect\b)/.test(tag) });
  }
  return out;
}
