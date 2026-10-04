// A record's history, as a contributed panel on every record: who changed it,
// what, and when, read from the activity log the record's module already
// writes.
//
// An edit says what it changed (#4517): one person's edits within half an
// hour are one group, a line per field under its label, old → new, each value
// in words (the api says them, history-describe.ts); a photo change names the
// record and where the picture came from, and its detail card holds the file's
// name, size and stored path, which never sit on the line itself. Anything
// cut short can be read in full: hover on a desk, tap on a phone.

import { useState, type PointerEvent, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { History, Loader2 } from "lucide-react";
import { EntityPhoto, relativeTime, useImageSrc } from "@cobblr/platform-web";
import { api, type ActivityEntry, type ShownPhoto, type ShownValue } from "../../lib/api";
import { activityVerb, documentWords, partWords, updatedFieldsWords } from "../../lib/activity-words";
import { groupHistory, GROUP_SHOWN, type HistoryLine } from "../../lib/history-groups";
import { ActorVia, ACTIVITY_ROW, ACTOR_CELL } from "../../components/ActorVia";
import { useActiveOrg } from "../../auth/ActiveOrgContext";
import { FEED_SCROLL } from "../../lib/feed";
import type { EntityDetailPanelCtx } from "../../panels/types";

const FIRST = 10;

/** "<name> photo from the web": the record, and where the picture came from. */
export function photoWords(name: string, photo: ShownPhoto | undefined): string {
  switch (photo?.source?.kind) {
    case "web":
      return `${name} photo from the web`;
    case "ai_pick":
      return `${name} photo chosen by AI Pick`;
    case "catalog":
      return `${name} catalog photo`;
    case "camera":
      return `${name} photo from a camera scan`;
    case "upload":
      return `${name} photo you uploaded`;
    default:
      return `${name} photo`;
  }
}

const sizeWords = (bytes: number) => (bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`);
const siteOf = (photo: ShownPhoto) => {
  const at = photo.source?.source_page || photo.source?.original_url;
  if (!at) return null;
  try {
    return new URL(at.includes("://") ? at : `https://${at}`).hostname.replace(/^www\./, "");
  } catch {
    return at;
  }
};

function Thumb({ photo, size = 28 }: { photo: ShownPhoto; size?: number }) {
  const src = useImageSrc(photo.thumb);
  return <EntityPhoto src={src} alt={photo.filename} size={size} className="shrink-0 rounded" />;
}

/** The photo's card: what the line leaves out, for the curious. */
function PhotoCard({ photo, who, at }: { photo: ShownPhoto; who: ReactNode; at: string }) {
  const site = siteOf(photo);
  return (
    <div data-testid="history-photo-card" className="mt-1.5 flex gap-2 rounded-lg border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800 p-2 text-xs text-muted dark:text-slate-400">
      <Thumb photo={photo} size={64} />
      <dl className="min-w-0 space-y-0.5">
        {site && (
          <div>
            <dt className="sr-only">From</dt>
            <dd className="truncate">From {site}</dd>
          </div>
        )}
        <div>
          <dt className="sr-only">File</dt>
          <dd className="truncate text-content dark:text-mortar-200">{photo.filename}</dd>
        </div>
        <div>
          <dt className="sr-only">Size</dt>
          <dd>
            {sizeWords(photo.size_bytes)}
            {photo.width && photo.height ? ` · ${photo.width} × ${photo.height}` : ""}
          </dd>
        </div>
        <div>
          <dt className="sr-only">Changed</dt>
          <dd>
            {who} · {new Date(at).toLocaleString()}
          </dd>
        </div>
        <div>
          <dt className="sr-only">Stored at</dt>
          <dd>
            <code className="select-all break-all font-mono text-[10px] text-faint">{photo.path}</code>
          </dd>
        </div>
      </dl>
    </div>
  );
}

/** A value in words; "(empty)" for nothing. Long ones are cut, and readable in full. */
function Value({ v }: { v: ShownValue }) {
  if (v.text === null) return <span className="italic text-faint">(empty)</span>;
  return <span title={v.text}>{v.text}</span>;
}

