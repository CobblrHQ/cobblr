// Queue widget. Visible everywhere when there's at least one label queued.
// Clicks navigate to the labels queue page.
//
// Two placements, chosen by the host to match the shell chrome (same split as
// FeedbackWidget / NotificationsBell / ChatWidget):
//   • default (top-nav mode) — a floating pill, DESKTOP ONLY (`hidden md:flex`).
//     On a phone the bottom-right pill sat over page content and the thumb zone,
//     so the mobile menu carries an `asRow` copy instead (the host mounts it in
//     MobileNav). It sits ABOVE the feedback pill (both live bottom-right), not
//     on top of it: `bottom-[4.75rem]` clears the `--toast-safe-bottom` the
//     feedback widget reserves.
//   • asRow (full-sidebar mode + the mobile menu) — a nav-style row matching its
//     neighbours; a floating pill in an otherwise-empty corner reads as orphaned
//     chrome, and on mobile it's in the way. `rowClassName` lets the host match
//     the row to its own menu styling; `onNavigate` closes the menu on tap.

import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Tag } from "lucide-react";
import { useLabels } from "./context";

export function BasketWidget({
  asRow = false,
  rowClassName,
  onNavigate,
}: { asRow?: boolean; rowClassName?: string; onNavigate?: () => void } = {}) {
  const { api, orgSlug } = useLabels();
  // Gate by orgSlug so the widget doesn't fire `/orgs//modules/...`
  // before the host has hydrated the active workspace from /me.
  const { data } = useQuery({
    queryKey: ["labels-queue", orgSlug],
    queryFn: () => api.listQueue(),
    refetchInterval: 10_000,
    enabled: !!orgSlug,
  });
  const items = data?.items ?? [];
  if (items.length === 0) return null;
  const total = items.reduce((acc, i) => acc + i.qty, 0);

  if (asRow) {
    // Nav-style row — same shape as the Notifications / Feedback / Ask Cobb rows
    // it sits beside (or the host's own menu rows, via rowClassName). Only shown
    // when something's queued (there's already a Labels nav item, so an empty
    // "0 queued" row would be noise).
    return (
      <Link
        to="/labels"
        title="Open label queue"
        onClick={onNavigate}
        className={
          rowClassName ??
          "w-full flex items-center gap-2.5 px-3 py-1.5 rounded text-[13px] text-muted dark:text-slate-400 hover:text-accent hover:bg-subtle/60 dark:hover:bg-slate-800/40 transition"
        }
      >
        <Tag size={16} className="shrink-0" />
        <span>Labels ({total} queued)</span>
      </Link>
    );
  }

  return (
    <Link
      to="/labels"
      className="hidden md:flex fixed bottom-[4.75rem] right-4 z-40 bg-slate-700 text-mortar-50 rounded-full shadow-lg px-4 py-2 items-center gap-2 hover:bg-slate-600 transition"
      title="Open label queue"
    >
      <Tag size={14} />
      <span className="text-sm font-medium">{total}</span>
      <span className="text-[10px] font-mono opacity-70">queued</span>
    </Link>
  );
}
