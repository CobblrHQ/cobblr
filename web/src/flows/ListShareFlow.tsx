// The share page (#5365): a list's, a selection's and a record's Share all
// open this one page. Everything is on it at once, in order: what is shared,
// who it already reaches, adding someone (a person it is shared with, or
// someone new by email), and the result in place. No steps, no toggles; on a
// phone it is the whole screen, on a desktop a wide panel in two columns.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal, relativeTime, usePlatformWeb, useRunAction } from "@cobblr/platform-web";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import { listInviteScope } from "@cobblr/platform-contract/share-scope";
import { api } from "../lib/api";
import { InviteForm } from "../components/ShareInviteForm";

const heading = "text-[10px] font-mono uppercase tracking-widest text-accent";

export function ListShareFlow({ args, onClose }: { args: Record<string, unknown>; onClose: () => void }) {
  const { orgSlug, role } = usePlatformWeb();
  const kind = String(args.kind ?? "");
  const ids = Array.isArray(args.ids) ? args.ids.filter((id): id is string => typeof id === "string") : [];
  const title = String(args.title ?? "this list");
  const qc = useQueryClient();
  // PRESS-ARGS: the page chooses who; the opener supplies this collection and its selected records.
  const run = useRunAction();
  const manager = roleSatisfies(role, ["owner", "admin"]);
  const [whole, setWhole] = useState(ids.length === 0);
  const picks = whole ? [] : ids;
  const oneRecord = picks.length === 1 ? picks[0] : undefined;
  const list = useQuery({ queryKey: ["record-shares", orgSlug, kind, oneRecord ?? ""], queryFn: () => api.recordShares(orgSlug, kind, oneRecord) });
  const preview = useQuery({ queryKey: ["share-scope-preview", orgSlug, kind, picks], queryFn: () => api.previewScope(orgSlug, listInviteScope(kind, picks)), enabled: manager && !!kind });
  const invites = useQuery({ queryKey: ["share-links", orgSlug], queryFn: () => api.listShareLinks(orgSlug), enabled: manager });
  const [withPerson, setWithPerson] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const targets = list.data?.targets ?? [];
  // Several picked records: who holds each differs, so none is listed as "shared with" the lot.
  const sharedWith = whole || oneRecord ? (list.data?.shared_with ?? []) : [];
  const others = targets.filter((t) => !sharedWith.some((s) => s.link_id === t.link_id));
  const chosen = others.find((t) => t.link_id === withPerson) ?? others[0];
  const pending = (invites.data?.items ?? []).filter((l) => l.status === "pending" && l.side === "owner" && (l.invite_kinds ?? []).includes(kind));
  const act = async (who: string, stop = false) => {
    setBusy(true); setError(null); setMessage(null);
    try {
      const r = await run({ actionId: stop ? "platform:stop-sharing" : "platform:share-with", entityKind: kind, entityId: ids[0] ?? "", args: { entity_kind: kind, with: who, ...(picks.length ? { ids: picks } : { collection: true }) } });
      const result = r.result as { ok?: boolean; error?: string; summary?: string } | null;
      if (!result?.ok) throw new Error(result?.error ?? "That did not go through.");
      setMessage(result.summary ?? "Shared.");
      await qc.invalidateQueries({ queryKey: ["record-shares", orgSlug] });
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  if (list.data?.can_share === false && !(picks.length && targets.length)) return null;
  if (!manager && !(picks.length && targets.length)) return null;
  const scope = picks.length ? (picks.length === 1 ? `This record only${args.title ? `, from ${title}` : ""}.` : `${picks.length} selected from ${title}. Only these records are shared.`) : `${title}: every current and future record in this list. Existing exclusions stay in place.`;
  const sample = preview.data?.sample ?? [];
  const more = (preview.data?.count ?? 0) - sample.length;
  return <Modal open onClose={onClose} title={picks.length ? (picks.length === 1 ? "Share this record" : `Share the ${picks.length} selected`) : `Share ${title}`} size="content">
    <div className="grid gap-6 lg:grid-cols-2" data-testid="list-share-sheet">
      <div className="space-y-5">
        <section className="space-y-2" aria-labelledby="share-what">
          <h3 id="share-what" className={heading}>What's shared</h3>
          <p className="text-sm text-content" data-testid="list-share-scope">{scope}</p>
          {preview.data && <p className="text-xs text-muted" data-testid="list-share-preview">{preview.data.count === 0 ? "Nothing in it yet." : `${preview.data.count} ${preview.data.count === 1 ? "record" : "records"}${sample.length ? `: ${sample.slice(0, 3).map((s) => s.title).join(", ")}${more > 0 ? ` and ${more} more` : ""}` : ""}.`}</p>}
          {ids.length > 0 && manager && <button type="button" onClick={() => setWhole(!whole)} data-testid="list-share-change-scope" className="text-sm text-accent hover:underline">{whole ? (ids.length === 1 ? "Share only this record instead" : `Share only the ${ids.length} selected instead`) : `Share all of ${title} instead`}</button>}
        </section>
        <section className="space-y-2" aria-labelledby="share-now">
          <h3 id="share-now" className={heading}>Shared with now</h3>
          {sharedWith.length + pending.length === 0 && <p className="text-sm text-muted">Nobody yet.</p>}
          {sharedWith.map((t) => <div key={t.link_id} className="flex flex-wrap items-center justify-between gap-2 text-sm text-content"><span>{t.to}</span><button type="button" disabled={busy} onClick={() => void act(t.link_id, true)} className="min-h-11 text-muted hover:underline">Stop sharing</button></div>)}
          {pending.map((l) => <div key={l.id} className="text-sm text-content" data-testid="list-share-pending"><span>{l.invite_email ?? `Link made ${new Date(l.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`}</span> <span className="text-muted">{l.invite_email ? "invited, not accepted yet" : "not used yet"}{l.invite_expires_at ? ` · expires ${relativeTime(l.invite_expires_at)}` : ""}</span></div>)}
          {sharedWith.length > 0 && whole && <p className="text-xs text-muted">Stop sharing removes the whole-list rule. Records shared individually or by another rule stay shared.</p>}
        </section>
      </div>
      <section className="space-y-4" aria-labelledby="share-add">
        <h3 id="share-add" className={heading}>Add someone</h3>
        {list.error && <p className="text-sm text-ember-600 dark:text-ember-400">{(list.error as Error).message}</p>}
        {others.length > 0 && chosen && <div className="space-y-2">
          <label className="block space-y-1"><span className="text-sm text-content">Someone it's shared with</span><select aria-label="Share with" value={chosen.link_id} onChange={(e) => setWithPerson(e.target.value)} className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-base text-content sm:text-sm dark:border-slate-600">{others.map((t) => <option key={t.link_id} value={t.link_id}>{t.to}</option>)}</select></label>
          <button type="button" disabled={busy} onClick={() => void act(chosen.link_id)} data-testid="list-share-send" className="rounded-lg bg-cobble-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-60">{busy ? "Sharing…" : `Share with ${chosen.to}`}</button>
        </div>}
        {error && <p role="alert" className="text-sm text-ember-600 dark:text-ember-400">{error}</p>}
        {message && <p role="status" className="text-sm text-content">{message}</p>}
        {manager && list.data?.can_share !== false && <div className="space-y-2" data-testid="list-share-invite">
          {others.length > 0 && <p className="text-sm font-medium text-content">Or invite someone new</p>}
          <InviteForm slug={orgSlug} collection={{ kind, ...(picks.length ? { ids: picks } : {}) }} onDone={() => void qc.invalidateQueries({ queryKey: ["share-links", orgSlug] })} />
        </div>}
      </section>
    </div>
  </Modal>;
}