/** One changed field: "Paid: (empty) → $4,300", or the photo line. */
function ChangeLine({ line, name, who, compact }: { line: HistoryLine; name: string; who: ReactNode; compact?: boolean }) {
  // Tap (a phone) or hover (a desk) shows what is cut short, and a photo's
  // card. Hover is a mouse's only: a tap also sends a mouse-enter, which would
  // open the card for the click to close again.
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const photo = line.to.photo ?? line.from?.photo;
  const isPhoto = line.field === "image_path" || !!line.to.photo || !!line.from?.photo;
  const open = pinned || hovered;
  const props = {
    onClick: () => setPinned((o) => !o),
    onPointerEnter: (e: PointerEvent) => isPhoto && e.pointerType === "mouse" && setHovered(true),
    onPointerLeave: () => setHovered(false),
    "aria-expanded": open,
  };
  const body = isPhoto ? (
    <>
      <span className={open ? "whitespace-normal" : "truncate"}>{line.to.text === null ? `Removed the ${name} photo` : photoWords(name, line.to.photo)}</span>
    </>
  ) : (
    <span className={"min-w-0 " + (open ? "whitespace-normal break-words" : "truncate")}>
      <span className="text-content dark:text-mortar-200">{line.label}</span>
      {": "}
      {line.from !== undefined && (
        <>
          <Value v={line.from} /> {"→ "}
        </>
      )}
      <Value v={line.to} />
    </span>
  );
  return (
    <div data-testid="history-change">
      <button type="button" {...props} className={`flex w-full min-w-0 items-center gap-1.5 text-left ${compact ? "" : "text-sm"}`}>
        {body}
      </button>
      {open && photo && <PhotoCard photo={photo} who={who} at={line.at} />}
    </div>
  );
}

/** What one entry changed or recorded, a line per field in words: the same
 *  lines the History panel shows, for the Activity page's details. */
export function SaidList({ entry, name }: { entry: ActivityEntry; name: string }) {
  const said = entry.said ?? [];
  if (said.length === 0) return null;
  const who = <ActorVia entry={entry} />;
  return (
    <ul data-testid="activity-said" className="mt-1 space-y-0.5 text-xs text-muted dark:text-slate-400">
      {said.map((c) => (
        <li key={c.field}>
          <ChangeLine line={{ ...c, at: entry.occurred_at }} name={name} who={who} compact />
        </li>
      ))}
    </ul>
  );
}

