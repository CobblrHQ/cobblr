// Quick Access — an always-reachable slide-over of your PINNED Knowledge Base
// entries, so a thing you glance at often (a reference, a code, an SOP) is one
// tap away from any page. KB spec §6: a surface, not a second data store. For
// now it renders pinned `knowledge:entry` rows; the generic "any domain / any
// widget" version (view + action widgets) is a documented follow-up.
//
// Gated on the knowledge module being enabled (a blank workspace shows nothing).
// Portals to <body> so the header's backdrop-blur can't trap the fixed overlay
// (house rule: overlays createPortal to body).
import { useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { CORNER_STACK, Markdown, QrCode, FloatingChrome, OverlayLayer, EntityPhoto, walkPages } from "@cobblr/platform-web";
import { Zap, X, Pin, BookOpen } from "lucide-react";
import { getToken } from "../lib/api";
import { useNavModules } from "./useNavModules";

interface PinnedEntry {
  id: string;
  title: string;
  body: string | null;
  kind: string | null;
  code: string | null;
  image_path: string | null;
}

function QaImage({ path }: { path: string | null }) {
  if (!path) return null;
  return <EntityPhoto src={path} alt="" aspect="4/3" fit="contain" className="mt-2 rounded border border-line dark:border-slate-700 !bg-white" />;
}

async function fetchPinned(slug: string): Promise<PinnedEntry[]> {
  const token = getToken();
  try {
    const all = await walkPages<PinnedEntry>(async (offset, limit) => {
      const res = await fetch(`/api/v1/orgs/${slug}/modules/knowledge/entries?pinned=1&limit=${limit}&offset=${offset}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`pinned entries: ${res.status}`);
      const data = (await res.json()) as { items?: PinnedEntry[]; total?: number | null; complete?: boolean };
      return { items: data.items ?? [], total: data.total, complete: data.complete };
    });
    return all.items;
  } catch {
    return [];
  }
}

export function QuickAccess({ activeSlug }: { activeSlug: string }) {
  // Get out of the way of anything pressable underneath (yield-to-content.ts):
  // fixed chrome does not move, and the page under it does.

  const nav = useNavModules(activeSlug);
  const [open, setOpen] = useState(false);
  const enabled = nav.enabledNames.has("knowledge");

  const pinned = useQuery({
    queryKey: ["quick-access-pinned", activeSlug],
    queryFn: () => fetchPinned(activeSlug),
    enabled: enabled && open,
  });

  if (!enabled) return null;

  return (
    <>
      <FloatingChrome
        as="button"
        anchor="corner"
        // Its place in the corner's stack, above the feedback bubble, the
        // Live pill and the label queue whenever they are there.
        stack={CORNER_STACK.quickAccess}
        yieldToContent
        type="button"
        onClick={() => setOpen(true)}
        title="Quick Access - your pinned entries"
        className={"right-4 z-[80] inline-flex items-center gap-1.5 rounded-full border border-cobble-400 dark:border-cobble-600 bg-surface dark:bg-slate-900 shadow-lg px-3.5 py-2 text-sm font-medium text-content dark:text-mortar-100 hover:border-accent transition"}
      >
        <Zap size={15} className="text-accent" />
        Quick Access
      </FloatingChrome>

      {open &&
        createPortal(
          <OverlayLayer className="z-[120]" role="dialog" aria-modal="true" aria-label="Quick access">
            <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
            <div className="absolute inset-y-0 right-0 flex w-full max-w-md flex-col bg-surface dark:bg-slate-900 shadow-2xl">
              <div className="flex items-center justify-between border-b border-line dark:border-slate-700 px-4 py-3">
                <div className="flex items-center gap-2">
                  <Zap size={16} className="text-accent" />
                  <span className="font-display text-lg font-bold text-content dark:text-mortar-100">Quick Access</span>
                </div>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close"
                  className="grid h-9 w-9 place-items-center rounded text-muted hover:text-content hover:bg-subtle dark:hover:bg-slate-800"
                >
                  <X size={18} />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-2">
                {pinned.isLoading && <div className="text-sm text-muted">Loading…</div>}
                {!pinned.isLoading && (pinned.data?.length ?? 0) === 0 && (
                  <div className="rounded-lg border border-dashed border-line dark:border-slate-700 p-6 text-center text-sm text-muted">
                    <Pin size={18} className="mx-auto mb-2 text-faint" />
                    Nothing pinned yet. In the{" "}
                    <a href={`/w/${activeSlug}/knowledge`} className="text-accent hover:underline">
                      Knowledge Base
                    </a>
                    , pin an entry to keep it one tap away here.
                  </div>
                )}
                {pinned.data?.map((e) => (
                  <div
                    key={e.id}
                    className="rounded-lg border border-line dark:border-slate-700 bg-subtle/40 dark:bg-slate-800/40 p-3"
                  >
                    <div className="flex items-center gap-2">
                      <BookOpen size={13} className="shrink-0 text-faint" />
                      <a
                        href={`/w/${activeSlug}/knowledge`}
                        className="font-medium text-content dark:text-mortar-100 hover:text-accent truncate"
                      >
                        {e.title}
                      </a>
                      {e.kind && (
                        <span className="ml-auto shrink-0 rounded-full bg-surface dark:bg-slate-700 px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                          {e.kind}
                        </span>
                      )}
                    </div>
                    {e.body && (
                      <div className="mt-1.5 text-sm">
                        <Markdown>{e.body}</Markdown>
                      </div>
                    )}
                    {/* The image (e.g. a scanner config-barcode screenshot) —
                        prominent, since scanning it is the whole point. */}
                    <QaImage path={e.image_path} />
                    {e.code && (
                      <div className="mt-2 flex items-center gap-3">
                        <QrCode value={e.code} size={72} />
                        <span className="font-mono text-xs text-muted break-all">{e.code}</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </OverlayLayer>,
          document.body,
        )}
    </>
  );
}
