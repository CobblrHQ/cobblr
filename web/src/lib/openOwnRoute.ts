// A scanned or pasted link to a page of this instance opens that page (#8874).
//
// The link is origin-absolute (/w/<slug>/inventory/parts/<id>), and the app's
// router is mounted under /w/<slug>. Every scan door handed the link to
// navigate(), which put it under the basename a second time
// (/w/<slug>/w/<slug>/…), and the person landed on the dashboard: a label or
// a link to your own thing never opened it. So the link is never a string a
// door can pass to navigate(): it is an OwnRoute, and the one way to open it
// is here. A page of this workspace opens in the app; any other page of the
// instance (another workspace, an invite, a pairing link) loads as a page.
import { useCallback } from "react";
import { useHref, useNavigate } from "react-router-dom";

/** A page of this instance, by its origin-absolute href. Never a router path. */
export interface OwnRoute {
  readonly href: string;
}

/** The in-app path for `href` under the router's `basename`, or null when
 *  the page is outside it. */
export function inAppPath(href: string, basename: string): string | null {
  const base = basename.replace(/\/+$/, "");
  if (!base) return href;
  if (href === base) return "/";
  for (const sep of ["/", "?", "#"]) {
    if (href.startsWith(base + sep)) return sep === "/" ? href.slice(base.length) : `/${href.slice(base.length)}`;
  }
  return null;
}

/** Open a scanned link to a page of this instance. */
export function useOpenOwnRoute(): (route: OwnRoute) => void {
  const navigate = useNavigate();
  const root = useHref("/");
  return useCallback(
    (route: OwnRoute) => {
      const inApp = inAppPath(route.href, root);
      if (inApp !== null) navigate(inApp);
      else window.location.assign(route.href);
    },
    [navigate, root],
  );
}
