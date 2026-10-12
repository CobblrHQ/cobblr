// A link the server made to a record (`subject.href`,
// "/w/<slug>/inventory/parts/<id>"), opened from inside the app.
//
// The router's basename is already `/w/<active workspace>`, so handing it the
// server's whole path doubled the prefix ("/w/a/w/a/inventory/…"), matched
// nothing, and the catch-all landed on the dashboard (#5938, and a build's
// as-built inputs, #5998). A subject in the workspace you are in is a route
// inside it; one in another of your workspaces is a page load into that
// workspace, since the router cannot leave its own basename. Shared here so a
// module's page and the web app's open a record the same way.
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useActiveWorkspaceSlug } from "./context";

/** Where a server-made subject link goes from inside workspace `activeSlug`. */
export function subjectRoute(href: string, activeSlug: string | null | undefined): { to: string } | { href: string } {
  const m = /^\/w\/([^/?#]+)(.*)$/.exec(href);
  if (!m) return { to: href };
  const slug = decodeURIComponent(m[1]!);
  if (slug === activeSlug) return { to: m[2] || "/" };
  return { href };
}

export function SubjectLink({ href, children, className, testId, activeSlug }: { href: string; children: ReactNode; className?: string; testId?: string; activeSlug?: string | null }) {
  const fromProvider = useActiveWorkspaceSlug();
  const route = subjectRoute(href, activeSlug === undefined ? fromProvider : activeSlug);
  return "to" in route ? (
    <Link to={route.to} className={className} data-testid={testId}>
      {children}
    </Link>
  ) : (
    <a href={route.href} className={className} data-testid={testId}>
      {children}
    </a>
  );
}
