// Leave a workspace somebody else owns: one confirm, shared by every door to
// it (the workspace switcher, and the member portal a guest lands in).
// Everything in the workspace stays for the people who remain; coming back
// takes a new invite. The api refuses the last owner, and says what to do.
import { useState } from "react";
import { Modal, useToast } from "@cobblr/platform-web";
import { api } from "../lib/api";
import { useAuth } from "../auth/AuthContext";

export function LeaveWorkspaceModal({
  workspace,
  isActive,
  onClose,
}: {
  workspace: { slug: string; name: string } | null;
  /** Leaving the workspace this tab is in: go to the default one after. */
  isActive: boolean;
  onClose: () => void;
}) {
  const { user, refreshMe } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const leave = async () => {
    if (!workspace || !user) return;
    setBusy(true);
    try {
      await api.removeMember(workspace.slug, user.id);
      if (isActive) {
        window.location.assign("/");
        return;
      }
      await refreshMe();
      toast.success(`You left ${workspace.name}.`);
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't leave the workspace");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={!!workspace} onClose={onClose} title="Leave workspace" size="sm">
      <div className="space-y-4 text-sm" data-testid="leave-workspace-modal">
        <p className="text-content dark:text-mortar-100">
          Leave <strong>{workspace?.name}</strong>? You stop seeing it; everything in it stays for the people who remain. To
          come back, somebody has to invite you again.
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-md border border-line dark:border-slate-600 px-3 py-1.5 font-medium hover:bg-subtle">
            Stay
          </button>
          <button type="button" onClick={leave} disabled={busy} className="rounded-md bg-ember-600 hover:bg-ember-700 text-white px-3 py-1.5 font-medium disabled:opacity-50">
            {busy ? "…" : "Leave"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
