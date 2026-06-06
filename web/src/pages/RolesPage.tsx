// /configuration/roles — admin-only. Custom-role authoring + the
// member-to-role assignment matrix.
//
// Stock roles (owner/admin/member/guest) stay; custom roles are
// additive. A member can have any number of custom roles in addition
// to their stock role.
//
// See docs/modules/member-portal-and-permissions.md §7
// + 2026-05-25-audit.md S2.

import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Pencil, Plus, Trash2 } from "lucide-react";
import { Modal, useConfirm, usePageTitle, useToast } from "@cobblr/platform-web";
import { ApiError, api, type CustomRole } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

export function RolesPage() {
  usePageTitle("Custom roles");
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<CustomRole | null>(null);
  const [creating, setCreating] = useState(false);

  const rolesQ = useQuery({
    queryKey: ["custom-roles", activeSlug],
    queryFn: () => api.listCustomRoles(activeSlug),
  });
  const grantableQ = useQuery({
    queryKey: ["grantable-actions", activeSlug],
    queryFn: () => api.listGrantableActions(activeSlug),
  });
  const membersQ = useQuery({
    queryKey: ["permissions-matrix", activeSlug],
    queryFn: () => api.listPermissionMatrix(activeSlug),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteCustomRole(activeSlug, id),
    onSuccess: () => {
      toast.success("Role deleted.");
      void qc.invalidateQueries({ queryKey: ["custom-roles", activeSlug] });
    },
    onError: (e: unknown) =>
      toast.error(e instanceof ApiError ? e.message : "Couldn't delete"),
  });

  const assign = useMutation({
    mutationFn: ({ user_id, role_id, grant }: { user_id: string; role_id: string; grant: boolean }) =>
      grant
        ? api.assignCustomRole(activeSlug, user_id, role_id)
        : api.unassignCustomRole(activeSlug, user_id, role_id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["permissions-matrix", activeSlug] });
    },
  });

  const roles = rolesQ.data?.items ?? [];
  const members = membersQ.data?.members ?? [];

  return (
    <div className="space-y-5 max-w-5xl">
      <div className="flex items-baseline justify-between border-b border-line dark:border-slate-700 pb-3">
        <div>
          <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 page-title">
            custom roles
          </h1>
          <span className="page-subtitle">
            workspace-defined capability bundles. members get stock role +
            any custom roles you assign.
          </span>
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-1.5 rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-sm font-medium px-3 py-1.5 transition"
        >
          <Plus size={14} /> New role
        </button>
      </div>

      {roles.length === 0 && (
        <div className="text-xs text-faint italic">
          No custom roles yet. Create one to bundle multiple capabilities under a name (e.g. "Sorter" = create-part + assign-location).
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {roles.map((r) => (
          <div
            key={r.id}
            className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-2"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-display font-bold text-content dark:text-mortar-100">
                  {r.name}
                </div>
                {r.description && (
                  <div className="text-xs text-muted dark:text-slate-400">
                    {r.description}
                  </div>
                )}
                <div className="text-[10px] font-mono uppercase tracking-widest text-faint mt-1">
                  {r.member_count} member{r.member_count === 1 ? "" : "s"} ·{" "}
                  {r.capabilities.length} capabilit{r.capabilities.length === 1 ? "y" : "ies"}
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => setEditing(r)}
                  className="text-faint hover:text-accent transition p-1"
                  title="Edit"
                >
                  <Pencil size={12} />
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    const ok = await confirm({
                      title: `Delete "${r.name}"?`,
                      message: `Removes this role and unassigns it from ${r.member_count} member${r.member_count === 1 ? "" : "s"}. The capabilities those members had via this role are revoked unless they get them from another source.`,
                      confirmLabel: "Delete role",
                      destructive: true,
                    });
                    if (ok) remove.mutate(r.id);
                  }}
                  className="text-faint hover:text-ember-500 transition p-1"
                  title="Delete"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
            <div className="flex flex-wrap gap-1">
              {r.capabilities.map((c) => (
                <span
                  key={c}
                  className="text-[10px] font-mono rounded border border-cobble-200 dark:border-cobble-700 bg-cobble-50/50 dark:bg-cobble-900/30 px-1.5 py-0.5 text-accent dark:text-cobble-300"
                >
                  {c}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>

      {roles.length > 0 && members.length > 0 && (
        <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 overflow-x-auto">
          <div className="text-[10px] font-mono uppercase tracking-widest text-faint px-3 pt-2 pb-1">
            Assignments
          </div>
          <table className="w-full text-sm">
            <thead className="bg-subtle/50 dark:bg-slate-800/40">
              <tr>
                <th className="text-left text-[10px] font-mono uppercase tracking-widest text-faint px-3 py-2">
                  Member
                </th>
                {roles.map((r) => (
                  <th
                    key={r.id}
                    className="text-center text-[10px] font-mono text-accent px-3 py-2"
                  >
                    {r.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line dark:divide-slate-800">
              {members.map((m) => {
                const isAdmin = m.role === "owner" || m.role === "admin";
                // Need to know which roles a member has — fetch
                // assignments via the matrix? For v1 just always
                // show unchecked + let the toggle act. We re-query
                // on toggle to refresh.
                if (isAdmin) {
                  return (
                    <tr key={m.id}>
                      <td className="px-3 py-2">
                        <div className="text-sm text-content dark:text-mortar-100">{m.display_name}</div>
                        <div className="text-[10px] font-mono text-faint">{m.email}</div>
                      </td>
                      {roles.map((r) => (
                        <td
                          key={r.id}
                          className="text-center px-3 py-2 text-[10px] text-faint"
                          title="Admins have every capability implicitly"
                        >
                          —
                        </td>
                      ))}
                    </tr>
                  );
                }
                return (
                  <tr key={m.id}>
                    <td className="px-3 py-2">
                      <div className="text-sm text-content dark:text-mortar-100">{m.display_name}</div>
                      <div className="text-[10px] font-mono text-faint">{m.email}</div>
                    </td>
                    {roles.map((r) => (
                      <td key={r.id} className="text-center px-3 py-2">
                        <AssignToggle
                          assigned={m.custom_role_ids.includes(r.id)}
                          roleId={r.id}
                          onToggle={(grant) =>
                            assign.mutate({ user_id: m.id, role_id: r.id, grant })
                          }
                        />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <RoleEditorModal
        open={creating}
        role={null}
        actions={grantableQ.data?.items ?? []}
        slug={activeSlug}
        onClose={() => setCreating(false)}
        onSaved={() => {
          setCreating(false);
          void qc.invalidateQueries({ queryKey: ["custom-roles", activeSlug] });
        }}
      />
      <RoleEditorModal
        open={!!editing}
        role={editing}
        actions={grantableQ.data?.items ?? []}
        slug={activeSlug}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void qc.invalidateQueries({ queryKey: ["custom-roles", activeSlug] });
        }}
      />
    </div>
  );
}

// Controlled by the parent — `assigned` comes from the permissions
// matrix's custom_role_ids array. Optimistic flip on click; the
// mutation invalidates the matrix query and the parent re-renders
// with the real state.
function AssignToggle({
  assigned,
  roleId,
  onToggle,
}: {
  assigned: boolean;
  roleId: string;
  onToggle: (grant: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onToggle(!assigned)}
      className={
        "w-6 h-6 rounded inline-flex items-center justify-center transition " +
        (assigned
          ? "bg-cobble-600 text-white hover:bg-cobble-700"
          : "border border-line dark:border-slate-600 text-faint dark:text-slate-600 hover:border-accent")
      }
      title={assigned ? "Unassign" : "Assign"}
      data-role-id={roleId}
      data-assigned={assigned}
    >
      {assigned && <Check size={12} />}
    </button>
  );
}

function RoleEditorModal({
  open,
  role,
  actions,
  slug,
  onClose,
  onSaved,
}: {
  open: boolean;
  role: CustomRole | null;
  actions: Array<{ action_id: string; label: string; description: string }>;
  slug: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(role?.name ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [picked, setPicked] = useState<Set<string>>(new Set(role?.capabilities ?? []));

  // Re-seed when role changes.
  useState(() => {
    setName(role?.name ?? "");
    setDescription(role?.description ?? "");
    setPicked(new Set(role?.capabilities ?? []));
  });

  function toggle(actionId: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(actionId)) next.delete(actionId);
      else next.add(actionId);
      return next;
    });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      if (role) {
        await api.updateCustomRole(slug, role.id, {
          name: name.trim(),
          description: description.trim() || null,
          capabilities: Array.from(picked),
        });
        toast.success("Role updated.");
      } else {
        await api.createCustomRole(slug, {
          name: name.trim(),
          description: description.trim() || undefined,
          capabilities: Array.from(picked),
        });
        toast.success("Role created.");
      }
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't save");
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={role ? "Edit role" : "New role"} size="md">
      <form onSubmit={submit} className="space-y-3">
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-faint mb-1">
            Name
          </span>
          <input
            type="text"
            required
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Sorter"
            className="input"
          />
        </label>
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-faint mb-1">
            Description (optional)
          </span>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Bricks into bins; doesn't touch orders."
            className="input"
          />
        </label>
        <div>
          <div className="block text-[10px] font-mono uppercase tracking-widest text-faint mb-1">
            Capabilities
          </div>
          {actions.length === 0 && (
            <div className="text-xs text-faint italic">No grantable actions in this workspace yet.</div>
          )}
          <div className="space-y-1 max-h-64 overflow-y-auto rounded-md border border-line dark:border-slate-700 p-2">
            {actions.map((a) => (
              <label key={a.action_id} className="flex items-start gap-2 px-1 py-1 cursor-pointer hover:bg-subtle/50 dark:hover:bg-slate-800/40 rounded">
                <input
                  type="checkbox"
                  checked={picked.has(a.action_id)}
                  onChange={() => toggle(a.action_id)}
                  className="accent-cobble-500 mt-0.5"
                />
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-content dark:text-mortar-100">{a.label}</div>
                  <div className="text-[10px] font-mono text-faint">{a.action_id}</div>
                </div>
              </label>
            ))}
          </div>
        </div>
        <div className="flex gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-md border border-line dark:border-slate-700 text-sm text-content dark:text-mortar-200 hover:bg-subtle dark:hover:bg-slate-800 transition py-2"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!name.trim()}
            className="flex-1 rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-sm font-medium py-2 transition disabled:opacity-50"
          >
            {role ? "Save" : "Create"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

