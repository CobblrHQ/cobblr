// Members + invites for the active workspace. Owner/admin only.
// Shows current members with role dropdowns + remove, plus open
// invites with copy-link/revoke. A small form at the bottom mints
// a new invite link.

import { productName } from "@cobblr/platform-web";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Plus, Printer, Trash2, X } from "lucide-react";
import {
  ApiError, api,
  type OrgMembership, type WorkspaceInvite, type WorkspaceMember, type WorkspacePerson,
} from "../lib/api";
import { Modal, SegmentedChoice, printJoinSheet, useStillAsking, useToast, useConfirm, Code } from "@cobblr/platform-web";
import { displaySlug } from "../lib/workspaceSlug";
import { usePrefill } from "../lib/prefill";
import { MySignupInvites } from "./MySignupInvites";
import { useAuth } from "../auth/AuthContext";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { ORG_ROLES, INVITABLE_ORG_ROLES } from "@cobblr/platform-contract/org-roles";
import { withArticle } from "@cobblr/platform-contract/plural";

interface Props {
  /** Render in-flow (settings page mode) instead of as an overlay. */
  inline?: boolean;
  /** With `inline`, render as a plain PAGE body (no dialog chrome). */
  chromeless?: boolean;
  open: boolean;
  onClose: () => void;
  slug: string;
  /** Arrive with a particular part of this page as the subject. "invite"
   *  focuses and scrolls to the create-invite form, which is what a
   *  "+ Invite someone" entry point means — the list is still above it, so
   *  the invite you just made appears where you are already looking. */
  focus?: "invite";
}

// From the contract, not retyped. The two lists differ for a reason: ownership
// is transferred to somebody already here, never handed out through a link.
const ROLES = ORG_ROLES as readonly OrgMembership["role"][];
const INVITE_ROLES = INVITABLE_ORG_ROLES as readonly OrgMembership["role"][];

