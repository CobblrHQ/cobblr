// What someone sees on a settings page their role cannot use: who runs it,
// and where their own settings are. Never the page's controls, which the
// server would refuse on every save. A page with a part everyone may read
// (the AI page's "who answers" order, #5622) shows it below, read-only.
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

export function ManagedByAdmins({ page, children }: { page?: string; children?: ReactNode }) {
  const card = (
    <div role="status" className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-6 text-center space-y-2">
      <div className="font-medium text-content dark:text-mortar-100">
        {page ? `${page} is for this workspace's admins.` : "Workspace configuration is managed by this workspace's admins."}
      </div>
      <p className="text-sm text-muted dark:text-slate-400">
        Your own settings - appearance, notifications, connections - live under{" "}
        <Link to="/me" className="text-accent hover:underline">
          Your account
        </Link>
        .
      </p>
    </div>
  );
  return children ? (
    <div className="space-y-6">
      {card}
      {children}
    </div>
  ) : (
    card
  );
}
