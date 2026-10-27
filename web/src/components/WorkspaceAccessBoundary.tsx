import { MAIN_ID, SkipToContent } from "./a11y/shell-landmarks";
import type { ReactNode } from "react";
import { useAuth } from "../auth/AuthContext";
import { urlHandleFor } from "../auth/ActiveOrgContext";
import { useWorkspaceUnavailable } from "../lib/workspace-unavailable";

export function WorkspaceAccessBoundary({ slug, children }: { slug: string; children: ReactNode }) {
  const ended = useWorkspaceUnavailable(slug);
  const { orgs, logout } = useAuth();
  if (!ended) return <>{children}</>;
  const other = orgs.find(org => org.slug !== slug && org.role === "owner") ?? orgs.find(org => org.slug !== slug);
  return (
    <>
      <SkipToContent />
      <main id={MAIN_ID} tabIndex={-1} className="focus:outline-none min-h-screen grid place-items-center bg-canvas text-content px-5 py-8">
        <div className="w-full max-w-md space-y-4">
          <h1 className="text-xl font-semibold">Access ended</h1>
          <p role="alert">This workspace is no longer available to you. The share may have ended or your access may have been removed.</p>
          {other ? (
            <a href={`/w/${urlHandleFor(other, orgs)}/`} className="inline-flex text-accent underline">Go to another workspace</a>
          ) : (
            <button type="button" onClick={logout} className="text-accent underline">Sign out</button>
          )}
        </div>
      </main>
    </>
  );
}
