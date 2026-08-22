// /configuration/links — manage cross-workspace data sharing.
//
// Lists active + pending links involving the current user. Lets them
// initiate a new link from one of their owned workspaces to another
// (or to a workspace they're invited to). Accept/revoke per row.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, Clock, Plus, X } from "lucide-react";
import { ApiError, api, type WorkspaceLinkItem } from "../lib/api";
import { Modal, useToast, useConfirm, usePageTitle } from "@cobblr/platform-web";
import { ConfigHeaderActions } from "../components/ConfigPageHeader";

export function LinksPage() {
  usePageTitle("Workspace links");
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [createOpen, setCreateOpen] = useState(false);

  const list = useQuery({
    queryKey: ["workspace-links"],
    queryFn: () => api.listWorkspaceLinks(),
  });

  const accept = useMutation({
    mutationFn: (id: string) => api.acceptWorkspaceLink(id),
    onSuccess: () => {
      toast.success("Link accepted");
      void qc.invalidateQueries({ queryKey: ["workspace-links"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeWorkspaceLink(id),
    onSuccess: () => {
      toast.success("Link revoked");
      void qc.invalidateQueries({ queryKey: ["workspace-links"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const items = list.data?.items ?? [];
  const active = items.filter((l) => l.status === "active");
  const pending = items.filter((l) => l.status === "pending");
  const past = items.filter((l) => l.status === "revoked");

  return (
    <div className="space-y-6">
      <ConfigHeaderActions>
        <span className="text-sm text-muted dark:text-slate-400">
          {active.length} active · {pending.length} pending
        </span>
        <button
          onClick={() => setCreateOpen(true)}
          className="inline-flex items-center gap-2 rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm transition"
        >
          <Plus size={14} /> New link
        </button>
      </ConfigHeaderActions>

      <p className="text-sm text-muted dark:text-slate-400">
        A link grants read access from a <em>source</em> workspace to a{" "}
        <em>target</em> workspace for selected entity kinds. Reads union
        with the target's own data - items get a{" "}
        <code className="font-mono text-xs">_source_workspace_slug</code>{" "}
        marker. Source remains the source of truth; nothing writes
        across. <strong>Same user as both owners → auto-accepted.</strong>
      </p>

      {pending.length > 0 && (
        <Section title="Pending acceptance">
          {pending.map((l) => (
            <LinkRow
              key={l.id}
              link={l}
              actions={
                <>
                  {l.target_role === "owner" && (
                    <button
                      onClick={() => accept.mutate(l.id)}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-emerald-600 hover:bg-emerald-700 text-white"
                    >
                      <Check size={12} /> Accept
                    </button>
                  )}
                  <button
                    onClick={async () => {
                      const ok = await confirm({
                        title: "Revoke this link?",
                        message: `${l.source_org_name} → ${l.target_org_name}`,
                        confirmLabel: "Revoke",
                        destructive: true,
                      });
                      if (ok) revoke.mutate(l.id);
                    }}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs text-muted hover:text-ember-500"
                  >
                    <X size={12} /> Revoke
                  </button>
                </>
              }
            />
          ))}
        </Section>
      )}

      <Section title="Active">
        {active.length === 0 ? (
          <p className="text-sm text-muted italic">
            No active links. Click "New link" to share data from one
            workspace to another.
          </p>
        ) : (
          active.map((l) => (
            <LinkRow
              key={l.id}
              link={l}
              actions={
                <button
                  onClick={async () => {
                    const ok = await confirm({
                      title: "Revoke this link?",
                      message: `${l.source_org_name} → ${l.target_org_name}. The target will immediately stop seeing the source's data.`,
                      confirmLabel: "Revoke",
                      destructive: true,
                    });
                    if (ok) revoke.mutate(l.id);
                  }}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs text-muted hover:text-ember-500"
                >
                  <X size={12} /> Revoke
                </button>
              }
            />
          ))
        )}
      </Section>

      {past.length > 0 && (
        <Section title="Past (revoked)">
          {past.map((l) => (
            <LinkRow key={l.id} link={l} dim />
          ))}
        </Section>
      )}

      {createOpen && (
        <CreateLinkModal
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            void qc.invalidateQueries({ queryKey: ["workspace-links"] });
            setCreateOpen(false);
          }}
        />
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium text-content dark:text-slate-300">{title}</h2>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function LinkRow({
  link,
  actions,
  dim,
}: {
  link: WorkspaceLinkItem;
  actions?: React.ReactNode;
  dim?: boolean;
}) {
  const [editExpiryOpen, setEditExpiryOpen] = useState(false);
  // Either-side owners can edit expiry. revoked links can't.
  const canEdit =
    (link.source_role === "owner" || link.target_role === "owner") &&
    link.status !== "revoked";
  return (
    <div
      className={`flex items-center gap-3 px-3 py-2 text-sm border border-line dark:border-slate-700 rounded ${
        dim ? "opacity-50" : ""
      }`}
    >
      <span className="font-medium truncate">{link.source_org_name}</span>
      <ArrowRight size={14} className="text-faint shrink-0" />
      <span className="font-medium truncate">{link.target_org_name}</span>
      <div className="flex flex-wrap gap-1 ml-2">
        {link.kinds.map((k) => (
          <span
            key={k}
            className="px-1.5 py-0.5 rounded text-[10px] font-mono text-muted bg-subtle dark:bg-slate-800"
          >
            {k}
          </span>
        ))}
      </div>
      <ExpiryBadge expiresAt={link.expires_at} />
      {link.min_target_role && (
        <span
          className="px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider text-accent bg-cobble-50 dark:text-cobble-300 dark:bg-cobble-900/30"
          title={`Only target-side ${link.min_target_role}s+ can read this share`}
        >
          {link.min_target_role}+
        </span>
      )}
      {canEdit && (
        <button
          onClick={() => setEditExpiryOpen(true)}
          className="text-faint hover:text-accent transition"
          title="Edit expiry"
        >
          <Clock size={12} />
        </button>
      )}
      <div className="flex-1" />
      {actions}
      {editExpiryOpen && (
        <EditExpiryModal link={link} onClose={() => setEditExpiryOpen(false)} />
      )}
    </div>
  );
}

function EditExpiryModal({
  link,
  onClose,
}: {
  link: WorkspaceLinkItem;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  // Pre-populate from current expiry (Date input wants YYYY-MM-DD).
  const current = link.expires_at
    ? new Date(link.expires_at).toISOString().slice(0, 10)
    : "";
  const [dateStr, setDateStr] = useState(current);
  const [busy, setBusy] = useState(false);
  async function save(clear: boolean) {
    setBusy(true);
    try {
      let expires_at: string | null = null;
      if (!clear) {
        if (!dateStr) {
          toast.error("Pick a date or use Never.");
          setBusy(false);
          return;
        }
        // End-of-day local time on the chosen date.
        const d = new Date(dateStr + "T23:59:59");
        expires_at = d.toISOString();
      }
      await api.patchWorkspaceLink(link.id, { expires_at });
      toast.success(clear ? "Expiry cleared" : "Expiry updated");
      void qc.invalidateQueries({ queryKey: ["workspace-links"] });
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open onClose={onClose} title="Edit link expiry">
      <div className="space-y-3">
        <label className="block">
          <div className="text-xs text-muted mb-1">Expires on</div>
          <input
            type="date"
            value={dateStr}
            onChange={(e) => setDateStr(e.target.value)}
            min={new Date().toISOString().slice(0, 10)}
            className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
          />
          <div className="text-[11px] text-faint mt-1">
            Local time, end-of-day. Cross-workspace reads stop honouring
            the link the moment it expires.
          </div>
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void save(true)}
            disabled={busy}
            className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800 disabled:opacity-50"
          >
            Never expire
          </button>
          <button
            type="button"
            onClick={() => void save(false)}
            disabled={busy || !dateStr}
            className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white"
          >
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ExpiryBadge({ expiresAt }: { expiresAt: string | null }) {
  if (!expiresAt) return null;
  const t = new Date(expiresAt).getTime();
  const now = Date.now();
  const expired = t <= now;
  const days = Math.round((t - now) / (1000 * 60 * 60 * 24));
  if (expired) {
    return (
      <span className="px-1.5 py-0.5 rounded text-[10px] font-mono text-ember-700 dark:text-ember-400 bg-ember-50 dark:bg-ember-900/20">
        expired
      </span>
    );
  }
  return (
    <span
      className="px-1.5 py-0.5 rounded text-[10px] font-mono text-muted bg-subtle dark:bg-slate-800"
      title={new Date(expiresAt).toLocaleString()}
    >
      expires in {days}d
    </span>
  );
}

function CreateLinkModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [sourceOrg, setSourceOrg] = useState("");
  const [targetOrg, setTargetOrg] = useState("");
  const [kindsRaw, setKindsRaw] = useState("inventory:part");
  const [expiryDays, setExpiryDays] = useState("");
  const [minRole, setMinRole] = useState<"" | "guest" | "member" | "admin" | "owner">("");
  const toast = useToast();

  const orgs = useQuery({
    queryKey: ["my-orgs"],
    queryFn: () => api.listOrgs(),
  });
  const kinds = useQuery({
    queryKey: ["entity-kinds", sourceOrg],
    queryFn: () => api.listEntityKinds(orgs.data!.items.find((o) => o.id === sourceOrg)!.slug),
    enabled: !!sourceOrg && !!orgs.data,
  });

  const orgList = orgs.data?.items ?? [];

  return (
    <Modal open onClose={onClose} title="New workspace link">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!sourceOrg || !targetOrg) return;
          const kindsArr = kindsRaw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          if (kindsArr.length === 0) return;
          let expires_at: string | null = null;
          const days = Number(expiryDays);
          if (expiryDays.trim() !== "" && Number.isFinite(days) && days > 0) {
            const d = new Date();
            d.setDate(d.getDate() + days);
            expires_at = d.toISOString();
          }
          try {
            await api.createWorkspaceLink({
              source_org_id: sourceOrg,
              target_org_id: targetOrg,
              kinds: kindsArr,
              expires_at,
              min_target_role: minRole || null,
            });
            toast.success("Link created");
            onCreated();
          } catch (err) {
            toast.error(err instanceof ApiError ? err.message : String(err));
          }
        }}
        className="space-y-3"
      >
        <label className="block">
          <div className="text-xs text-muted mb-1">Share FROM (source)</div>
          <select
            value={sourceOrg}
            onChange={(e) => setSourceOrg(e.target.value)}
            className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
          >
            <option value=""> - pick a workspace - </option>
            {orgList.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name} ({o.role})
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <div className="text-xs text-muted mb-1">Share INTO (target)</div>
          <select
            value={targetOrg}
            onChange={(e) => setTargetOrg(e.target.value)}
            className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
          >
            <option value=""> - pick a workspace - </option>
            {orgList
              .filter((o) => o.id !== sourceOrg)
              .map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name} ({o.role})
                </option>
              ))}
          </select>
        </label>
        <label className="block">
          <div className="text-xs text-muted mb-1">
            Entity kinds (comma-separated)
          </div>
          <input
            type="text"
            value={kindsRaw}
            onChange={(e) => setKindsRaw(e.target.value)}
            placeholder="inventory:part, core-tags:tag"
            className="w-full px-2 py-1 text-sm font-mono border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
          />
          {kinds.data?.items && (
            <div className="text-xs text-faint mt-1">
              Available in source:{" "}
              {kinds.data.items.map((k) => k.id).join(", ")}
            </div>
          )}
        </label>
        <label className="block">
          <div className="text-xs text-muted mb-1">
            Restrict to target-side role (optional)
          </div>
          <select
            value={minRole}
            onChange={(e) => setMinRole(e.target.value as typeof minRole)}
            className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
          >
            <option value="">no restriction - every target member can read</option>
            <option value="guest">guest or higher</option>
            <option value="member">member or higher</option>
            <option value="admin">admin or higher</option>
            <option value="owner">owner only</option>
          </select>
          <div className="text-[11px] text-faint mt-1">
            Only target-workspace members whose role meets-or-exceeds
            this threshold will see the share. Default no restriction.
          </div>
        </label>
        <label className="block">
          <div className="text-xs text-muted mb-1">
            Expires after (days, optional)
          </div>
          <input
            type="number"
            min="1"
            step="1"
            value={expiryDays}
            onChange={(e) => setExpiryDays(e.target.value)}
            placeholder="leave blank to never expire"
            className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
          />
          <div className="text-[11px] text-faint mt-1">
            Cross-workspace reads stop honouring the link the moment it
            expires - no scheduled sweep required.
          </div>
        </label>
        <div className="text-xs text-muted dark:text-slate-400 bg-subtle dark:bg-slate-800/40 rounded p-2">
          <strong>Auto-accept:</strong> if you own both workspaces the
          link flips to active immediately. Otherwise it waits for the
          target's owner to accept.
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!sourceOrg || !targetOrg || kindsRaw.trim().length === 0}
            className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white"
          >
            Create link
          </button>
        </div>
      </form>
    </Modal>
  );
}
