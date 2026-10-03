// A public page as a stranger sees it (#4502; docs/design-decisions/share-scope.md):
// the records its scope selects, each with only what this link shows, as a
// gallery or a table. A record opens in place by the page's own ref; nothing
// on the page is a workspace id.

import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { EntityThumb, EntityTile, TILE_GRID } from "@cobblr/platform-web";
import type { AppTheme } from "../lib/api";
import { adminHtmlVars } from "../lib/appTheme";

export interface PublicRecord {
  ref: string;
  title: string;
  photo: string | null;
  place: string | null;
  fields: Array<{ name?: string; label: string; value: unknown }>;
}

/** What a public page says around a record. */
export interface PublicFrame {
  contact?: string | null;
  public_until?: string | null;
  footer?: boolean;
  about?: string | null;
  links?: Array<{ label: string; url: string }>;
  skin?: boolean;
  /** Search engines may list it; otherwise the page says noindex. */
  indexable?: boolean;
  /** The workspace's brand, with the page's own accent over it. */
  theme?: AppTheme | null;
}

/** Search engines are told not to list a public page unless its owner said
 *  they may: a page is for whoever holds its link. */
export function useNoIndex(indexable: boolean | undefined) {
  useEffect(() => {
    if (indexable) return;
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex";
    meta.setAttribute("data-public-page", "");
    document.head.appendChild(meta);
    return () => meta.remove();
  }, [indexable]);
}

/** A public page in its owner's brand: the workspace's colours (and the
 *  page's own accent) over the semantic tokens, light, so the brand owns
 *  the palette. Unbranded, it is Cobblr's own look. */
export function PublicBrand({ frame, className, children, testId }: { frame: PublicFrame | null | undefined; className?: string; children: ReactNode; testId?: string }) {
  useNoIndex(frame?.indexable);
  const vars = adminHtmlVars(frame?.theme ?? null);
  const branded = !!vars;
  // The brand owns the palette, so the visitor's dark shade variants would
  // fight it: light while it is shown, put back after.
  useEffect(() => {
    const el = document.documentElement;
    if (!branded || !el.classList.contains("dark")) return;
    el.classList.remove("dark");
    return () => el.classList.add("dark");
  }, [branded]);
  return (
    <div className={`${vars ? "bg-canvas text-content" : ""} ${className ?? ""}`} style={vars ?? undefined} data-testid={testId} data-branded={vars ? "" : undefined}>
      {frame?.theme?.logo && (
        // EXTERNAL-IMAGE-OK: the workspace brand's logo, a data: image or an https address its owner set (publicTheme drops anything else).
        <img src={frame.theme.logo} alt="" className="mx-auto mb-3 h-10 w-auto object-contain" data-testid="public-brand-logo" />
      )}
      {children}
    </div>
  );
}

const shown = (v: unknown) => (typeof v === "boolean" ? (v ? "Yes" : "No") : String(v));

