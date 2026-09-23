// Which app URLs are served WITHOUT the /w/<slug>/ basename, read from
// web/src/App.tsx itself.
//
// A driver (a guided tour, a walkthrough) should reach every workspace route
// through the basename, because an un-prefixed one is LandingRedirect: a full
// document replacement, four to five main-frame loads against one (#3422). But
// some routes genuinely live outside it, and prefixing THOSE is the opposite
// mistake: `/w/<slug>/admin/users` is ConsoleEscape, another full navigation,
// back out to the top-level operator console.
//
// That list was written by hand three times in one day (a converter, a lint, a
// helper's comment), and the first copy was missing /admin, /t and the auth
// page, so it prefixed the operator console in a walkthrough. The list is not
// ours to write down: App.tsx decides it, so read it from there.
//
// Two sources in App.tsx, both parsed:
//   - `function Shell`'s own `pathname === "/x"` / `pathname.startsWith("/x/")`
//     checks, which mount a whole tree (the operator console, the sandbox
//     landing) before any router sees the URL;
//   - `function PublicRoutes`'s `<Route path="/x…" element={<Page />} />` rows,
//     EXCEPT the catch-all and any element named *Redirect: those exist to
//     send an un-prefixed URL somewhere else, which is exactly what a driver
//     must not pay for.
// Plus the auth page, which is the bare origin with a query (`/?mode=signup`).

export interface UnprefixedRoutes {
  /** First path segments served outside the basename, e.g. "p", "admin". */
  segments: string[];
  /** Whether a path (starting with "/") is one of them. */
  isUnprefixed(path: string): boolean;
}

function body(src: string, fn: string): string {
  const start = src.indexOf(`function ${fn}(`);
  if (start < 0) throw new Error(`App.tsx has no function ${fn}() — the route table moved; update scripts/lib/unprefixed-routes.ts`);
  const end = src.indexOf("\n}\n", start);
  return src.slice(start, end < 0 ? undefined : end);
}

export function unprefixedRoutes(appTsx: string): UnprefixedRoutes {
  const segs = new Set<string>();

  for (const m of body(appTsx, "Shell").matchAll(/pathname(?:\.startsWith\("\/([^/"]+)\/?"\)| === "\/([^/"]+)")/g)) {
    segs.add((m[1] ?? m[2])!);
  }
  for (const m of body(appTsx, "PublicRoutes").matchAll(/<Route path="\/([^/":*]+)[^"]*" element=\{<(\w+)/g)) {
    if (/Redirect$/.test(m[2]!)) continue;
    segs.add(m[1]!);
  }

  const segments = [...segs].sort();
  const re = new RegExp(`^/(?:${segments.map((s) => s.replace(/[-]/g, "\\-")).join("|")})(?=/|$|\\?)|^/\\?`);
  return { segments, isUnprefixed: (path: string) => re.test(path) };
}
