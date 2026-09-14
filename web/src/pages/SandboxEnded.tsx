// The end of a no-account sandbox. Replaces the whole workspace shell.
//
// This used to be a strip at the foot of the page: "Your hour is up, and this
// sandbox was deleted", under a dashboard that kept painting its cached items
// and alerts, with the first-run tour opening on top of it because the
// dashboard's content probe read the failing reads as an empty workspace
// (2026-09-14). A deleted workspace is not a place with a bar on it; it is
// gone, and the page says so with nothing else on it.
//
// The work cannot be rescued here (expiry hard-deletes the workspace and drops
// its database, so offering recovery would be a lie), but the person is as
// decided as they will ever be, and the honest next step is the product: the
// two real doors lead, and another sandbox follows. The same three the strip
// offered in its last fifteen minutes, from the same server answer, so the
// email, the modal and this page can never disagree about where they point.
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useAuth } from "../auth/AuthContext";
import { clearSandboxExpiry } from "../lib/sandbox-session";

const PRIMARY = "rounded-md bg-cobble-600 hover:bg-cobble-700 text-white font-medium px-4 py-2 transition";
const SECONDARY = "rounded-md border border-line dark:border-slate-700 px-4 py-2 font-medium hover:bg-subtle transition";

export function SandboxEnded() {
  const { logout } = useAuth();
  const [paths, setPaths] = useState<{ cloud_url: string | null; selfhost_url: string | null } | null>(null);

  useEffect(() => {
    // Nothing to come back to: the hint would paint a countdown at zero and
    // the session would open a dead dashboard. A reload lands on the front
    // door instead, which is where the doors below lead anyway.
    clearSandboxExpiry();
    logout();
  }, [logout]);
  useEffect(() => {
    // A deployment with neither door configured, or one that cannot be asked,
    // still has the front door.
    void api.sandboxPaths().then(setPaths).catch(() => setPaths({ cloud_url: null, selfhost_url: null }));
  }, []);

  return (
    <div className="min-h-screen grid place-items-center bg-canvas text-content px-6" data-testid="sandbox-ended">
      <div className="max-w-md text-center">
        <p className="font-mono text-xs uppercase tracking-widest text-faint">sandbox</p>
        <h1 className="mt-2 text-2xl font-bold text-slate-700 dark:text-mortar-100">Your hour is up.</h1>
        <p className="mt-2 text-muted">
          Sandboxes only last an hour, on purpose: nothing you did is still sitting on our server. Cobblr itself
          keeps everything, for as long as you like.
        </p>
        <div className="mt-6 flex flex-wrap gap-3 justify-center">
          {paths?.cloud_url && (
            <a href={paths.cloud_url} className={PRIMARY}>
              Get your own, hosted
            </a>
          )}
          {paths?.selfhost_url && (
            <a href={paths.selfhost_url} target="_blank" rel="noreferrer" className={SECONDARY}>
              Run it yourself
            </a>
          )}
          {paths != null && !paths.cloud_url && (
            <a href="/?mode=signup" className={PRIMARY}>
              Make an account
            </a>
          )}
        </div>
        <p className="mt-6 text-sm">
          <a href="/api/v1/try" className="text-muted underline">
            or start another sandbox
          </a>
        </p>
      </div>
    </div>
  );
}