export function PublicPageView({ token, layout, items }: { token: string; layout: string; items: PublicRecord[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (open) return <PublicRecordDetail token={token} refId={open} onBack={() => setOpen(null)} />;
  if (items.length === 0) return <div className="py-12 text-center text-sm italic text-muted">Nothing here yet.</div>;
  if (layout === "table") {
    return (
      <ul className="divide-y divide-line rounded-xl border border-line bg-surface dark:divide-slate-800 dark:border-slate-700 dark:bg-slate-900" data-testid="public-page-items">
        {items.map((i) => (
          <li key={i.ref}>
            <button type="button" onClick={() => setOpen(i.ref)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-subtle" data-testid="public-page-item">
              <EntityThumb src={i.photo} alt={i.title} size={48} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-content dark:text-mortar-100">{i.title}</span>
                {i.fields.length > 0 && <span className="block truncate text-xs text-muted">{i.fields.slice(0, 3).map((f) => `${f.label}: ${shown(f.value)}`).join(" · ")}</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className={TILE_GRID} data-testid="public-page-items">
      {items.map((i) => (
        <button key={i.ref} type="button" onClick={() => setOpen(i.ref)} className="text-left" data-testid="public-page-item">
          <EntityTile src={i.photo} title={i.title} subtitle={i.place} />
        </button>
      ))}
    </div>
  );
}

function PublicRecordDetail({ token, refId, onBack }: { token: string; refId: string; onBack: () => void }) {
  const q = useQuery({
    queryKey: ["public-record", token, refId],
    queryFn: async () => {
      const res = await fetch(`/api/v1/public/${token}/records/${encodeURIComponent(refId)}`);
      if (!res.ok) throw new Error(res.status === 410 ? "This link has expired." : "That is not here any more.");
      return (await res.json()) as { record: PublicRecord; page: PublicFrame };
    },
    retry: false,
  });
  return (
    <div className="mx-auto max-w-3xl space-y-4" data-testid="public-record">
      <button type="button" onClick={onBack} className="text-sm text-accent hover:underline">
        ← All of them
      </button>
      {q.isLoading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : q.error ? (
        <p className="text-sm text-muted">{(q.error as Error).message}</p>
      ) : q.data ? (
        <PublicRecordCard record={q.data.record} frame={q.data.page} skinFrom={`/api/v1/public/${token}/records/${encodeURIComponent(refId)}?skin=1`} />
      ) : null}
    </div>
  );
}

/** One record as a stranger sees it: its photo, name, place and the fields
 *  this page or label shows, a way to get in touch when the owner gave one,
 *  until when it is public (booth mode), and the footer unless turned off. */
export function PublicRecordCard({ record, frame, skinFrom }: { record: PublicRecord; frame?: PublicFrame; skinFrom?: string }) {
  const contact = frame?.contact;
  const publicUntil = frame?.public_until;
  const footer = frame?.footer;
  if (frame?.skin && skinFrom) return <PublicSkin from={skinFrom} footer={footer} />;
  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-xl border border-line bg-surface dark:border-slate-700 dark:bg-slate-900">
        {record.photo && (
          <div className="flex aspect-video items-center justify-center bg-subtle dark:bg-slate-800">
            <EntityThumb src={record.photo} alt={record.title} size={512} className="!h-full !w-full" />
          </div>
        )}
        <div className="space-y-3 p-6">
          <div className="flex flex-wrap items-baseline gap-2">
            <h2 className="page-title mr-auto font-display text-2xl font-extrabold text-content dark:text-mortar-100">{record.title}</h2>
            {publicUntil && (
              <span className="rounded-full border border-line px-2 py-0.5 text-xs text-muted dark:border-slate-600" data-testid="public-until">
                public until {new Date(publicUntil).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}
              </span>
            )}
          </div>
          {record.place && <p className="text-sm text-muted">{record.place}</p>}
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
            {record.fields.map((f) => (
              <div key={f.label}>
                <dt className="text-[11px] uppercase tracking-wide text-faint">{f.label}</dt>
                <dd className="break-words text-sm text-content dark:text-mortar-100" data-testid="public-record-field">
                  {shown(f.value)}
                </dd>
              </div>
            ))}
          </dl>
          {frame?.about && <p className="whitespace-pre-line text-sm text-content" data-testid="public-about">{frame.about}</p>}
          {(!!contact || (frame?.links?.length ?? 0) > 0) && (
            <div className="flex flex-wrap gap-2">
              {contact && (
                <a href={contact} rel="noopener noreferrer" target="_blank" className="inline-flex items-center rounded-lg bg-cobble-600 px-3 py-2 text-sm font-medium text-white" data-testid="public-contact">
                  Get in touch
                </a>
              )}
              {(frame?.links ?? []).map((l) => (
                <a key={l.url} href={l.url} rel="noopener noreferrer" target="_blank" className="inline-flex items-center rounded-lg border border-line px-3 py-2 text-sm text-content hover:border-accent dark:border-slate-600" data-testid="public-link-out">
                  {l.label}
                </a>
              ))}
            </div>
          )}
        </div>
      </div>
      {footer !== false && (
        <p className="text-center text-xs text-faint" data-testid="public-footer">
          Made with Cobblr
        </p>
      )}
    </div>
  );
}

/** The page's own look (Tier B): the owner's HTML in a sandboxed document
 *  with no network, handed only the record as the page shows it. */
function PublicSkin({ from, footer }: { from: string; footer?: boolean }) {
  const q = useQuery({
    queryKey: ["public-skin", from],
    queryFn: async () => {
      const r = await fetch(from);
      if (!r.ok) throw new Error("This could not be shown.");
      return ((await r.json()) as { url: string }).url;
    },
    retry: false,
    staleTime: Infinity,
  });
  return (
    <div className="space-y-3">
      {q.data ? (
        <iframe title="This thing" sandbox="allow-scripts" src={q.data} className="h-[70vh] w-full rounded-xl border border-line bg-surface dark:border-slate-700" data-testid="public-skin" />
      ) : (
        <p className="text-sm text-muted">{q.error ? (q.error as Error).message : "Loading…"}</p>
      )}
      {footer !== false && <p className="text-center text-xs text-faint">Made with Cobblr</p>}
    </div>
  );
}
