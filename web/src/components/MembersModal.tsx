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
import { displaySlug } from "../lib/workspaceSlug";

interface Props {
  open: boolean;
  onClose: () => void;
  slug: string;
}

const ROLES: OrgMembership["role"][] = ["owner", "admin", "editor", "member", "guest"];
const INVITE_ROLES: OrgMembership["role"][] = ["admin", "editor", "member", "guest"];

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
  // Only an OWNER can invite a brand-new person who gets their OWN workspace
  // (the platform-signup path); admins can still invite into THIS workspace.
  const isOwner = members.data?.self.role === "owner";
  // The "start their own Cobblr" path is the uncontrolled-growth lever, so it's
  // off by default during alpha (server flag). Hide the option unless it's open.
  const config = useQuery({
    queryKey: ["auth-config"],
    queryFn: () => api.authConfig(),
    staleTime: 5 * 60_000,
  });
  const canInviteToPlatform = isOwner && config.data?.self_serve_invites === true;

  // ── invite create form ────────────────────────────────────────
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<OrgMembership["role"]>("member");
  // "workspace" = join THIS workspace as a member; "platform" = start their own
  // Cobblr (their own fresh workspace). The two are genuinely different invites.
  const [inviteKind, setInviteKind] = useState<"workspace" | "platform">("workspace");

  const createInvite = useMutation({
    mutationFn: () =>
      api.createInvite(slug, {
        email: inviteEmail.trim() || undefined,
        role: inviteRole,
      }),
    onSuccess: (inv) => {
      const sentTo = inviteEmail.trim();
      void qc.invalidateQueries({ queryKey: ["invites", slug] });
      setInviteEmail("");
      // Auto-copy the new link (silently — we surface one combined toast below).
      void copyInviteLink(inv, true);
      toast.success(
        sentTo
          ? `Invite sent to ${sentTo} — link copied too.`
          : "Invite link copied — share it however you like.",
      );
    },
    onError: (e: unknown) => {
      toast.error(e instanceof ApiError ? e.message : "Couldn't create invite.");
    },
  });

  // Platform invite: mint a "start your own Cobblr" link (their own workspace),
  // attributed to this owner. Copies the /join link to the clipboard.
  const createSignupInvite = useMutation({
    mutationFn: () => api.mintMySignupInvite({ email: inviteEmail.trim() || undefined }),
    onSuccess: (inv) => {
      const sentTo = inviteEmail.trim();
      setInviteEmail("");
      const url = `${window.location.origin}/join/${inv.token}`;
      void navigator.clipboard?.writeText(url).catch(() => {});
      toast.success(
        sentTo && inv.emailed
          ? `Invite to start their own Cobblr sent to ${sentTo} — link copied too.`
          : "“Start their own Cobblr” link copied — share it however you like.",
      );
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

  async function copyInviteLink(inv: WorkspaceInvite, silent = false) {
    const url = `${window.location.origin}/invite/${inv.token}`;
    try {
      await navigator.clipboard.writeText(url);
      if (!silent) toast.success("Invite link copied.");
    } catch {
      // Clipboard may be denied. Fall back to a prompt-style toast.
      toast.info(url, { duration: 12_000 });
    }
  }

  async function handleRemoveMember(m: WorkspaceMember) {
    const ok = await confirm({
      title: `Remove ${m.display_name}?`,
      message: `They'll lose access to ${displaySlug(slug)}. They can be re-invited later.`,
      confirmLabel: "Remove",
      destructive: true,
    });
    if (ok) removeMember.mutate(m.user_id);
  }

  function submitInvite(e: FormEvent) {
    e.preventDefault();
    if (inviteKind === "platform") createSignupInvite.mutate();
    else createInvite.mutate();
  }

  return (
    <Modal open={open} onClose={onClose} title="Members" subtitle={displaySlug(slug)} size="lg">
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

            {/* Two genuinely different invites. Owners get both (when self-serve
                invites are open); admins can only add people to THIS workspace. */}
            {canInviteToPlatform && (
              <div className="inline-flex rounded-lg border border-line dark:border-slate-700 p-0.5 text-xs">
                {([
                  ["workspace", "Join this workspace"],
                  ["platform", "Start their own Cobblr"],
                ] as const).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setInviteKind(k)}
                    className={
                      "px-3 py-1.5 rounded-md font-medium transition " +
                      (inviteKind === k
                        ? "bg-cobble-600 text-white"
                        : "text-content dark:text-slate-300 hover:bg-subtle dark:hover:bg-slate-800")
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}

            <div className="flex flex-col sm:flex-row sm:items-end gap-2">
              <label className="flex-1 block min-w-0">
                <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
                  Email {inviteKind === "platform" ? "(optional)" : "hint (optional)"}
                </span>
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="friend@example.com"
                  className="input"
                />
              </label>
              {inviteKind === "workspace" && (
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
              )}
              <button
                type="submit"
                disabled={createInvite.isPending || createSignupInvite.isPending}
                className="px-3 py-1.5 rounded-md text-sm font-medium bg-slate-700 hover:bg-slate-600 text-mortar-50 transition disabled:opacity-50 flex items-center gap-1"
              >
                <Plus size={13} /> {inviteKind === "platform" ? "Invite to Cobblr" : "Mint invite"}
              </button>
            </div>

            {/* What this invite actually does — the part that was confusing. */}
            {inviteKind === "workspace" ? (
              <p className="text-[11px] text-faint dark:text-slate-500 leading-relaxed">
                They join <span className="font-semibold text-muted dark:text-slate-400">{displaySlug(slug)}</span> as a{" "}
                <span className="font-semibold text-muted dark:text-slate-400">{inviteRole}</span>. New to Cobblr?
                Accepting creates their account — they become a member <span className="font-semibold">here</span>,
                they don't get a workspace of their own. We email the link if you add an address (and notify them
                in-app if they already have an account); it's copied to your clipboard either way.
              </p>
            ) : (
              <p className="text-[11px] text-faint dark:text-slate-500 leading-relaxed">
                They get their <span className="font-semibold">own</span> brand-new Cobblr workspace — they are{" "}
                <span className="font-semibold">not</span> added to {displaySlug(slug)}. Best for inviting a friend to
                try Cobblr. We email the join link if you add an address; it's copied to your clipboard too.
              </p>
            )}
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
