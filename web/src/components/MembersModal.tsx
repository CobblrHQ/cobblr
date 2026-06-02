// Members + invites for the active workspace. Owner/admin only.
// Shows current members with role dropdowns + remove, plus open
// invites with copy-link/revoke. A small form at the bottom mints
// a new invite link.

import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Plus, Trash2, X } from "lucide-react";
import {
  ApiError, api,
  type OrgMembership, type WorkspaceInvite, type WorkspaceMember,
} from "../lib/api";
import { Modal, useToast, useConfirm } from "@cobblr/platform-web";

interface Props {
  open: boolean;
  onClose: () => void;
  slug: string;
}

const ROLES: OrgMembership["role"][] = ["owner", "admin", "member", "guest"];
const INVITE_ROLES: OrgMembership["role"][] = ["admin", "member", "guest"];

export function MembersModal({ open, onClose, slug }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();

  const members = useQuery({
    queryKey: ["members", slug],
    queryFn: () => api.listMembers(slug),
    enabled: open && !!slug,
  });
  const invites = useQuery({
    queryKey: ["invites", slug],
    queryFn: () => api.listInvites(slug),
    enabled: open && !!slug,
  });

  const isAdminish =
    members.data?.self.role === "owner" || members.data?.self.role === "admin";

  // ── invite create form ────────────────────────────────────────
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<OrgMembership["role"]>("member");

  const createInvite = useMutation({
    mutationFn: () =>
      api.createInvite(slug, {
        email: inviteEmail.trim() || undefined,
        role: inviteRole,
      }),
    onSuccess: (inv) => {
      toast.success("Invite created. Copy the link to share.");
      void qc.invalidateQueries({ queryKey: ["invites", slug] });
      setInviteEmail("");
      // Auto-copy the new link for convenience.
      void copyInviteLink(inv);
    },
    onError: (e: unknown) => {
      toast.error(e instanceof ApiError ? e.message : "Couldn't create invite.");
    },
  });

  const revokeInvite = useMutation({
    mutationFn: (id: string) => api.revokeInvite(slug, id),
    onSuccess: () => {
      toast.info("Invite revoked.");
      void qc.invalidateQueries({ queryKey: ["invites", slug] });
    },
    onError: (e: unknown) => {
      toast.error(e instanceof ApiError ? e.message : "Couldn't revoke.");
    },
  });

  const updateRole = useMutation({
    mutationFn: (m: { userId: string; role: OrgMembership["role"] }) =>
      api.updateMemberRole(slug, m.userId, m.role),
    onSuccess: () => {
      toast.success("Role updated.");
      void qc.invalidateQueries({ queryKey: ["members", slug] });
    },
    onError: (e: unknown) => {
      toast.error(e instanceof ApiError ? e.message : "Couldn't change role.");
    },
  });

  const removeMember = useMutation({
    mutationFn: (userId: string) => api.removeMember(slug, userId),
    onSuccess: () => {
      toast.success("Member removed.");
      void qc.invalidateQueries({ queryKey: ["members", slug] });
    },
    onError: (e: unknown) => {
      toast.error(e instanceof ApiError ? e.message : "Couldn't remove.");
    },
  });

  async function copyInviteLink(inv: WorkspaceInvite) {
    const url = `${window.location.origin}/invite/${inv.token}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Invite link copied.");
    } catch {
      // Clipboard may be denied. Fall back to a prompt-style toast.
      toast.info(url, { duration: 12_000 });
    }
  }

  async function handleRemoveMember(m: WorkspaceMember) {
    const ok = await confirm({
      title: `Remove ${m.display_name}?`,
      message: `They'll lose access to ${slug}. They can be re-invited later.`,
      confirmLabel: "Remove",
      destructive: true,
    });
    if (ok) removeMember.mutate(m.user_id);
  }

  function submitInvite(e: FormEvent) {
    e.preventDefault();
    createInvite.mutate();
  }

  return (
    <Modal open={open} onClose={onClose} title="members" subtitle={slug} size="lg">
      <div className="space-y-5">
        {/* Members list */}
        <div>
          <div className="text-[10px] font-mono uppercase tracking-widest text-accent mb-2">
            // members ({members.data?.items.length ?? 0})
          </div>
          {members.isLoading && (
            <div className="text-xs text-faint">loading…</div>
          )}
          <ul className="divide-y divide-line dark:divide-slate-700">
            {members.data?.items.map((m) => {
              const isSelf = m.user_id === members.data?.self.user_id;
              return (
                <li key={m.user_id} className="py-2 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-content dark:text-mortar-100 truncate">
                      {m.display_name}
                      {isSelf && (
                        <span className="ml-2 text-[10px] font-mono uppercase tracking-widest text-faint">
                          you
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] font-mono text-faint dark:text-slate-500 truncate">
                      {m.email}
                    </div>
                  </div>
                  {isAdminish && !isSelf ? (
                    <select
                      value={m.role}
                      onChange={(e) =>
                        updateRole.mutate({
                          userId: m.user_id,
                          role: e.target.value as OrgMembership["role"],
                        })
                      }
                      className="input !w-auto !py-1 text-xs"
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400">
                      {m.role}
                    </span>
                  )}
                  {isAdminish && !isSelf && (
                    <button
                      onClick={() => handleRemoveMember(m)}
                      className="text-faint hover:text-ember-500 transition"
                      title="Remove member"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>

        {/* Open invites */}
        {isAdminish && (
          <div>
            <div className="text-[10px] font-mono uppercase tracking-widest text-accent mb-2">
              // open invites ({invites.data?.items.length ?? 0})
            </div>
            {invites.data?.items.length === 0 && (
              <div className="text-xs text-faint italic">
                No open invites.
              </div>
            )}
            <ul className="space-y-1.5">
              {invites.data?.items.map((inv) => {
                const expired =
                  inv.expires_at && new Date(inv.expires_at) < new Date();
                return (
                  <li
                    key={inv.id}
                    className="rounded-md border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-2 text-xs flex items-center gap-2"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2">
                        <span className="font-mono uppercase tracking-widest text-[10px] text-muted">
                          {inv.role}
                        </span>
                        {inv.invited_email && (
                          <span className="text-content dark:text-mortar-200 truncate">
                            {inv.invited_email}
                          </span>
                        )}
                        {expired && (
                          <span className="text-[10px] font-mono uppercase tracking-widest text-ember-500">
                            expired
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] font-mono text-faint dark:text-slate-500 mt-0.5">
                        token: …{inv.token.slice(-8)}{" "}
                        {inv.expires_at && (
                          <>
                            · expires {new Date(inv.expires_at).toLocaleDateString()}
                          </>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={() => copyInviteLink(inv)}
                      className="text-faint hover:text-accent transition"
                      title="Copy invite link"
                    >
                      <Copy size={12} />
                    </button>
                    <button
                      onClick={() => revokeInvite.mutate(inv.id)}
                      className="text-faint hover:text-ember-500 transition"
                      title="Revoke"
                    >
                      <X size={13} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {/* Create invite */}
        {isAdminish && (
          <form
            onSubmit={submitInvite}
            className="rounded-xl border border-line dark:border-slate-700 bg-subtle/40 dark:bg-slate-900 p-4 space-y-3"
          >
            <div className="text-[10px] font-mono uppercase tracking-widest text-accent">
              // invite someone
            </div>
            <div className="flex items-end gap-2">
              <label className="flex-1 block">
                <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
                  Email hint (optional)
                </span>
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="friend@example.com"
                  className="input"
                />
              </label>
              <label className="block">
                <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
                  Role
                </span>
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as OrgMembership["role"])}
                  className="input !w-auto"
                >
                  {INVITE_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="submit"
                disabled={createInvite.isPending}
                className="px-3 py-1.5 rounded-md text-sm font-medium bg-slate-700 hover:bg-slate-600 text-mortar-50 transition disabled:opacity-50 flex items-center gap-1"
              >
                <Plus size={13} /> Mint invite
              </button>
            </div>
            <p className="text-[10px] font-mono text-faint dark:text-slate-500">
              No email is sent — we don't have SMTP wired yet. Cobblr
              copies the link to your clipboard so you can send it
              however you want.
            </p>
          </form>
        )}

        {!isAdminish && (
          <p className="text-xs text-muted dark:text-slate-400">
            Only owners and admins can invite or change roles.
          </p>
        )}

        <div className="flex items-center justify-end pt-3 border-t border-line dark:border-slate-700">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-sm font-medium text-content dark:text-slate-300 hover:bg-subtle dark:hover:bg-slate-800 transition"
          >
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}
