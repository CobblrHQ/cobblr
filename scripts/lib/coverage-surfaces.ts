// The coverage matrix's rows and columns (#4286), derived from the platform's
// own registries and never from a hand list, so a page, a kind or an action
// shows up the day it ships, untested. Pure over its inputs; the generator
// (scripts/gen-coverage-surfaces.ts) reads the tree and lint:coverage-surfaces
// holds the committed file to it, so a registry row can never lack a matrix row.
//
// Rows:
//   route:<path>          every <Route> in the web app's router that is not a
//                         redirect, and every route a module's own router
//                         declares under its mount (a splat is its own row:
//                         the module's pages behind it are read where they
//                         are declared, never guessed)
//   kind:<id>:list        every entity kind with a detailRoute: its list page
//   kind:<id>:detail      (the detailRoute less its "/{id}") and detail page
//   action:<id>           every user-facing action a manifest exposes
//                         (userInvokable, not internal, not wire-only)
//   module:<name>         every stock module's own page, /<name>
// Write routes join when the API's mutating-route reader lands in scripts/lib.

import { moduleForRoute } from "../../packages/platform-contract/src/app-catalog.ts";
import { ORG_ROLES } from "../../packages/platform-contract/src/org-roles.ts";

export interface Dimension {
  id: string;
  label: string;
}

/** The ways a surface should be tested, in display order. The roles are the
 *  platform's own (ORG_ROLES), so a role added there is a column here. */
export const DIMENSIONS: Dimension[] = [
  { id: "390-light", label: "390 light" },
  { id: "390-dark", label: "390 dark" },
  { id: "1440", label: "1440 light" },
  { id: "1440-dark", label: "1440 dark" },
  { id: "fresh", label: "fresh workspace" },
  { id: "volume", label: "volume workspace" },
  ...ORG_ROLES.map((r) => ({ id: r, label: r })),
  { id: "api", label: "API parity" },
  { id: "cobb", label: "Cobb/MCP parity" },
];

const VIEWPORTS = ["390-light", "390-dark", "1440", "1440-dark"];
const SHAPES = ["fresh", "volume"];
const PAGE_DIMS = [...VIEWPORTS, ...SHAPES, ...ORG_ROLES];
const KIND_DIMS = [...PAGE_DIMS, "api", "cobb"];
const ACTION_DIMS = [...SHAPES, ...ORG_ROLES, "api", "cobb"];

export type SurfaceKind = "route" | "entity-list" | "entity-detail" | "action" | "module-page";

export interface Surface {
  id: string;
  kind: SurfaceKind;
  label: string;
  module: string | null;
  area: string | null;
  nav: boolean;
  first_run: boolean;
  source: string;
  applicable: string[];
  /** The dimensions left out of `applicable` on purpose, each with why: a
   *  page no one is signed in on has no workspace role (NOT_APPLICABLE). */
  na?: Record<string, string>;
  /** The page's route pattern (":id", "{id}", "*"), for a row a browser visits; absent for an action. */
  path?: string;
  /** The files that make the surface (a page component, a module's ui or
   *  api), so the poster can stamp when it last changed. */
  files?: string[];
}

export interface ManifestFacts {
  name: string;
  band?: string;
  autoEnable?: boolean;
  nav?: { route?: string; label?: string } | null;
  kinds: Array<{ id: string; label?: string; detailRoute?: string }>;
  actions: Array<{ id: string; label?: string; userInvokable?: boolean; internal?: boolean; wireOnly?: boolean }>;
  file: string;
}

export interface Inputs {
  appRoutes: Array<{ path: string; redirect: boolean }>;
  /** The page component file each app route renders, by route path, where it could be read. */
  appRouteFiles?: Record<string, string>;
  /** Whether a repository-relative folder exists (the generator passes the real check). */
  hasDir?: (path: string) => boolean;
  appFile: string;
  moduleRoutes: Array<{ module: string; mount: string; path: string; redirect: boolean; file: string }>;
  manifests: ManifestFacts[];
  /** Module names every new workspace has (foundational allowlist + autoEnable). */
  defaultModules: Set<string>;
  /** Audit area -> the modules its walk covers. */
  areas: Array<{ area: string; modules: string[]; paths?: string[] }>;
  /** The kernel's own actions (platform:*), which no manifest declares. */
  platformActions?: { file: string; actions: Array<{ id: string; label?: string; userInvokable?: boolean; wireOnly?: boolean }> };
}

const norm = (p: string) => ("/" + p.replace(/^\/+|\/+$/g, "")).replace(/\/{2,}/g, "/");

/** A module's ui or api folder, from any file under its src. */
const srcDir = (file: string) => file.replace(/\/src\/.*$/, "/src");
const uiDir = (file: string) => `${srcDir(file)}/ui`;
const apiDir = (file: string) => `${srcDir(file)}/api`;

/** Pages where some dimensions cannot apply, and why. A cell there is not
 *  owed, so the dimension leaves the row's `applicable` (the matrix's
 *  denominator) and the row says why, rather than reading "never tested". */
export const NOT_APPLICABLE: Array<{ paths: RegExp; dims: string[]; why: string }> = [
  {
    // Opened signed out, from a link or the front door: no workspace exists in
    // the visit, so no role, and no standing workspace's volume.
    paths: /^\/(verify\/:token|try\/join\/:token|try\/ended|p\/:token|p\/:org\/:address|login|signup)$/,
    dims: [...ORG_ROLES, "volume"],
    why: "opened signed out from a link: there is no workspace, so no role and no volume",
  },
  {
    // A station screen signs in with the station's own token, set up by the
    // workspace's owner: no member, editor or guest ever holds it.
    paths: /^\/station\//,
    dims: ORG_ROLES.filter((r) => r !== "owner"),
    why: "a station runs on its own station token, set up by the owner: no other workspace role uses it",
  },
];