export function HistoryPanel({ ctx }: { ctx: EntityDetailPanelCtx }) {
  const { activeSlug } = useActiveOrg();
  const client = useQueryClient();
  const [restoring, setRestoring] = useState<ActivityEntry | null>(null);
  const restore = useMutation({
    mutationFn: (entry: ActivityEntry) => api.restoreHistoryVersion(activeSlug, entry.id, { kind: ctx.kind ?? "", entity_id: ctx.entityId, expected_latest_id: Number(q.data?.items[0]?.id ?? entry.id) }),
    onSuccess: async () => { setRestoring(null); await client.invalidateQueries(); },
  });
  const [limit, setLimit] = useState(FIRST);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const q = useQuery({
    queryKey: ["record-history", activeSlug, ctx.kind, ctx.entityId, limit],
    queryFn: () => api.listActivity(activeSlug, { entity: { kind: ctx.kind ?? "", id: ctx.entityId }, limit: limit + 1 }),
    enabled: !!activeSlug && !!ctx.kind && !!ctx.entityId,
  });
  // What this kind calls the things inside it ("Parts"): a part installed or
  // taken out is said in that word.
  const word = useQuery({
    queryKey: ["contents-word", activeSlug, ctx.kind],
    queryFn: () => api.contentsWord(activeSlug, ctx.kind ?? ""),
    enabled: !!activeSlug && !!ctx.kind,
    staleTime: 60_000,
  });
  const entries = (q.data?.items ?? []).slice(0, limit);
  const more = (q.data?.items.length ?? 0) > limit;
  const items = groupHistory(entries);
  const name = (e: ActivityEntry) => e.entity_title || ctx.entityTitle || "Its";
  const time = (at: string, muted = false) => (
    <span className={`ml-auto shrink-0 font-mono text-[10px] ${muted ? "text-faint/80" : "text-faint"}`} title={new Date(at).toLocaleString()}>
      {relativeTime(at)}
    </span>
  );
  const versions = (rows: ActivityEntry[]) => rows.some((e) => e.restorable) ? (
    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">
      {rows.filter((e) => e.restorable).map((e) => (
        <button key={e.id} type="button" onClick={() => { restore.reset(); setRestoring(e); }} disabled={restore.isPending} className="text-accent hover:underline" aria-label={`Restore this version from ${new Date(e.occurred_at).toLocaleString()}`}>
          Restore this version{rows.length > 1 ? ` · ${new Date(e.occurred_at).toLocaleTimeString()}` : ""}
        </button>
      ))}
    </div>
  ) : null;
  return (
    <div data-testid="record-history" className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-3">
      <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-widest text-accent">
        <History size={12} aria-hidden /> {"// history"}
      </div>
      {restoring && (
        <div className="rounded-lg border border-line dark:border-slate-700 p-3 space-y-2 text-sm">
          <p>Restore the values from before this edit? Later edits will be replaced. The restoration will appear in history so you can undo it.</p>
          <div className="flex flex-wrap gap-3">
            <button type="button" disabled={restore.isPending} onClick={() => restore.mutate(restoring)} className="text-accent hover:underline">{restore.isPending ? "Restoring…" : "Restore values"}</button>
            <button type="button" disabled={restore.isPending} onClick={() => setRestoring(null)} className="text-muted hover:underline">Cancel</button>
          </div>
        </div>
      )}
      {restore.isError && <p role="alert" className="text-sm text-ember-600 dark:text-ember-400">{(restore.error as Error).message}</p>}
      {q.isLoading ? (
        <Loader2 size={14} className="animate-spin text-faint" />
      ) : q.isError ? (
        <p className="text-sm text-ember-600 dark:text-ember-400">Could not read this record's history: {(q.error as Error).message}</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted dark:text-slate-400">Nothing recorded yet. Changes to this record will show here.</p>
      ) : (
        <ul className={"space-y-1.5 " + FEED_SCROLL}>
          {items.map((it) => {
            if (it.kind === "event") {
              const e = it.entry;
              const part = partWords(e.action, e.diff, word.data?.word ?? null);
              const fields = part ? part.what : e.action.endsWith("updated") ? updatedFieldsWords(e.said) : documentWords(e);
              return (
                <li key={it.key} data-testid="history-entry" className="text-sm">
                  <div className={ACTIVITY_ROW}>
                  <span className={`text-muted dark:text-slate-400 ${ACTOR_CELL}`}>
                    <ActorVia entry={e} />
                  </span>
                  <span className="text-content dark:text-mortar-200">{part ? part.verb : activityVerb(e.action)}</span>
                  {fields ? (
                    <span className="text-muted dark:text-slate-400 truncate min-w-0" title={fields}>
                      {fields}
                    </span>
                  ) : null}
                  {time(e.occurred_at)}
                  </div>
                  {versions([e])}
                </li>
              );
            }
            const who = <ActorVia entry={it.head} />;
            const one = it.lines.length === 1 ? it.lines[0]! : null;
            if (one) {
              // A single change stays a single line: "<name> updated Paid: $4,300".
              return (
                <li key={it.key} data-testid="history-entry" className="text-sm">
                  <div className={ACTIVITY_ROW}>
                    <span className={`text-muted dark:text-slate-400 ${ACTOR_CELL}`}>{who}</span>
                    <span className="text-content dark:text-mortar-200 shrink-0">updated</span>
                    <span className="min-w-0 flex-1 text-muted dark:text-slate-400">
                      <ChangeLine line={one} name={name(it.head)} who={who} />
                    </span>
                    {time(one.at)}
                  </div>
                  {versions(it.entries)}
                </li>
              );
            }
            const open = expanded.has(it.key);
            const shown = open ? it.lines : it.lines.slice(0, GROUP_SHOWN);
            return (
              <li key={it.key} data-testid="history-entry" className="text-sm">
                <div className={ACTIVITY_ROW}>
                  <span className={`text-muted dark:text-slate-400 ${ACTOR_CELL}`}>{who}</span>
                  <span className="text-content dark:text-mortar-200">updated</span>
                  {time(it.startedAt)}
                </div>
                <ul className="mt-0.5 space-y-0.5 pl-4 text-xs text-muted dark:text-slate-400">
                  {shown.map((l) => (
                    <li key={l.field} className="flex items-start gap-2">
                      <span className="min-w-0 flex-1">
                        <ChangeLine line={l} name={name(it.head)} who={who} compact />
                      </span>
                      {time(l.at, true)}
                    </li>
                  ))}
                </ul>
                {versions(it.entries)}
                {it.lines.length > GROUP_SHOWN && (
                  <button
                    type="button"
                    onClick={() => setExpanded((s) => (s.has(it.key) ? new Set([...s].filter((k) => k !== it.key)) : new Set(s).add(it.key)))}
                    className="mt-0.5 pl-4 text-xs text-accent hover:underline"
                  >
                    {open ? "Show fewer" : `+${it.lines.length - GROUP_SHOWN} more`}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {more ? (
        <button type="button" onClick={() => setLimit((n) => n + 20)} className="text-xs text-accent hover:underline">
          Show earlier
        </button>
      ) : null}
    </div>
  );
}