export function MembersModal({ open, onClose, slug, inline, chromeless, focus }: Props) {
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

  // role-gate: exact — managing members is governance; the server's
  // assertAdmin is exact for the same reason, and an editor is not in it.
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
  // The same read MySignupInvites makes, so the page can wait for it too.
  const { user } = useAuth();
  const signupInvites = useQuery({ queryKey: ["my-signup-invites", user?.id], queryFn: () => api.listMySignupInvites(), enabled: open });
  const asking = useStillAsking(members, invites, config, signupInvites);

  // ── invite create form ────────────────────────────────────────
  // Escort prefill (tier 1.5): Cobb can't invite anyone, but "invite Sam" walks
  // the user here with the form filled — pressing Send invite stays theirs.
  const prefill = usePrefill(["email", "role"]);
  const prefillRole = INVITE_ROLES.find((r) => r === prefill.role) ?? null;
  const [inviteEmail, setInviteEmail] = useState(prefill.email ?? "");
  const [inviteRole, setInviteRole] = useState<OrgMembership["role"]>(prefillRole ?? "member");
  // "workspace" = join THIS workspace as a member; "platform" = start their own
  // Cobblr (their own fresh workspace). The two are genuinely different invites.
  const [inviteKind, setInviteKind] = useState<"workspace" | "platform">("workspace");
  // Platform invite: optionally seed the invitee's brand-new workspace with a
  // copy of THIS workspace's setup (its blueprint — config only, no data).
  const [seedFromHere, setSeedFromHere] = useState(false);
  const inviteRef = useRef<HTMLInputElement>(null);
  // A join link: one link many people use, for a QR on a wall (#3801).
  const [joinLink, setJoinLink] = useState(false);
  const [maxUses, setMaxUses] = useState("");
  // Item labels may offer the join link to someone who scans one signed out.
  // Off unless asked: a label leaves the room with the thing it is stuck to.
  const [onLabels, setOnLabels] = useState(false);
  // A burst guard by default: at most 10 joins a day, then the link pauses
  // itself and the admins are told. No total cap, no end date.
  const [paceLimit, setPaceLimit] = useState("10");
  const [pacePeriod, setPacePeriod] = useState<"day" | "week" | "month" | "year">("day");
  const { activeOrg } = useActiveOrg();
  const workspaceName = activeOrg?.slug === slug && activeOrg.name ? activeOrg.name : displaySlug(slug);
  // The wall sheet names the role it joins as and its pace, in words (#6738).
  const sheetFor = (inv: WorkspaceInvite) => ({
    url: `${window.location.origin}/invite/${inv.token}`,
    workspace: workspaceName,
    role: inv.role,
    pace: inv.pace_limit && inv.pace_period ? { limit: inv.pace_limit, period: inv.pace_period } : null,
    then: "Then scan the label on anything you take, and press −1.",
  });
  useEffect(() => {
    if (!open || focus !== "invite") return;
    // After the lists paint, or the scroll lands on a shorter page than the
    // one that exists a tick later.
    const t = setTimeout(() => {
      inviteRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
      inviteRef.current?.focus();
    }, 120);
    return () => clearTimeout(t);
  }, [open, focus]);

  // A paused join link: turn it back on, or give it a new code so the old QR
  // (the one that got out) stops working, then print the new one.
  const resumeLink = useMutation({
    mutationFn: (id: string) => api.resumeJoinLink(slug, id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["invites", slug] });
      toast.success("Join link on again.");
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't resume it."),
  });
  const rotateLink = useMutation({
    mutationFn: (id: string) => api.rotateJoinLink(slug, id),
    onSuccess: async (inv) => {
      void qc.invalidateQueries({ queryKey: ["invites", slug] });
      const ok = await printJoinSheet(sheetFor(inv));
      toast.success(
        ok
          ? "New code made; the old QR no longer works. Print the new one and swap it on the wall."
          : "New code made; the old QR no longer works. Press Print QR to print the new one.",
      );
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't make a new code."),
  });

  const createInvite = useMutation({
    mutationFn: () =>
      api.createInvite(
        slug,
        joinLink
          ? {
              role: inviteRole,
              reusable: true,
              ...(Number(maxUses) > 0 ? { max_uses: Math.floor(Number(maxUses)) } : {}),
              ...(onLabels ? { offer_on_labels: true } : {}),
              pace: Number(paceLimit) > 0 ? { limit: Math.floor(Number(paceLimit)), period: pacePeriod } : null,
            }
          : { email: inviteEmail.trim() || undefined, role: inviteRole },
      ),
    onSuccess: (inv) => {
      if (inv.reusable) {
        void qc.invalidateQueries({ queryKey: ["invites", slug] });
        setMaxUses("");
        setOnLabels(false);
        void copyInviteLink(inv, true);
        toast.success("Join link made and copied. Print its QR from the list to put it on the wall.");
        return;
      }
      const sentTo = inviteEmail.trim();
      void qc.invalidateQueries({ queryKey: ["invites", slug] });
      setInviteEmail("");
      // Auto-copy the new link (silently — we surface one combined toast below).
      void copyInviteLink(inv, true);
      // Only claim a mail went out when one did. Same rule the "start their
      // own Cobblr" invite beside this already follows: an instance with no
      // mail sender must not tell an admin it emailed somebody, because then
      // nobody sends the link and the invite silently never arrives.
      toast.success(
        sentTo && inv.emailed
          ? `Invite sent to ${sentTo}. The link is copied too.`
          : sentTo
            ? `No email was sent from this instance. The link is copied, send it to ${sentTo}.`
            : "Invite link copied. Share it however you like.",
      );
    },
    onError: (e: unknown) => {
      toast.error(e instanceof ApiError ? e.message : "Couldn't create invite.");
    },
  });

  // Platform invite: mint a "start your own Cobblr" link (their own workspace),
  // attributed to this owner. Copies the /join link to the clipboard.
  const createSignupInvite = useMutation({
    mutationFn: () => api.mintMySignupInvite({ email: inviteEmail.trim() || undefined, ...(seedFromHere ? { from_workspace: slug } : {}) }),
    onSuccess: (inv) => {
      void qc.invalidateQueries({ queryKey: ["my-signup-invites"] });
      const sentTo = inviteEmail.trim();
      setInviteEmail("");
      const url = `${window.location.origin}/join/${inv.token}`;
      void navigator.clipboard?.writeText(url).catch(() => {});
      toast.success(
        sentTo && inv.emailed
          ? `Invite to start their own ${productName()} sent to ${sentTo}. Link copied too.`
          : `“Start their own ${productName()}” link copied. Share it however you like.`,
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

  // A member who owns things is asked who gets them (#3787): they stay the
  // leaver's, named "(left)", unless someone else is picked.
  const [leaving, setLeaving] = useState<{ member: WorkspaceMember; count: number; others: WorkspacePerson[] } | null>(null);
  const [handTo, setHandTo] = useState("");
  const removeWithHandOff = useMutation({
    mutationFn: (v: { userId: string; handTo: string | null }) => api.removeMember(slug, v.userId, v.handTo ?? undefined),
    onSuccess: (r, v) => {
      setLeaving(null);
      setHandTo("");
      void qc.invalidateQueries({ queryKey: ["members", slug] });
      void qc.invalidateQueries({ queryKey: ["platform-people", slug] });
      const moved = r && typeof r === "object" && "moved" in r ? (r as { moved: number; kept: unknown[] }) : null;
      toast.success(
        moved && v.handTo
          ? `Member removed. ${moved.moved} thing${moved.moved === 1 ? "" : "s"} handed on${moved.kept.length ? `; ${moved.kept.length} could not be and stay theirs` : ""}.`
          : "Member removed. What they own stays theirs.",
      );
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't remove."),
  });

  async function handleRemoveMember(m: WorkspaceMember) {
    try {
      const people = (await api.listPeople(slug)).items;
      const theirs = people.find((p) => p.user_id === m.user_id);
      const things = theirs ? await api.personThings(slug, theirs.id) : null;
      if (things && things.count > 0) {
        setHandTo("");
        setLeaving({ member: m, count: things.count, others: people.filter((p) => p.id !== theirs!.id && (p.member || !p.user_id)) });
        return;
      }
    } catch {
      /* quiet: no People list to ask, so remove the plain way */
    }
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
    <Modal open={open} onClose={onClose} title="Members" subtitle={displaySlug(slug)} size="lg" inline={inline} chromeless={chromeless}>
      {/* Drawn whole once its reads answer: drawn as each came, the invite
          sections arrived above Close and moved it 600 px under a finger
          (#7797). */}
      {asking ? <div className="text-xs text-faint">loading…</div> : (
      <div className="space-y-5">
        <MySignupInvites enabled={open} />
        {/* Members list */}
        <div>
          <div className="text-[10px] uppercase tracking-widest text-accent mb-2">
            members ({members.data?.items.length ?? 0})
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
                        <span className="ml-2 text-[10px] uppercase tracking-widest text-faint">
                          you
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] font-mono text-faint dark:text-slate-500 truncate">
                      {m.email}
                    </div>
                  </div>
                  {isAdminish && !isSelf ? (
                    <select aria-label="Role"
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
                    <span className="text-[10px] uppercase tracking-widest text-muted dark:text-slate-400">
                      {m.role}
                    </span>
                  )}
                  {isAdminish && !isSelf && (
                    <button
                      aria-label="Remove member"
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
            <div className="text-[10px] uppercase tracking-widest text-accent mb-2">
              open invites ({invites.data?.items.length ?? 0})
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
                    id={`invite-${inv.id}`}
                    className="rounded-md border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-2 text-xs flex items-center gap-2"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2">
                        <span className="uppercase tracking-widest text-[10px] text-muted">
                          {inv.role}
                        </span>
                        {inv.invited_email && (
                          <span className="text-content dark:text-mortar-200 truncate">
                            {inv.invited_email}
                          </span>
                        )}
                        {inv.reusable && (
                          <span className="text-content dark:text-mortar-200" data-testid="join-link-count">
                            join link · {inv.use_count ?? 0}
                            {inv.max_uses ? ` of ${inv.max_uses}` : ""} joined
{inv.pace_limit && inv.pace_period ? ` · at most ${inv.pace_limit} ${withArticle(inv.pace_period)}` : ""}
                            {inv.offer_on_labels ? " · labels offer it" : ""}
                          </span>
                        )}
                        {expired && (
                          <span className="text-[10px] uppercase tracking-widest text-ember-500">
                            expired
                          </span>
                        )}
                      </div>
                      {inv.reusable && (inv.joined?.length ?? 0) > 0 && (
                        <div className="text-[11px] text-muted dark:text-slate-400 mt-0.5 truncate" data-testid="join-link-joined">
                          {inv.joined!.slice(0, 4).map((j) => j.name).join(", ")}
                          {inv.joined!.length > 4 ? ` and ${inv.joined!.length - 4} more` : ""}
                        </div>
                      )}
                      <div className="text-[10px] text-faint dark:text-slate-500 mt-0.5">
                        token: <Code>…{inv.token.slice(-8)}</Code>{" "}
                        {inv.expires_at && (
                          <>
                            · expires {new Date(inv.expires_at).toLocaleDateString()}
                          </>
                        )}
                      </div>
                    </div>
                    {inv.reusable && inv.paused_at && (
                      <span className="flex flex-col items-end gap-1" data-testid="join-link-paused">
                        <span className="text-[10px] uppercase tracking-widest text-ember-500">paused</span>
                        <span className="flex gap-2">
                          <button
                            type="button"
                            className="text-[11px] text-accent hover:underline"
                            onClick={() => resumeLink.mutate(inv.id)}
                            data-testid="join-link-resume"
                          >
                            Resume
                          </button>
                          <button
                            type="button"
                            className="text-[11px] text-accent hover:underline"
                            onClick={() => rotateLink.mutate(inv.id)}
                            data-testid="join-link-rotate"
                          >
                            New code
                          </button>
                        </span>
                      </span>
                    )}
                    {inv.reusable && (
                      <button
                        onClick={async () => {
                          const ok = await printJoinSheet(sheetFor(inv));
                          if (!ok) toast.error("Your browser blocked the print window. Allow pop-ups for this site and press Print QR again.");
                        }}
                        className="text-faint hover:text-accent transition inline-flex items-center gap-1 min-h-8"
                        title="Print the wall QR"
                        data-testid="join-link-print"
                      >
                        <Printer size={12} /> <span className="text-[11px]">Print QR</span>
                      </button>
                    )}
                    <button
                      aria-label="Copy invite link"
                      onClick={() => copyInviteLink(inv)}
                      className="text-faint hover:text-accent transition"
                      title="Copy invite link"
                    >
                      <Copy size={12} />
                    </button>
                    <button
                      aria-label="Revoke"
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
            <div className="text-[10px] uppercase tracking-widest text-accent">
              invite someone
            </div>

            {/* Two genuinely different invites. Owners get both (when self-serve
                invites are open); admins can only add people to THIS workspace. */}
            {canInviteToPlatform && (
              <SegmentedChoice
                label="What the invite is for"
                value={inviteKind}
                onChange={setInviteKind}
                options={[
                  { value: "workspace", label: "Join this workspace" },
                  { value: "platform", label: `Start their own ${productName()}` },
                ]}
              />
            )}

            {inviteKind === "workspace" && (
              <label className="flex items-start gap-2 text-xs text-content dark:text-mortar-200 cursor-pointer">
                <input type="checkbox" checked={joinLink} onChange={(e) => setJoinLink(e.target.checked)} className="mt-0.5" data-testid="join-link-toggle" />
                <span>
                  <span className="font-medium">A join link for a wall QR.</span> Anyone who scans it can join as a{" "}
                  {inviteRole}, as many people as you like. You see everyone who joins, and can remove them or revoke the
                  link.
                </span>
              </label>
            )}
            {inviteKind === "workspace" && joinLink && (
              <label className="flex items-start gap-2 text-xs text-content dark:text-mortar-200 cursor-pointer pl-5">
                <input type="checkbox" checked={onLabels} onChange={(e) => setOnLabels(e.target.checked)} className="mt-0.5" data-testid="join-link-on-labels" />
                <span>
                  <span className="font-medium">Item labels offer it too.</span> Someone who scans a label here
                  without an account is asked to join before they take one. Leave off if labels leave the room with
                  the things they are on.
                </span>
              </label>
            )}
            <div className="flex flex-col sm:flex-row sm:items-end gap-2">
              {inviteKind === "workspace" && joinLink ? (
              <>
              <label className="flex-1 block min-w-0">
                <span className="block text-[10px] uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
                  At most, then pause
                </span>
                <span className="flex gap-1">
                  <input
                    type="number"
                    min={1}
                    value={paceLimit}
                    onChange={(e) => setPaceLimit(e.target.value)}
                    placeholder="no pace"
                    className="input w-20"
                    aria-label="Joins allowed"
                    data-testid="join-link-pace"
                  />
                  <select value={pacePeriod} onChange={(e) => setPacePeriod(e.target.value as typeof pacePeriod)} className="input flex-1" aria-label="Per">
                    <option value="day">a day</option>
                    <option value="week">a week</option>
                    <option value="month">a month</option>
                    <option value="year">a year</option>
                  </select>
                </span>
              </label>
              <label className="flex-1 block min-w-0">
                <span className="block text-[10px] uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
                  Stop after (optional)
                </span>
                <input
                  type="number"
                  min={1}
                  value={maxUses}
                  onChange={(e) => setMaxUses(e.target.value)}
                  placeholder="no limit"
                  className="input"
                />
              </label>
              </>
              ) : (
              <label className="flex-1 block min-w-0">
                <span className="block text-[10px] uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
                  Email {inviteKind === "platform" ? "(optional)" : "hint (optional)"}
                </span>
                <input
                  ref={inviteRef}
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="friend@example.com"
                  className="input"
                />
              </label>
              )}
              {inviteKind === "workspace" && (
                <label className="block">
                  <span className="block text-[10px] uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
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
                <Plus size={13} /> {inviteKind === "platform" ? `Invite to ${productName()}` : joinLink ? "Make join link" : "Mint invite"}
              </button>
            </div>

            {/* What this invite actually does — the part that was confusing. */}
            {inviteKind === "workspace" ? (
              <p className="text-[11px] text-faint dark:text-slate-500 leading-relaxed">
                They join <span className="font-semibold text-muted dark:text-slate-400">{displaySlug(slug)}</span> as a{" "}
                <span className="font-semibold text-muted dark:text-slate-400">{inviteRole}</span>. New to {productName()}?
                Accepting creates their account - they become a member <span className="font-semibold">here</span>,
                they don't get a workspace of their own. We email the link if you add an address (and notify them
                in-app if they already have an account); it's copied to your clipboard either way.
              </p>
            ) : (
              <>
                <label className="flex items-start gap-2 text-xs text-content dark:text-mortar-200 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={seedFromHere}
                    onChange={(e) => setSeedFromHere(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-medium">Send them a premade workspace</span>  - seed their new workspace with a
                    copy of <span className="font-semibold">{displaySlug(slug)}</span>'s setup (modules, bundles, fields,
                    views - <span className="font-semibold">no data</span>). Configure this workspace for them first,
                    then mint.
                  </span>
                </label>
                <p className="text-[11px] text-faint dark:text-slate-500 leading-relaxed">
                  They get their <span className="font-semibold">own</span> brand-new {productName()} workspace - they are{" "}
                  <span className="font-semibold">not</span> added to {displaySlug(slug)}. Best for inviting a friend to
                  try {productName()}. We email the join link if you add an address; it's copied to your clipboard too.
                </p>
              </>
            )}
          </form>
        )}

        {!isAdminish && (
          <p className="text-xs text-muted dark:text-slate-400">
            Only owners and admins can invite or change roles.
          </p>
        )}

        {leaving && (
          <Modal open onClose={() => setLeaving(null)} title={`Remove ${leaving.member.display_name}?`}>
            <div className="space-y-3 text-sm" data-testid="remove-hand-off">
              <p className="text-content dark:text-mortar-200">
                They'll lose access to {displaySlug(slug)}. {leaving.member.display_name} owns{" "}
                <strong>
                  {leaving.count} thing{leaving.count === 1 ? "" : "s"}
                </strong>{" "}
                here.
              </p>
              <label className="block">
                <span className="block text-[10px] uppercase tracking-widest text-faint mb-1">Their things go to</span>
                <select value={handTo} onChange={(e) => setHandTo(e.target.value)} className="input w-full" data-testid="hand-off-to">
                  <option value="">Keep them as {leaving.member.display_name}'s</option>
                  {leaving.others.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex justify-end gap-2 pt-1">
                <button type="button" onClick={() => setLeaving(null)} className="rounded-md border border-line dark:border-slate-700 text-content dark:text-mortar-200 hover:bg-subtle dark:hover:bg-slate-800 text-sm px-3 py-1.5 transition disabled:opacity-50">
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={removeWithHandOff.isPending}
                  onClick={() => removeWithHandOff.mutate({ userId: leaving.member.user_id, handTo: handTo || null })}
                  className="rounded-md bg-ember-500 hover:bg-ember-600 text-white text-sm font-medium px-3 py-1.5 transition disabled:opacity-50"
                  data-testid="hand-off-remove"
                >
                  {handTo ? "Hand on and remove" : "Remove"}
                </button>
              </div>
            </div>
          </Modal>
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
      )}
    </Modal>
  );
}
