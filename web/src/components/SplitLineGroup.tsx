// One order line and the parts it came apart into (#6067). The owner: "The
// problem is that the UI does not show how one line item was expanded into
// its contents." The line stays visible as the parent, with its picture, its
// price and how the split was decided; its parts sit under it in a box, each
// its own card. The parent's actions are the group's: Add all, Undo split,
// and collapse. On a phone the group starts collapsed to its parent.
//
// When every part is the same kind of thing (one table, #6456), the parent
// says the table and the values the parts share once, and each part is a
// short row: its picture, its own name, what differs, Add and Details. The
// owner: "all the category and action buttons can stay with the parent and
// you just open it up to see 10 very short line items".
import { useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, MoreHorizontal, Scissors } from "lucide-react";
import { BackdropLayer, EntityPhoto, PopoverLayer, useCloseOnPageScroll, useEscapeToClose, useMenuFocus, useToast } from "@cobblr/platform-web";
import { MetaParts } from "./MetaParts";
import { formatStoredMoney, moneyStorageOf } from "@cobblr/platform-contract/money";
import { alikeParts, titleWords, type AlikeField, type AlikeParts } from "@cobblr/platform-contract/split-line";
import { api, ApiError, type ScanInboxItem, type ScanMenuEntry } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { scanInboxKeys } from "../lib/scan-inbox-keys";
import { destinationChoices, entryKey } from "../lib/scanDestination";
import { useUndoSplit } from "../lib/useUndoSplit";
import { cleanCandidates } from "../pages/scanQuickFile";
import { DestinationPicker } from "./DestinationPicker";
import { currentPicture, leadYours, rowPictures } from "../lib/rowPictures";
import type { SplitParent } from "../lib/splitLayout";

/** Where a part goes and the values it would be filed with (its card's
 *  destination, scanFileAll.ts destinationCandidateOf). */
export type SplitPartRoute = { module: string; instance: string | null; kind?: string | null; label?: string | null; fields?: Record<string, unknown> | null } | null;

/** A row's current picture, fetched signed in through EntityPhoto. */
function RowPicture({ item, size, eager, yours }: { item: ScanInboxItem; size: number; eager?: boolean; yours?: boolean }) {
  const { activeSlug } = useActiveOrg();
  const pics = rowPictures(activeSlug, item);
  const pic = yours ? leadYours(pics.pictures) : currentPicture(pics.pictures);
  return (
    <EntityPhoto
      src={pic ? pics.src(pic, "thumb") : null}
      alt={item.suggested_name ?? ""}
      size={size}
      fit="contain"
      eager={eager}
      className="shrink-0 rounded-lg bg-surface dark:bg-slate-800"
      placeholder={<Scissors size={16} className="text-faint" aria-hidden />}
    />
  );
}

const phone = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(max-width: 639.98px)").matches;

