// Quick Access, as the rail's third tab.
//
// This was specified on 2026-07-05 as an "always-reachable DRAWER surface" and
// never built: the `pinned` column and its partial index have been sitting in
// knowledge/migrations/0001_init.sql the whole time, unread. The trigger then
// was concrete — keep two barcode-scanner configuration codes on screen to scan
// occasionally, without printing stickers.
//
// It is a tab rather than a drawer of its own because there is exactly ONE
// right-hand rail and there always will be (docs/design-decisions/
// discussion-and-the-side-rail.md). Building the drawer separately would have
// put two panels in a fight over the same 440px, and the loser would have been
// whatever record you were actually looking at.
//
// Unlike Discussion, this tab TRAVELS with you: it is deliberately the same
// wherever you are, which is the entire point of pinning something.

import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Pin } from "lucide-react";
import { api, type KnowledgeEntry } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { RailTabContent, useRailTab } from "./SideRail";

/** A pinned entry, rendered for READING rather than for editing.
 *
 *  The spec's first widget type is a `card`: a thing you keep on screen to
 *  glance at or scan. So the body shows in full rather than truncated to a
 *  preview, because a configuration code truncated to one line is a code you
 *  cannot use. */
function PinnedCard({ entry, slug }: { entry: KnowledgeEntry; slug: string }) {
  return (
    <article className="rounded-md border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-line dark:border-slate-700">
        <Pin size={11} className="shrink-0 text-amber-500" />
        <Link
          to={`/knowledge/${entry.id}`}
          className="text-sm font-medium text-content dark:text-mortar-100 truncate hover:underline"
        >
          {entry.title}
        </Link>
        {entry.kind && (
          <span className="ml-auto shrink-0 text-[10px] font-mono uppercase tracking-widest text-faint">
            {entry.kind}
          </span>
        )}
      </div>
      {entry.body && (
        <div className="px-3 py-2 text-xs text-content dark:text-mortar-200 whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
          {entry.body}
        </div>
      )}
      {/* Not a link to somewhere else: the whole value is that you did not have
          to navigate to see it. The title links out for when you do. */}
      <div className="px-3 pb-2">
        <span className="text-[10px] font-mono uppercase tracking-widest text-faint">
          pinned · workspace {slug}
        </span>
      </div>
    </article>
  );
}

export function PinnedTab() {
  const { activeSlug } = useActiveOrg();
  const { active } = useRailTab(
    activeSlug
      ? { id: "pinned", label: "Pinned", icon: <Pin size={16} />, order: 2 }
      : null,
  );

  const pinned = useQuery({
    queryKey: ["knowledge-pinned", activeSlug],
    queryFn: () => api.listKnowledgeEntries(activeSlug, { pinned: true }),
    // Only while showing, like every other tab: mounted-but-hidden must not
    // poll. But a LONG stale time, because pinned things change rarely and the
    // point of this tab is that it is instantly there.
    enabled: !!activeSlug && active,
    staleTime: 5 * 60_000,
    // Knowledge Base is opt-in. A workspace without it should see an empty tab,
    // not an error, so a 404 here is an answer rather than a failure.
    retry: false,
  });

  const items = pinned.data?.items ?? [];

  return (
    <RailTabContent id="pinned" title={<>Pinned</>}>
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-3">
        {pinned.isLoading && <p className="text-xs text-faint">loading…</p>}

        {!pinned.isLoading && items.length === 0 && (
          <div className="text-sm text-faint dark:text-slate-500 italic space-y-2">
            <p>Nothing pinned yet.</p>
            <p>
              Pin a knowledge entry and it stays here, on every page, so the
              things you keep needing are one glance away instead of one search
              away.
            </p>
            {pinned.isError && (
              // Said plainly rather than as an error: the Knowledge Base is
              // opt-in, and not having turned it on is not a fault.
              <p>
                <Link to="/bundles" className="text-accent hover:underline">
                  Turn on the Knowledge Base
                </Link>{" "}
                to start pinning things.
              </p>
            )}
          </div>
        )}

        {items.map((e) => (
          <PinnedCard key={e.id} entry={e} slug={activeSlug} />
        ))}
      </div>
    </RailTabContent>
  );
}
