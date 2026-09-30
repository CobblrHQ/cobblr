// The strip every member sees while a workspace is set to be deleted: the day
// it goes, and for an owner the way to keep it. Deleting a workspace is never a
// surprise to the people in it (CLAUDE.md section 7: a backup, a grace period,
// then the drop), and the owner who asked can change their mind from any page.
//
// Its own strip rather than a state of WorkspaceStateBar: a trial or a kept
// sandbox can be set to be deleted too, and the two lines are about different
// things. Both join the bottom dock, which stacks them.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { FloatingChrome, useToast } from "@cobblr/platform-web";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import { api } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { untilDate } from "./WorkspaceStateBar";

export const workspaceStateKey = (slug: string) => ["workspace-state", slug] as const;

export function useWorkspaceDeletion(slug: string) {
  const q = useQuery({
    queryKey: workspaceStateKey(slug),
    queryFn: () => api.workspaceTrial(slug),
    enabled: !!slug,
    staleTime: 60_000,
  });
  const due = q.data?.deletion_due_at ? Date.parse(q.data.deletion_due_at) : null;
  return { dueAt: due, loading: q.isLoading };
}

export function useKeepWorkspace(slug: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: () => api.keepWorkspace(slug),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: workspaceStateKey(slug) });
      toast.success("Kept. This workspace is no longer set to be deleted.");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't keep the workspace"),
  });
}

export function WorkspaceDeletionBar({ slug }: { slug: string }) {
  const { activeOrg } = useActiveOrg();
  const { dueAt } = useWorkspaceDeletion(slug);
  const keep = useKeepWorkspace(slug);
  if (dueAt == null) return null;
  const owner = roleSatisfies(activeOrg?.role, ["owner"]);
  return (
    <FloatingChrome
      anchor="bottom"
      className="z-40 border-t px-4 py-2 text-sm flex flex-wrap items-center justify-center gap-x-3 gap-y-2 bg-ember-50 dark:bg-ember-950 border-ember-300 dark:border-ember-800"
      data-testid="workspace-deletion"
    >
      <span className="text-ember-700 dark:text-ember-300 font-medium text-center leading-snug">
        This workspace and everything in it will be deleted on {untilDate(dueAt)}.
        {owner ? "" : " Ask an owner if it should stay."}
      </span>
      {owner && (
        <span className="flex items-center gap-2">
          <Link to="/configuration/backup" className="underline text-ember-800 dark:text-ember-200">
            Download a backup
          </Link>
          <button
            type="button"
            onClick={() => keep.mutate()}
            disabled={keep.isPending}
            className="rounded-md bg-cobble-600 hover:bg-cobble-700 text-white font-medium px-3 py-1 transition disabled:opacity-50"
          >
            {keep.isPending ? "Keeping…" : "Keep this workspace"}
          </button>
        </span>
      )}
    </FloatingChrome>
  );
}