export function SplitLineGroup({
  parentId,
  summary,
  parentCard,
  parts,
  renderPart,
  onAddAll,
  routeOf,
  menu,
}: {
  parentId: string;
  summary: SplitParent | null;
  /** The parent's own card, when the line is still open (Split off). */
  parentCard: ReactNode | null;
  parts: readonly ScanInboxItem[];
  renderPart: (item: ScanInboxItem) => ReactNode;
  /** Files every waiting part, each to its own table. */
  onAddAll: (ids: string[]) => Promise<unknown> | void;
  /** Each part's table and values: with it, alike parts become short rows. */
  routeOf?: (item: ScanInboxItem) => SplitPartRoute;
  /** The workspace's tables, for the parent's picker and the fields' labels. */
  menu?: readonly ScanMenuEntry[] | null;
}) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(() => !phone());
  const undo = useUndoSplit();
  const [moreAt, setMoreAt] = useState<{ top: number; right: number } | null>(null);
  const moreBtn = useRef<HTMLButtonElement | null>(null);
  const moreMenu = useRef<HTMLDivElement | null>(null);
  const closeMore = () => {
    setMoreAt(null);
    moreBtn.current?.focus();
  };
  useEscapeToClose(!!moreAt, moreMenu, closeMore);
  useMenuFocus(!!moreAt, moreMenu);
  useCloseOnPageScroll(!!moreAt, () => setMoreAt(null));
  const [adding, setAdding] = useState(false);
  const [opened, setOpened] = useState<string | null>(null);
  const row = summary?.row ?? null;
  const waiting = parts.filter((p) => p.status === "pending");
  // Alike only among the waiting parts: a filed one keeps its filed row.
  const alike: AlikeParts | null = useMemo(() => {
    if (!routeOf || waiting.length < 2) return null;
    const routes = new Map(waiting.map((p) => [p.id, routeOf(p)]));
    const d = routes.get(waiting[0]!.id);
    const labels = Object.fromEntries((menu?.find((m) => d && m.module === d.module && (m.instance ?? null) === (d.instance ?? null))?.fields ?? []).map((f) => [f.name, f.label]));
    return alikeParts(
      waiting.map((p) => ({ id: p.id, name: p.suggested_name, quantity: Math.max(1, Math.round(Number(p.quantity ?? 1)) || 1), destination: routes.get(p.id) ?? null, fields: routes.get(p.id)?.fields ?? null })),
      labels,
    );
  }, [routeOf, waiting, menu]);
  const shortOf = new Map((alike?.parts ?? []).map((p) => [p.id, p]));
  // A value said the way its field keeps it: money with its currency
  // ("Price per kg $8.80", never "8.8", #6527).
  const defs = new Map((menu?.find((m) => alike && m.module === alike.destination.module && (m.instance ?? null) === (alike.destination.instance ?? null))?.fields ?? []).map((f) => [f.name, f]));
  const said = (f: AlikeField) => {
    const def = defs.get(f.key);
    const storage = def ? moneyStorageOf(def) : null;
    return `${f.label} ${(storage && formatStoredMoney(f.value, storage, { currency: summary?.currency })) || f.value}`;
  };
  // The same list, in the same order, as each part's own picker (#6527):
  // the parts' suggestions first, then every table.
  const choices = destinationChoices(menu, waiting[0] ? cleanCandidates(waiting[0]) : [], null);
  const moveAll = useMutation({
    mutationFn: async (key: string) => {
      const entry = choices.find((c) => c.key === key);
      if (!entry) return null;
      const destination = { module: entry.module, instance: entry.instance ?? null, kind: entry.kind ?? null, label: entry.label };
      for (const p of waiting) await api.updateScanItem(activeSlug, p.id, { destination });
      return entry.label;
    },
    onSuccess: (label) => {
      void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
      if (label) toast.success(`All ${waiting.length} now go to ${label}`);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const noun = parts.length === 1 ? "part" : "parts";
  const price = summary?.line_total != null ? formatStoredMoney(summary.line_total, "amount", { currency: summary.currency }) : null;

  return (
    <section
      data-testid="split-line-group"
      data-parent-id={parentId}
      className="rounded-xl border border-line dark:border-slate-700 bg-subtle/40 dark:bg-slate-900/40"
    >
      {parentCard}
      {summary && (
        <div className="p-3" data-testid="split-line-parent">
          {/* The parent row is the parts' toggle (#6527): tap it to open or
              close them. Its details stay; its controls are one row under it. */}
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-label={`${open ? "Hide" : "Show"} the ${parts.length} ${noun} of ${summary.name ?? "this line"}`}
            title={`${open ? "Hide" : "Show"} the ${parts.length} ${noun}`}
            data-testid="split-line-toggle"
            className="flex w-full items-start gap-3 rounded-lg text-left hover:bg-surface/60"
          >
            {!parentCard &&
              (row ? (
                // A photo split's parent shows the person's photo of the
                // group, never the catalog picture of the one thing its first
                // read named (fresh garlic over a shelf of jars, #8795).
                <RowPicture item={row} size={56} eager yours={summary.how === "photo"} />
              ) : (
                <div className="h-14 w-14 shrink-0 rounded-lg bg-surface dark:bg-slate-800 flex items-center justify-center">
                  <Scissors size={18} className="text-faint" aria-hidden />
                </div>
              ))}
            <span className="min-w-0 flex-1 space-y-0.5">
              {!parentCard && (
                <span className="block text-sm font-medium text-content dark:text-mortar-100 break-words" data-testid="split-line-name">
                  {summary.name ?? "An order line"}
                </span>
              )}
              <span className="block text-xs text-content dark:text-mortar-100" data-testid="split-line-headline">
                {summary.headline}
                {price && <span className="text-muted"> · {price}</span>}
              </span>
              <span className="block text-xs text-muted" data-testid="split-line-how">
                {summary.how_words ? `${summary.how_words} · ` : ""}
                <span data-testid="split-line-check">{summary.check}</span>
                {summary.filed > 0 && <span> · {summary.filed} added</span>}
              </span>
              {alike && alike.shared.length > 0 && (
                <span className="block text-xs text-muted" data-testid="split-line-shared">
                  <MetaParts parts={alike.shared.map(said)} />
                </span>
              )}
            </span>
            <span className="shrink-0 pt-0.5 text-muted">{open ? <ChevronDown size={18} aria-hidden /> : <ChevronRight size={18} aria-hidden />}</span>
          </button>
          <div className="flex items-center gap-1.5 pt-2 sm:pl-[68px]">
            {alike && (
              <DestinationPicker
                options={choices}
                value={entryKey(alike.destination.module, alike.destination.instance)}
                onPick={(k) => moveAll.mutate(k)}
                label={`Where all ${waiting.length} go`}
                trigger={(t) => (
                  <button
                    type="button"
                    ref={t.ref}
                    {...t.props}
                    onClick={t.toggle}
                    disabled={moveAll.isPending}
                    data-testid="split-line-destination"
                    title={`Where all ${waiting.length} go`}
                    className="inline-flex min-h-11 min-w-0 items-center gap-1 rounded-full border border-line dark:border-slate-700 bg-surface dark:bg-slate-800 px-3 text-xs font-medium text-content dark:text-mortar-100 disabled:opacity-50"
                  >
                    <span className="min-w-0 truncate">{choices.find((c) => c.key === entryKey(alike.destination.module, alike.destination.instance))?.label ?? alike.destination.label ?? "Their table"}</span>
                    <ChevronDown size={14} className="shrink-0 text-faint" aria-hidden />
                  </button>
                )}
              />
            )}
            {waiting.length > 1 && (
              <button
                type="button"
                disabled={adding}
                data-testid="split-line-add-all"
                onClick={async () => {
                  setAdding(true);
                  try {
                    await onAddAll(waiting.map((p) => p.id));
                  } catch (e) {
                    toast.error(e instanceof ApiError ? e.message : String(e));
                  } finally {
                    setAdding(false);
                  }
                }}
                // First on its row: where they all go is known once the
                // tables answer, and it arriving before this pushed it
                // 99 px under a finger (#7789). The ⋯ holds the right end.
                className="order-first inline-flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-full bg-cobble-600 hover:bg-cobble-700 px-3 text-xs font-medium text-white disabled:opacity-50"
              >
                Add all {waiting.length}
              </button>
            )}
            {summary.can_undo && (
              <button
                type="button"
                ref={moreBtn}
                aria-haspopup="menu"
                aria-expanded={!!moreAt}
                aria-label="More for this line"
                title="More for this line"
                data-testid="split-line-more"
                onClick={() => {
                  const r = moreBtn.current?.getBoundingClientRect();
                  setMoreAt(moreAt || !r ? null : { top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
                }}
                className="ml-auto inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full border border-line dark:border-slate-700 text-content dark:text-mortar-100 hover:bg-surface"
              >
                <MoreHorizontal size={16} aria-hidden />
              </button>
            )}
          </div>
          {/* Undo split lives in the ⋯, never a button beside Add all: a tap
              that missed a menu landed on it and put the owner's pack of ten
              back as one (#6527). Its toast offers Split again. */}
          {moreAt &&
            createPortal(
              <>
                <BackdropLayer className="z-[60]" onClick={closeMore} />
                <PopoverLayer ref={moreMenu} role="menu" style={{ top: moreAt.top, right: moreAt.right }} className="z-[61] min-w-[14rem] rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-1 shadow-xl">
                  <button
                    type="button"
                    role="menuitem"
                    ref={(el) => el?.focus({ preventScroll: true })}
                    disabled={undo.isPending}
                    data-testid="split-line-undo"
                    onClick={() => {
                      setMoreAt(null);
                      undo.mutate(parentId);
                    }}
                    className="flex min-h-11 w-full flex-col items-start justify-center rounded-lg px-3 text-left hover:bg-subtle dark:hover:bg-slate-800 disabled:opacity-50"
                  >
                    <span className="text-sm text-content dark:text-mortar-100">Undo split</span>
                    <span className="text-xs text-faint">Put the parts back together as the one line they came from</span>
                  </button>
                </PopoverLayer>
              </>,
              document.body,
            )}
        </div>
      )}
      {open && (
        <div className="space-y-2 border-t border-line dark:border-slate-700 p-2 pl-3 sm:pl-6" data-testid="split-line-parts">
          {parts.map((p) => {
            const short = shortOf.get(p.id);
            if (!short) return renderPart(p);
            return (
              <div key={p.id}>
                <div className="flex items-center gap-2 py-0.5" data-testid="split-part-row" data-part-id={p.id}>
                  <RowPicture item={p} size={40} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-content dark:text-mortar-100" data-testid="split-part-name" title={p.suggested_name ?? undefined}>
                      {titleWords(short.short)}
                    </div>
                    {short.differs.length > 0 && (
                      <div className="truncate text-xs text-muted">
                        <MetaParts parts={short.differs.map(said)} />
                      </div>
                    )}
                  </div>
                  {short.quantity !== 1 && <span className="shrink-0 text-xs text-muted">× {short.quantity}</span>}
                  <button
                    type="button"
                    data-testid="split-part-add"
                    disabled={adding}
                    onClick={async () => {
                      setAdding(true);
                      try {
                        await onAddAll([p.id]);
                      } catch (e) {
                        toast.error(e instanceof ApiError ? e.message : String(e));
                      } finally {
                        setAdding(false);
                      }
                    }}
                    className="inline-flex min-h-11 shrink-0 items-center rounded-full bg-cobble-600 hover:bg-cobble-700 px-3 text-xs font-medium text-white disabled:opacity-50"
                  >
                    Add
                  </button>
                  <button
                    type="button"
                    aria-expanded={opened === p.id}
                    aria-label={`Details of ${titleWords(short.short)}`}
                    title={`Details of ${titleWords(short.short)}`}
                    onClick={() => setOpened((o) => (o === p.id ? null : p.id))}
                    className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full border border-line dark:border-slate-700 text-content dark:text-mortar-100 hover:bg-surface"
                  >
                    {opened === p.id ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
                  </button>
                </div>
                {opened === p.id && renderPart(p)}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
