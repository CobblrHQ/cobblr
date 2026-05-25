// /configuration/permissions — admin-only. Per-member capability
// grants. The matrix is: rows = workspace members, columns = actions
// that have opted into being portal-grantable (manifest flag, today
// returned by GET /permissions/grantable-actions).
//
// Admins / owners are shown with "implicit" badges — they already
// have every capability and grants can't be added/removed for them.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Shield } from "lucide-react";
import { useToast, usePageTitle } from "@cobblr/platform-web";
import { ApiError, api } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

export function PermissionsPage() {
  usePageTitle("Permissions");
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();

  const matrixQ = useQuery({
    queryKey: ["permissions-matrix", activeSlug],
    queryFn: () => api.listPermissionMatrix(activeSlug),
  });
  const actionsQ = useQuery({
    queryKey: ["grantable-actions", activeSlug],
    queryFn: () => api.listGrantableActions(activeSlug),
  });

  const toggle = useMutation({
    mutationFn: ({
      user_id,
      action_id,
      grant,
    }: {
      user_id: string;
      action_id: string;
      grant: boolean;
    }) =>
      grant
        ? api.grantCapability(activeSlug, user_id, action_id)
        : api.revokeCapability(activeSlug, user_id, action_id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["permissions-matrix", activeSlug] });
    },
    onError: (e: unknown) =>
      toast.error(e instanceof ApiError ? e.message : "Couldn't update"),
  });

  const members = matrixQ.data?.members ?? [];
  const actions = actionsQ.data?.items ?? [];

  return (
    <div className="space-y-5 max-w-5xl">
      <div className="border-b border-slate-200 dark:border-slate-700 pb-3">
        <h1 className="font-display text-2xl font-extrabold text-slate-700 dark:text-mortar-100 lowercase">
          permissions
        </h1>
        <span className="text-[10px] font-mono text-slate-400 dark:text-slate-500">
          per-member capability grants. admins / owners have everything implicitly.
        </span>
      </div>

      {actions.length === 0 && (
        <div className="text-xs text-slate-400 italic">
          No grantable actions registered yet.
        </div>
      )}

      {actions.length > 0 && members.length > 0 && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-mortar-50 dark:bg-slate-800/40">
              <tr>
                <th className="text-left text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 px-3 py-2">
                  Member
                </th>
                {actions.map((a) => (
                  <th
                    key={a.action_id}
                    className="text-center text-[10px] font-mono text-cobble-600 dark:text-cobble-300 px-3 py-2"
                    title={a.description}
                  >
                    {a.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {members.map((m) => {
                const isAdmin = m.role === "owner" || m.role === "admin";
                return (
                  <tr key={m.id}>
                    <td className="px-3 py-2">
                      <div className="text-sm text-slate-700 dark:text-mortar-100">
                        {m.display_name}
                      </div>
                      <div className="text-[10px] font-mono text-slate-400 dark:text-slate-500">
                        {m.email} · {m.role}
                      </div>
                    </td>
                    {actions.map((a) => {
                      const granted = m.grants.includes(a.action_id);
                      if (isAdmin) {
                        return (
                          <td
                            key={a.action_id}
                            className="text-center px-3 py-2"
                            title="Admins have every capability implicitly."
                          >
                            <Shield
                              size={12}
                              className="inline text-cobble-500"
                            />
                          </td>
                        );
                      }
                      return (
                        <td key={a.action_id} className="text-center px-3 py-2">
                          <button
                            type="button"
                            onClick={() =>
                              toggle.mutate({
                                user_id: m.id,
                                action_id: a.action_id,
                                grant: !granted,
                              })
                            }
                            className={
                              "w-6 h-6 rounded inline-flex items-center justify-center transition " +
                              (granted
                                ? "bg-cobble-600 text-white hover:bg-cobble-700"
                                : "border border-slate-300 dark:border-slate-600 text-slate-300 dark:text-slate-600 hover:border-cobble-400")
                            }
                            title={granted ? "Revoke" : "Grant"}
                            data-action-id={a.action_id}
                            data-granted={granted}
                          >
                            {granted && <Check size={12} />}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
