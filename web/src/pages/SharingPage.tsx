// Settings → Sharing: who this workspace is shared with, and how each share
// is syncing (docs/design-decisions/share-spaces.md).
//
// In your own workspace: share with someone (their email, or a link to send),
// each share's person, where their Cobblr is, when it last synced and what is
// waiting, Sync now, and End. In a share space (someone shared with you): who
// shared it, how it is syncing, and Leave.

import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownLeft, ArrowUpRight, Plus, RefreshCw, Share2 } from "lucide-react";
import { Modal, relativeTime, useConfirm, usePageTitle, useToast } from "@cobblr/platform-web";
import { api, type ShareLinkItem, type ShareOfferItem } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { ConfigHeaderActions } from "../components/ConfigPageHeader";
import { ShareWhatEditor } from "./ShareWhatEditor";
import { ShareEditsList } from "./ShareEditsList";
import { InviteForm } from "../components/ShareInviteForm";
import { PublicPagesSection } from "./PublicPagesSection";

export function SharingPage() {
  usePageTitle("Sharing");
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<ShareLinkItem | null>(null);
  const [reviewing, setReviewing] = useState<ShareLinkItem | null>(null);
  const key = ["share-links", activeSlug];
  const list = useQuery({ queryKey: key, queryFn: () => api.listShareLinks(activeSlug), enabled: !!activeSlug });

  const sync = useMutation({
    mutationFn: (id: string) => api.syncShareLink(activeSlug, id),
    onSuccess: (r) => {
      if (r.error) toast.error(r.error);
      else toast.success(r.sent ? `Sent ${r.sent} change${r.sent === 1 ? "" : "s"}.` : "Up to date.");
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const end = useMutation({
    mutationFn: (id: string) => api.revokeShareLink(activeSlug, id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const inShare = list.data?.kind === "share";
  const items = list.data?.items ?? [];

  if (inShare) {
    const l = items[0];
    return (
      <div className="space-y-4" data-testid="sharing-page">
        <p className="text-sm text-muted dark:text-slate-400">
          This workspace holds what someone shared with you. What you change here and what you offer them goes back to them.
        </p>
        {l ? (
          <ShareRow
            link={l}
            onSync={() => sync.mutate(l.id)}
            syncing={sync.isPending}
            endLabel="Leave"
            onEnd={async () => {
              const ok = await confirm({
                title: "Leave this share?",
                message: `This workspace and everything in it is removed for you. ${l.peer_name ?? "The person who shared it"} keeps their own things.`,
                confirmLabel: "Leave",
                destructive: true,
              });
              if (ok) {
                await end.mutateAsync(l.id);
                window.location.assign("/");
              }
            }}
          />
        ) : (
          <p className="text-sm text-muted">This share has ended.</p>
        )}
        <HandedOver slug={activeSlug} />
      </div>
    );
  }

  const live = items.filter((l) => l.status === "active");
  const pending = items.filter((l) => l.status === "pending");
  return (
    <div className="space-y-6" data-testid="sharing-page">
      <ConfigHeaderActions>
        <button
          type="button"
          data-testid="share-with"
          onClick={() => setInviting(true)}
          className="inline-flex items-center gap-2 rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm transition"
        >
          <Plus size={14} /> Share with someone
        </button>
      </ConfigHeaderActions>
      {list.isLoading ? null : live.length + pending.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line dark:border-slate-600 p-6 text-center text-sm text-muted">
          <Share2 size={20} className="mx-auto mb-2 text-faint" aria-hidden />
          Not shared with anyone yet.
        </div>
      ) : (
        <div className="space-y-2">
          {[...pending, ...live].map((l) => (
            <ShareRow
              key={l.id}
              link={l}
              onWhat={() => setEditing(l)}
              onEdits={() => setReviewing(l)}
              onSync={() => sync.mutate(l.id)}
              syncing={sync.isPending}
              endLabel={l.status === "pending" ? "Withdraw invite" : "End share"}
              onEnd={async () => {
                const ok = await confirm({
                  title: l.status === "pending" ? "Withdraw this invite?" : "End this share?",
                  message:
                    l.status === "pending"
                      ? "The link stops working."
                      : `${l.peer_name ?? "They"} lose the shared workspace and everything in it. Your own things stay as they are.`,
                  confirmLabel: l.status === "pending" ? "Withdraw" : "End share",
                  destructive: true,
                });
                if (ok) end.mutate(l.id);
              }}
            />
          ))}
        </div>
      )}
      {live.some((l) => l.edits_waiting) ? (
        <Link to="/suggestions" data-testid="sharing-review-all" className="inline-flex items-center gap-1 text-sm text-accent hover:underline">
          Review every suggested edit ({live.reduce((n, l) => n + (l.edits_waiting ?? 0), 0)})
        </Link>
      ) : null}
      <HandedOver slug={activeSlug} />
      <PublicPagesSection slug={activeSlug} />
      <Modal open={!!editing} onClose={() => setEditing(null)} title={`What ${editing?.peer_name ?? editing?.label ?? "they"} can see`} size="md">
        {editing && <ShareWhatEditor slug={activeSlug} linkId={editing.id} who={editing.peer_name ?? editing.label ?? "they"} onDone={() => setEditing(null)} />}
      </Modal>
      <Modal open={!!reviewing} onClose={() => setReviewing(null)} title={`${reviewing?.peer_name ?? reviewing?.label ?? "Their"}'s edits`} size="md">
        {reviewing && <ShareEditsList slug={activeSlug} linkId={reviewing.id} who={reviewing.peer_name ?? reviewing.label ?? "They"} />}
      </Modal>
      <Modal open={inviting} onClose={() => setInviting(false)} title="Share with someone" size="md">
        {inviting && <InviteForm slug={activeSlug} onDone={() => void qc.invalidateQueries({ queryKey: key })} />}
      </Modal>
    </div>
  );
}

function ShareRow({ link, onSync, syncing, onEnd, endLabel, onWhat, onEdits }: { link: ShareLinkItem; onSync: () => void; syncing: boolean; onEnd: () => void; endLabel: string; onWhat?: () => void; onEdits?: () => void }) {
  const made = `Link made ${new Date(link.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  const who = link.side === "share" ? (link.peer_name ? `Shared by ${link.peer_name}` : "Shared with you") : (link.peer_name ?? link.invite_email ?? link.label ?? (link.status === "pending" ? made : "Someone"));
  const where = link.peer_host ? `on ${link.peer_host}` : "on this Cobblr";
  return (
    <div data-testid="share-row" className="rounded-lg border border-line bg-surface p-3 dark:border-slate-600 space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-content">{who}</span>
        {link.status === "active" && <span className="text-xs text-muted">{where}</span>}
        <span className="ml-auto flex flex-wrap gap-2">
          {onWhat && link.status === "active" && link.side === "owner" && (
            <button type="button" onClick={onWhat} data-testid="share-what-open" className="inline-flex items-center gap-1 rounded border border-line px-2 py-1 text-xs text-muted hover:text-accent hover:border-accent dark:border-slate-600">
              What's shared
            </button>
          )}
          {link.status === "active" && link.side === "owner" && <ViewAsButton link={link} />}
          {onEdits && link.status === "active" && link.side === "owner" && (
            <button type="button" onClick={onEdits} data-testid="share-edits-open" className="inline-flex items-center gap-1 rounded border border-line px-2 py-1 text-xs text-muted hover:text-accent hover:border-accent dark:border-slate-600">
              Their edits
              {link.edits_waiting ? <span className="rounded-full bg-cobble-600 px-1.5 text-[10px] font-semibold text-white" data-testid="share-edits-waiting">{link.edits_waiting}</span> : null}
            </button>
          )}
          {link.status === "active" && (
            <button type="button" onClick={onSync} disabled={syncing} data-testid="share-sync" className="inline-flex items-center gap-1 rounded border border-line px-2 py-1 text-xs text-muted hover:text-accent hover:border-accent dark:border-slate-600">
              <RefreshCw size={12} aria-hidden /> Sync now
            </button>
          )}
          <button type="button" onClick={onEnd} className="rounded border border-line px-2 py-1 text-xs text-muted hover:text-ember-600 hover:border-ember-400 dark:border-slate-600">
            {endLabel}
          </button>
        </span>
      </div>
      <p className="text-xs text-muted" data-testid="share-status">
        {link.status === "pending"
          ? `${link.invite_email ? "Invited, not accepted yet" : link.label ? "Invite link, not used yet" : "Not used yet; anyone with the link can use it"}${link.invite_expires_at ? ` · expires ${relativeTime(link.invite_expires_at)}` : ""}`
          : `${link.last_synced_at ? `Last synced ${relativeTime(link.last_synced_at)}` : "Not synced yet"}${link.waiting ? ` · ${link.waiting} change${link.waiting === 1 ? "" : "s"} waiting` : ""}${link.side === "owner" ? (link.edit_mode === "direct" ? " · their edits apply at once" : " · you review their edits") : ""}`}
      </p>
      {link.side === "share" && link.last_viewed && (
        <p className="text-xs text-muted" data-testid="share-last-viewed">
          {link.last_viewed.by ?? "The person who shared this"} last looked at it as you {relativeTime(link.last_viewed.at)}, read-only.
        </p>
      )}
      {link.status === "active" && link.last_error && <p className="text-xs text-ember-600 dark:text-ember-400">{link.last_error}. It will keep trying.</p>}
    </div>
  );
}

/** "View as Vince": the share space as they see it, read-only, in a new tab. */
function ViewAsButton({ link }: { link: ShareLinkItem }) {
  const { activeSlug } = useActiveOrg();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      data-testid="share-view-as"
      onClick={async () => {
        setBusy(true);
        // Opened before the request, or a browser blocks a tab opened after a wait.
        const tab = window.open("", "_blank");
        try {
          const r = await api.viewShareAs(activeSlug, link.id);
          const url = new URL(r.url, window.location.origin).href;
          if (tab) tab.location.href = url;
          else window.location.href = url;
        } catch (e) {
          tab?.close();
          toast.error((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
      className="inline-flex items-center gap-1 rounded border border-line px-2 py-1 text-xs text-muted hover:text-accent hover:border-accent dark:border-slate-600 disabled:opacity-50"
    >
      View as {link.peer_name ?? "them"}
    </button>
  );
}


const STATE_WORDS: Record<ShareOfferItem["status"], string> = {
  offered: "offered",
  maybe: "maybe later",
  taken: "taken",
  passed: "passed",
  withdrawn: "withdrawn",
  returned: "sent back",
};

/** What has been handed over through these shares, both ways. */
function HandedOver({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const list = useQuery({ queryKey: ["share-offers", slug], queryFn: () => api.listShareOffers(slug), enabled: !!slug });
  const act = useMutation({
    mutationFn: ({ id, what }: { id: string; what: "withdraw" | "send-back" | "undo" }) => (what === "undo" ? api.undoSend(slug, id) : what === "withdraw" ? api.withdrawShareOffer(slug, id) : api.sendBackShareOffer(slug, id)),
    onSuccess: (_r, v) => {
      toast.success(v.what === "undo" ? "Send undone." : v.what === "withdraw" ? "Withdrawn." : "Sent back.");
      void qc.invalidateQueries();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const items = list.data?.items ?? [];
  return (
    <section className="space-y-2" data-testid="handed-over">
      <h2 className="text-sm font-semibold text-content">Handed over</h2>
      {items.length === 0 ? (
        <p className="text-sm text-muted">Nothing yet. On a thing's page, Give to… offers it; what is offered to you arrives in your scan inbox.</p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface dark:divide-slate-700 dark:border-slate-600">
          {items.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm" data-testid="handed-over-row">
              {o.direction === "out" ? <ArrowUpRight size={14} className="text-muted" aria-label="given" /> : <ArrowDownLeft size={14} className="text-muted" aria-label="received" />}
              <span className="min-w-0 flex-1 truncate text-content">{o.title}</span>
              <span className="text-xs text-muted">
                {o.direction === "out" ? "to" : "from"} {o.peer_name ?? "them"} · {o.send_file?.state === "exported" ? "downloaded, source kept" : o.send_mode && o.status === "taken" ? (o.send_mode === "copy" ? "copied" : "sent") : STATE_WORDS[o.status]} · {relativeTime(o.taken_at ?? o.created_at)}
              </span>
              {o.send_file?.can_download && <button type="button" className="rounded border border-line px-2 py-1 text-xs" onClick={async () => {try {if (o.send_file!.transport === "file-export") await api.downloadSendFile(slug,o.send_file!.id); else await api.downloadSendFileReceipt(slug,o.send_file!.id,o.send_file!.state === "undone" ? "undone" : "imported");} catch (e) {toast.error((e as Error).message);}}}>Download {o.send_file.transport === "file-export" ? "send file" : o.send_file.state === "undone" ? "return file" : "confirmation"}</button>}
              {o.send_file?.can_undo && <button type="button" className="rounded border border-line px-2 py-1 text-xs" onClick={async () => {try {const r = await api.undoSendFileImport(slug,o.send_file!.id);toast.success(r.summary);void qc.invalidateQueries();} catch (e) {toast.error((e as Error).message);}}}>Undo import here</button>}
              {o.can_undo && <button type="button" disabled={act.isPending} onClick={() => act.mutate({ id: o.id, what: "undo" })} className="rounded border border-line px-2 py-1 text-xs">Undo send</button>}
              {o.can_withdraw && (
                <button type="button" onClick={() => act.mutate({ id: o.id, what: "withdraw" })} disabled={act.isPending} className="rounded border border-line px-2 py-1 text-xs text-muted hover:text-accent dark:border-slate-600">
                  Withdraw
                </button>
              )}
              {o.can_send_back && (
                <button
                  type="button"
                  data-testid="send-back"
                  disabled={act.isPending}
                  onClick={async () => {
                    const ok = await confirm({
                      title: `Send ${o.title} back?`,
                      message: `It goes back to ${o.peer_name ?? "them"} as it was. If you already filed it, your record is marked given back.`,
                      confirmLabel: "Send back",
                    });
                    if (ok) act.mutate({ id: o.id, what: "send-back" });
                  }}
                  className="rounded border border-line px-2 py-1 text-xs text-muted hover:text-accent dark:border-slate-600"
                >
                  Send back
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
