import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useConfirm, useToast } from "@cobblr/platform-web";
import { useAuth } from "../auth/AuthContext";
import { api } from "../lib/api";

export function MySignupInvites({ enabled }: { enabled: boolean }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const key = ["my-signup-invites", user?.id];
  const invites = useQuery({ queryKey: key, queryFn: () => api.listMySignupInvites(), enabled });
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeMySignupInvite(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: key });
      toast.success("Signup invite revoked.");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't revoke the invite."),
  });
  return <section className="space-y-2" aria-label="My signup invites">
    <h3 className="text-sm font-semibold">My invites to start a workspace</h3>
    <p className="text-sm text-muted">These invite someone to start their own Cobblr. Revoking one stops its link from being used.</p>
    {invites.isError && <p role="alert" className="text-sm text-ember-600 dark:text-ember-400">Couldn't load your signup invites.</p>}
    {invites.isLoading && <p className="text-sm text-muted">Loading invites…</p>}
    {invites.data?.items.length === 0 && <p className="text-sm text-muted">You have no signup invites.</p>}
    <ul className="space-y-2">
      {invites.data?.items.map((inv) => {
        const name = inv.note || inv.invited_email || "Link without an email address";
        return <li key={inv.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-line p-3">
          <div className="min-w-0 flex-1 break-words text-sm"><p>{name}</p><p className="text-muted">{inv.status}</p></div>
          {inv.status === "open" && <button type="button" className="min-h-11 rounded-md border border-line px-3 py-2 text-sm disabled:opacity-50" aria-label={`Revoke signup invite ${name}`} title={`Revoke signup invite ${name}`} disabled={revoke.isPending} onClick={async () => {
            const ok = await confirm({ title: "Revoke this signup invite?", message: "Its link will stop working. Anyone who already joined keeps their workspace.", confirmLabel: "Revoke invite", destructive: true });
            if (ok) revoke.mutate(inv.id);
          }}>Revoke</button>}
        </li>;
      })}
    </ul>
  </section>;
}
