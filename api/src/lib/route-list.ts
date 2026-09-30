// Every route an Express app answers, as "METHOD /path/:param", read from the
// app's own router at the moment it is asked (module routers mount at boot, so
// they are included once the api is up). For tests that must judge EVERY
// route by role: a hand-kept list goes stale the day a route is added.
import type { Express } from "express";

interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
  name?: string;
  handle?: { stack?: Layer[] };
  regexp?: RegExp;
  path?: string;
}

/** The mount prefix of a router layer, with each captured parameter named
 *  `:param` (Express 4 keeps only the compiled pattern). */
function prefixOf(layer: Layer): string {
  const src = layer.regexp?.source ?? "";
  if (src === "^\\/?(?=\\/|$)" || src === "^\\/?$") return "";
  return src
    .replace(/^\^/, "")
    .replace(/\\\/\?\(\?=\\\/\|\$\)$/, "")
    .replace(/\(\?:\\\/\(\[\^\\\/\]\+\?\)\)/g, "/:param")
    .replace(/\(\?:\(\[\^\\\/\]\+\?\)\)/g, ":param")
    .replace(/\\\//g, "/")
    .replace(/\?\(\?=.*$/, "")
    .split("(?:/([^/]+?))")
    .join("/:param");
}

export function listRoutes(app: Express): string[] {
  const out = new Set<string>();
  const walk = (stack: Layer[], base: string) => {
    for (const l of stack) {
      if (l.route) {
        for (const m of Object.keys(l.route.methods)) out.add(`${m.toUpperCase()} ${(base + l.route.path).replace(/\/orgs\/:param/, "/orgs/:slug")}`);
      } else if (l.name === "router" && l.handle?.stack) {
        walk(l.handle.stack, base + prefixOf(l));
      }
    }
  };
  walk((app as unknown as { _router: { stack: Layer[] } })._router.stack, "");
  return [...out].sort();
}
