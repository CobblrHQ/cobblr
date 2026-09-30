// Signed in, in no workspace. Replaces the whole shell, because there is no
// workspace to draw one for.
//
// This used to be one grey line ("no workspace yet - ask an admin to add you
// to one.") with nothing on it: no way to make a workspace, no way to sign
// out, no way to delete the account. It is exactly where a person lands after
// deleting their only workspace so that they can delete their account (the
// account page refuses a sole owner and says to delete the workspace first),
// so the one line stranded them a step from the end (#3276). Three doors now:
// make a workspace (the same modal the switcher opens), sign out, delete the
// account. A platform admin also gets the console, which is instance-wide.
import { useState } from "react";
import { usePageTitle } from "@cobblr/platform-web";
import { MAIN_ID, SkipToContent } from "../components/a11y/shell-landmarks";
import { useAuth } from "../auth/AuthContext";
import { CobblestoneMark } from "../CobblestoneMark";
import { CreateWorkspaceModal } from "../components/WorkspaceSwitcher";
import { DownloadMyDataSection } from "../components/DownloadMyDataSection";
import { DeleteAccountSection } from "../components/DeleteAccountSection";
import { DeletedWorkspaceBackups } from "../components/DeletedWorkspaceBackups";
import { goneWorkspaceMessage, takeGoneWorkspace } from "../lib/gone-workspace";

const PRIMARY = "rounded-md bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white font-medium px-4 py-2 transition";
const SECONDARY = "rounded-md border border-line dark:border-slate-700 px-4 py-2 font-medium hover:bg-subtle transition";

export function NoWorkspacePage() {
  usePageTitle("No workspace");
  const { user, logout } = useAuth();
  const [creating, setCreating] = useState(false);
  const [gone] = useState(takeGoneWorkspace);
  return (
    <main id={MAIN_ID} tabIndex={-1} data-testid="no-workspace" className="min-h-full flex items-center justify-center p-6 focus:outline-none">
      <SkipToContent />
      <div className="w-full max-w-md space-y-6">
        <div className="flex items-center gap-3">
          <CobblestoneMark size={32} />
          <div>
            <h1 className="text-lg font-semibold text-content dark:text-mortar-100">You are not in a workspace</h1>
            <div className="text-xs text-muted">{user?.email}</div>
          </div>
        </div>
        {gone && (
          <p data-testid="gone-workspace" role="status" className="rounded-md border border-line dark:border-slate-700 bg-subtle px-3 py-2 text-sm text-content dark:text-mortar-100">
            {goneWorkspaceMessage(gone)}
          </p>
        )}
        <p className="text-sm text-muted">
          Nothing here is yours yet. Make a workspace of your own, or wait for somebody to add you to theirs, or sign
          out.
        </p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={PRIMARY} onClick={() => setCreating(true)}>
            Make a workspace
          </button>
          <button type="button" className={SECONDARY} onClick={() => logout()}>
            Sign out
          </button>
          {user?.is_platform_admin && (
            <a href="/admin" className={SECONDARY}>
              Operator console
            </a>
          )}
        </div>
        {/* The backup of a workspace that was deleted, for its owner: most
            often the person who lands here is the one whose only workspace
            just went, so this is the page it has to be on. */}
        <DeletedWorkspaceBackups />
        <DownloadMyDataSection />
        <DeleteAccountSection />
      </div>
      <CreateWorkspaceModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(slug) => {
          setCreating(false);
          window.location.assign(`/w/${slug}`);
        }}
      />
    </main>
  );
}
