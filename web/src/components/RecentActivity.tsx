// The dashboard's Recent activity: a workspace's latest lines, a burst said
// once ("Homebox updated 47 locations", "You scanned 23 things") and opened
// in place. Out of Dashboard.tsx so it can be tested with a day's rows
// (#6564).
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { EntityPhoto, relativeTime } from "@cobblr/platform-web";
import { activityActor, activitySyncSource, ACTIVITY_VERBS } from "@cobblr/platform-contract/activity-summary";
import { api, type ActivityEntry } from "../lib/api";
import { useKindLabels } from "../lib/useKindLabels";
import { useWorkspaceContentProbe } from "../lib/workspaceContent";
import { activityKind } from "../lib/activityKind";
import { AUTOMATION_ACTIONS, activityVerb, actorWords, automationWords, recentActivityRows } from "../lib/activity-words";
import { ActivitySentence, ActivityThumbnail, ACTIVITY_FEED_LAYOUT, pickString, type KindLabels } from "./ActivitySentence";
import { SubjectLink } from "./SubjectLink";
// ──────────────────────── recent activity ───────────────────────────

// Provisioning/plumbing entity-types that mean nothing to a user ("tenant
// provisioned", "module enabled ×23", "joined user", workspace created). Hidden
// from the dashboard summary so a fresh workspace doesn't lead with an audit
// log of things it did to itself. The full /activity page still shows everything.
export function RecentActivity({ slug, editing = false, heading }: { slug: string; editing?: boolean; heading?: ReactNode }) {
  const [visibleCount, setVisibleCount] = useState(5);
  const { ready, hasContent } = useWorkspaceContentProbe(slug);
  const labels = useKindLabels(slug);
  // Enough rows for enough LINES: a sync that touched 47 places is one line,
  // and read as 50 rows it was the whole feed, hiding the day's scans behind
  // it (#6564). Pages back until there are lines to show, a few pages at most.
  const q = useQuery({
    queryKey: ["dash-activity", slug],
    queryFn: async () => {
      const items: ActivityEntry[] = [];
      let before: number | null | undefined;
      for (let page = 0; page < ACTIVITY_PAGES; page++) {
        const r = await api.orgActivity(slug, 100, before);
        items.push(...r.items);
        before = r.next_before;
        if (!before || groupActivity(recentActivityRows(items)).length > ACTIVITY_LINES_WANTED) break;
      }
      return { items };
    },
    staleTime: 30_000,
  });
  // A row with no words a member can read (an automation row that carries
  // only ids, an action that found nothing to do) is not shown here; the
  // full /activity log keeps it (#3299).
  const items = recentActivityRows(q.data?.items ?? []);
  const groups = groupActivity(items);
  // A workspace with no content has no activity by definition: hide the whole
  // section rather than open the first dashboard with "no activity yet"
  // (new-user-flow.md F3). Arrange mode still shows it so it stays orderable.
  if (!editing && items.length === 0 && (!ready || !hasContent)) return null;
  return (
    <section>
      {!editing && heading}
      {q.isLoading && <div className="text-xs text-faint">loading…</div>}
      {!q.isLoading && items.length === 0 && (
        <div className="text-xs text-faint italic">no activity yet</div>
      )}
      {groups.length > 0 && (
        <ul className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 divide-y divide-line dark:divide-slate-800" data-testid="activity-feed">
          {groups.slice(0, visibleCount).map((g) => {
            const first = g.items[0];
            if (!first) return null;
            return g.items.length === 1 ? (
              <ActivityRow key={first.id} entry={first} labels={labels} />
            ) : (
              <ActivityGroupRow key={first.id} group={g} labels={labels} />
            );
          })}
          {visibleCount < groups.length && (
            <li>
              <button type="button" className="w-full px-3 py-2 text-sm text-accent hover:bg-subtle dark:hover:bg-slate-800/40" onClick={() => setVisibleCount(count => count + 5)}>
                Show more
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

/** Lines the feed wants before it stops paging back, and the pages it reads at most. */
const ACTIVITY_LINES_WANTED = 15;
const ACTIVITY_PAGES = 4;

interface ActivityGroup {
  signature: string;
  items: ActivityEntry[];
}

/** Roll up consecutive entries that share actor + action + entity_type.
 *  An 8-pairings burst from a single seed run becomes one line that
 *  expands on click. Non-adjacent identical entries STAY separate —
 *  if something else happened in between, the burst was already
 *  interrupted and rolling those up would distort the timeline. */
function groupActivity(items: ActivityEntry[]): ActivityGroup[] {
  const out: ActivityGroup[] = [];
  for (const e of items) {
    const sig = `${e.user_id ?? actorWords(e)}|${e.template ?? e.action}|${e.subject?.kind ?? e.entity_kind ?? e.entity_type ?? ""}${AUTOMATION_ACTIONS.has(e.action) ? `|${e.id}` : ""}`;
    const last = out[out.length - 1];
    if (last && last.signature === sig && Math.abs(Date.parse(last.items[0]!.occurred_at) - Date.parse(e.occurred_at)) <= 120_000) {
      last.items.push(e);
    } else {
      out.push({ signature: sig, items: [e] });
    }
  }
  return out;
}


function ActivityRow({ entry: e, labels }: { entry: ActivityEntry; labels: KindLabels }) {
  return (
    <li className={`px-3 py-2 text-sm ${ACTIVITY_FEED_LAYOUT}`} data-testid="activity-row">
      <ActivityThumbnail entry={e} labels={labels} />
      <ActivitySentence entry={e} labels={labels} />
      <time dateTime={e.occurred_at} className="text-[10px] tabular-nums text-faint whitespace-nowrap" data-testid="activity-time">
        {relativeTime(e.occurred_at)}
      </time>
    </li>
  );
}

/** Consolidated row for a burst of N identical-signature entries.
 *  Shows one summary line + a `×N` chip that always expands to reveal
 *  each underlying entry — so a "deleted ×3" can be opened to see the
 *  three specific things. Each child row falls back to its entity_type
 *  + timestamp when its diff carries no title, so the burst is always
 *  inspectable even without per-item names. */
function ActivityGroupRow({ group, labels }: { group: ActivityGroup; labels: KindLabels }) {
  // Guaranteed non-empty: ActivityGroup is only constructed inside
  // groupActivity which always pushes at least one item before the
  // group is recorded; and the caller only renders this for groups
  // with length > 1.
  const first = group.items[0]!;
  const ids = group.items.map(e => e.subject?.title ?? activityIdentity(e));
  const distinct = [...new Set(ids.filter(Boolean))];
  const actor = activityActor(first, first.summary?.startsWith("You ") ? first.user_id ?? undefined : undefined);
  const noun = first.action.startsWith("bundle_") ? "collections" : (first.template === "file_created:scan" || first.action === "scan_received") && !first.subject?.kind ? "things" : labels.plural(first.subject?.kind ?? activityKind(first));
  const same = group.items.every(e => e.summary === first.summary && e.subject?.id === first.subject?.id);
  // A sync's burst, said as a person would: "Homebox updated 47
  // locations", never a log line of the first few names (#6564).
  const sync = activitySyncSource(first);
  const summary = sync && !same ? `${sync} ${first.verb ?? ACTIVITY_VERBS[first.action] ?? "changed"} ${group.items.length} ${noun}`
    : same ? `${first.summary ?? `${actor} ${activityVerb(first.action)} ${ids[0]}`} ×${group.items.reduce((n, e) => n + (e.repeats ?? 1), 0)}`
    : first.action === "bundle_installed" && !first.user_id ? `Set up for you: ${distinct.join(", ")}`
    : `${actor} ${first.verb ?? ACTIVITY_VERBS[first.action] ?? "changed"} ${group.items.length} ${noun}${distinct.length ? `: ${distinct.slice(0, 2).join(", ")}${distinct.length > 2 ? ", …" : ""}` : ""}`;
  const pictures = group.items.filter((e) => !!e.subject?.thumbnail);
  const rowContent = (
    <div className={`text-sm w-full min-w-0 ${ACTIVITY_FEED_LAYOUT}`} data-testid="activity-row">
      <ActivityThumbnail entry={first} labels={labels} />
      <span className="min-w-0 text-content" data-testid="activity-item">
        <span className="line-clamp-2">
          <SubjectLink href={first.subject?.href ?? "/activity"} className="hover:underline" testId="activity-item-link">{summary}</SubjectLink>
        </span>
        {/* A burst of things with pictures shows them: "You scanned 23
            things" and the first few, so the line says what, not only how many. */}
        {pictures.length > 1 && (
          <span className="mt-1 flex gap-1" data-testid="activity-burst-pictures">
            {pictures.slice(0, 6).map((e) => (
              <EntityPhoto key={e.id} src={e.subject!.thumbnail} alt={e.subject?.title ?? ""} size={24} className="rounded bg-subtle" />
            ))}
            {pictures.length > 6 && <span className="self-center text-[11px] text-faint">+{pictures.length - 6}</span>}
          </span>
        )}
      </span>
      <span className="flex items-start gap-2">
        {/* Says what it does: a bare ▸ read as a stray mark (#6564). */}
        <span data-testid="activity-caret" className="shrink-0 text-[11px] font-medium text-accent">
          <span className="group-open:hidden">Show all {group.items.length}</span>
          <span className="hidden group-open:inline">Hide</span>
        </span>
        <time dateTime={first.occurred_at} className="text-[10px] tabular-nums text-faint whitespace-nowrap" data-testid="activity-time">{relativeTime(first.occurred_at)}</time>
      </span>
    </div>
  );
  return (
    <li>
      <details className="group">
        <summary className="list-none cursor-pointer px-3 py-2 hover:bg-subtle dark:hover:bg-slate-800/40 transition">
          {rowContent}
        </summary>
        <ul className="border-t border-line dark:border-slate-800 bg-mortar-25 dark:bg-slate-800/20 divide-y divide-line dark:divide-slate-800/40">
          {group.items.map((e) => (
            <ActivityRow key={e.id} entry={e} labels={labels} />
          ))}
        </ul>
      </details>
    </li>
  );
}


/** The "what" cell. A wire's row is the action's own sentence for what it did
 *  (activity-words.ts); an id is never printed. Everything else uses its
 *  create-time title, then the live record's, then the changed fields. */

/** A stable plain-text identity for burst summarization — the string form of
 *  what activityTitle() renders. A wire's identity is its action's label, so
 *  one wire firing six times collapses; everything else falls back to its
 *  create-time title. Empty when neither exists (never counts as "same"). */
function activityIdentity(e: ActivityEntry): string {
  const diff = (e.diff ?? {}) as Record<string, unknown>;
  if (AUTOMATION_ACTIONS.has(e.action)) {
    // One wire firing six times is one thing done six times: its label is
    // the identity, so the burst collapses; the ids stay internal.
    const w = automationWords(e);
    return w.hidden ? "" : (w.label ?? w.said);
  }
  return pickString(diff, ["name", "title", "label"]) ?? "";
}