/** A page's dimensions with the ones that cannot apply taken out, and why. */
export function pageDimensions(path: string, dims: string[] = PAGE_DIMS): { applicable: string[]; na?: Record<string, string> } {
  const na: Record<string, string> = {};
  for (const rule of NOT_APPLICABLE) if (rule.paths.test(path)) for (const d of rule.dims) if (dims.includes(d)) na[d] = rule.why;
  const applicable = dims.filter((d) => !(d in na));
  return Object.keys(na).length ? { applicable, na } : { applicable };
}

export function deriveSurfaces(i: Inputs): Surface[] {
  // A module's page is its own ui when it has one, otherwise the web page its
  // address renders (assets, purchases, records draw theirs in web/src/pages).
  // Only folders that exist: a module without a ui or api folder claims none.
  const real = (paths: string[]) => paths.filter((p) => /\.[a-z]+$/.test(p) || !i.hasDir || i.hasDir(p));
  const modulePageFiles = (file: string, path: string): { files?: string[] } => {
    if (i.hasDir?.(uiDir(file))) return { files: [uiDir(file)] };
    const page = i.appRouteFiles?.[path] ?? i.appRouteFiles?.[path.slice(1)];
    return page ? { files: [page] } : {};
  };
  const byModule = new Map(i.manifests.map((m) => [m.name, m]));
  const areaOf = (mod: string | null, path?: string) => i.areas.find(a => path && a.paths?.some(p => norm(p) === path))?.area ?? (mod ? (i.areas.find((a) => a.modules.includes(mod))?.area ?? null) : null);
  const navRoutes = new Set<string>();
  for (const m of i.manifests) {
    if (m.nav?.route) navRoutes.add(norm(m.nav.route));
    if (m.band !== "foundational" && !m.name.startsWith("core-")) navRoutes.add(`/${m.name}`);
  }
  const firstRun = (mod: string | null) => mod === null || i.defaultModules.has(mod);

  const out = new Map<string, Surface>();
  const add = (s: Surface) => {
    if (!out.has(s.id)) out.set(s.id, s);
  };

  for (const r of i.appRoutes) {
    if (r.redirect) continue;
    const path = norm(r.path);
    const mod = moduleForRoute(path, i.manifests);
    add({ id: `route:${path}`, kind: "route", label: path, module: mod, area: areaOf(mod, path), nav: navRoutes.has(path), first_run: firstRun(mod), source: i.appFile, ...pageDimensions(path), path, ...(i.appRouteFiles?.[r.path] ? { files: [i.appRouteFiles[r.path]!] } : {}) });
  }
  for (const r of i.moduleRoutes) {
    if (r.redirect) continue;
    const path = norm(`${r.mount}/${r.path}`);
    add({ id: `route:${path}`, kind: "route", label: path, module: r.module, area: areaOf(r.module, path), nav: navRoutes.has(path), first_run: firstRun(r.module), source: r.file, ...pageDimensions(path), path, files: real([uiDir(r.file)]) });
  }
  for (const m of i.manifests) {
    const area = areaOf(m.name);
    for (const k of m.kinds) {
      if (!k.detailRoute) continue;
      const detail = k.detailRoute.split("?")[0]!;
      const list = norm(detail.replace(/\/\{id\}.*$/, ""));
      const label = k.label ?? k.id;
      add({ id: `kind:${k.id}:list`, kind: "entity-list", label: `${label} list`, module: m.name, area, nav: navRoutes.has(list), first_run: firstRun(m.name), source: m.file, applicable: KIND_DIMS, path: list, files: real([m.file, uiDir(m.file)]) });
      if (/\{id\}/.test(detail))
        add({ id: `kind:${k.id}:detail`, kind: "entity-detail", label: `${label} page`, module: m.name, area, nav: false, first_run: firstRun(m.name), source: m.file, applicable: KIND_DIMS, path: norm(detail), files: real([m.file, uiDir(m.file)]) });
    }
    for (const a of m.actions) {
      if (!a.userInvokable || a.internal || a.wireOnly) continue;
      add({ id: `action:${a.id}`, kind: "action", label: a.label ?? a.id, module: m.name, area, nav: false, first_run: firstRun(m.name), source: m.file, applicable: ACTION_DIMS, files: real([m.file, apiDir(m.file)]) });
    }
    if (m.band !== "foundational" && !m.name.startsWith("core-"))
      add({ id: `module:${m.name}`, kind: "module-page", label: m.nav?.label ?? m.name, module: m.name, area, nav: true, first_run: firstRun(m.name), source: m.file, applicable: PAGE_DIMS, path: `/${m.name}`, ...modulePageFiles(m.file, `/${m.name}`) });
  }
  // The kernel's own actions: renaming the workspace, restoring a record,
  // arranging record actions. Every workspace has them, so they are the
  // platform's, not a module's.
  for (const a of i.platformActions?.actions ?? []) {
    if (!a.userInvokable || a.wireOnly) continue;
    const file = i.platformActions!.file;
    add({ id: `action:${a.id}`, kind: "action", label: a.label ?? a.id, module: null, area: null, nav: false, first_run: true, source: file, applicable: ACTION_DIMS, files: real([file]) });
  }
  // byModule kept for a reader that wants the manifest behind a row.
  void byModule;
  return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
}
