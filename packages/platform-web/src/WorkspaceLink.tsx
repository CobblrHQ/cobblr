// A link to a page in a workspace (#5403).
//
// The app's router runs under basename /w/<handle>, so an in-router `to` is
// already inside the active workspace: "/w/<slug>/ai" there resolves to
// /w/<handle>/w/<slug>/ai, which no route matches, and the catch-all lands on
// the dashboard. A page in the workspace the router is in is an in-router
// path. A page in any other workspace, or a link drawn by a page mounted
// outside the workspace router (a station tablet), is a full-page address:
// one router only ever sees one workspace. lint:workspace-links-go-through-
// the-helper refuses a "/w/" Link or navigate() target anywhere else.
import type { AnchorHTMLAttributes } from "react";
import { Link, useHref } from "react-router-dom";
import { useActiveWorkspaceSlug } from "./context";

export type WorkspaceTarget = { inRouter: true; to: string } | { inRouter: false; href: string };

/** Where a link to `path` in workspace `slug` goes, given the router's root
 *  (useHref("/"): "/w/<handle>/" inside a workspace, "/" outside) and the
 *  workspace the surface is drawn for. Pure, so the rule is tested alone. */
export function workspaceTarget(slug: string, path: string, here: { root: string; activeSlug: string | null }): WorkspaceTarget {
  const rest = path.startsWith("/") ? path : `/${path}`;
  // The router's own workspace: its handle is the slug, or the slug without
  // its random suffix when that is unique (urlHandleFor).
  const handle = here.root.match(/^\/w\/([^/]+)/)?.[1];
  const routerIsIn = !!handle && (slug === handle || slug.startsWith(`${handle}-`));
  return routerIsIn && here.activeSlug === slug ? { inRouter: true, to: rest } : { inRouter: false, href: `/w/${slug}${rest}` };
}

/** workspaceTarget for this surface. */
export function useWorkspaceTarget(): (slug: string, path: string) => WorkspaceTarget {
  const root = useHref("/");
  const activeSlug = useActiveWorkspaceSlug();
  return (slug, path) => workspaceTarget(slug, path, { root, activeSlug });
}

/** A link to `to` (a path inside the workspace, "/configuration/ai#x") in
 *  workspace `slug`: a router Link when that is the workspace this page is in,
 *  a full-page <a> otherwise. */
export function WorkspaceLink({ slug, to, ...anchor }: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & { slug: string; to: string }) {
  const target = useWorkspaceTarget()(slug, to);
  return target.inRouter ? <Link to={target.to} {...anchor} /> : <a href={target.href} {...anchor} />;
}
