// Queue widget. Visible everywhere when there's at least one label queued.
// Clicks navigate to the labels queue page.
//
// Two placements, chosen by the host to match the shell chrome (same split as
// FeedbackWidget / NotificationsBell / ChatWidget):
//   • default (top-nav mode) — a floating pill. It sits ABOVE the feedback
//     pill (both live bottom-right), not on top of it: `bottom-[4.75rem]`
//     clears the `--toast-safe-bottom` the feedback widget reserves.
//   • asRow (full-sidebar mode) — a sidebar-foot row, matching its neighbours,
//     because the feedback pill is a foot row there too and a floating pill in
//     the otherwise-empty bottom-right corner reads as orphaned chrome.

import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Tag } from "lucide-react";
import { useLabels } from "./context";

export function BasketWidget({ asRow = false }: { asRow?: boolean } = {}) {
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
    // Sidebar-foot row — same shape as the Notifications / Feedback / Ask Cobb
    // rows it sits beside. Only shown when something's queued (there's already
    // a Labels nav item, so an empty "0 queued" row would be noise).
    return (
      <Link
        to="/labels"
        title="Open label queue"
        className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded text-[13px] text-muted dark:text-slate-400 hover:text-accent hover:bg-subtle/60 dark:hover:bg-slate-800/40 transition"
      >
        <Tag size={16} className="shrink-0" />
        <span>Labels ({total} queued)</span>
      </Link>
    );
  }

  return (
    <Link
      to="/labels"
      className="fixed bottom-[4.75rem] right-4 z-40 bg-slate-700 text-mortar-50 rounded-full shadow-lg px-4 py-2 flex items-center gap-2 hover:bg-slate-600 transition"
      title="Open label queue"
    >
      <Tag size={14} />
      <span className="text-sm font-medium">{total}</span>
      <span className="text-[10px] font-mono opacity-70">queued</span>
    </Link>
  );
}
