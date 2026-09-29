// Who acted and HOW, for every activity surface: the person (or Automation,
// or Cobblr), then a small chip for the token, MCP, the assistant or the
// automation behind it. One component so the dashboard feed and the Activity
// page cannot disagree again: the dashboard showed no token at all while the
// Activity page named it, and the owner had been told the feed shows both
// (#3833). The words are activity-words.ts's, tested there.
//
// And one layout, because the actor is the part of a row that may give way.
// A label's via chip carries the label's own name, which can be long, and it
// was shrink-0 and nowrap: on a phone it took the whole row and the item the
// row is about ("took one of BANANAS") was left 0px wide (#3994). So a row
// wraps before anything is squeezed away: the item keeps a readable width, a
// long actor-and-chip takes a line of its own, and the chip truncates (its
// full text in a tooltip) only when even a line is not enough. Rows use
// ACTIVITY_ROW, ACTOR_CELL and ITEM_CELL rather than choosing their own.
import { actorWords, groupViaWords, viaWords, type ActivityWordsEntry } from "../lib/activity-words";

/** An activity row: it wraps rather than squeeze a cell to nothing. */
export const ACTIVITY_ROW = "flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5";
/** The row's cell for ActorVia / GroupActorVia: at most a line, chip truncating. */
export const ACTOR_CELL = "flex min-w-0 max-w-full";
/** The row's cell for the item the row is about: never squeezed away. */
export const ITEM_CELL = "min-w-[5.5rem] max-w-full truncate";

export function ViaChip({ via }: { via: string | null }) {
  if (!via) return null;
  return (
    <span
      title={via}
      data-testid="activity-via"
      className="min-w-0 truncate rounded px-1 py-0.5 text-[10px] leading-none bg-subtle text-muted dark:bg-slate-800 dark:text-slate-300 whitespace-nowrap"
    >
      {via}
    </span>
  );
}

/** The actor cell of one row. */
export function ActorVia({ entry }: { entry: ActivityWordsEntry }) {
  return (
    <span className="inline-flex items-baseline gap-1 min-w-0 max-w-full">
      <span className="shrink-0">{actorWords(entry)}</span>
      <ViaChip via={viaWords(entry)} />
    </span>
  );
}

/** The actor cell of a grouped row: the first row's actor, and the shared
 *  chip, or "mixed" when the rows were made different ways. */
export function GroupActorVia({ entries }: { entries: readonly ActivityWordsEntry[] }) {
  const first = entries[0];
  if (!first) return null;
  return (
    <span className="inline-flex items-baseline gap-1 min-w-0 max-w-full">
      <span className="shrink-0">{actorWords(first)}</span>
      <ViaChip via={groupViaWords(entries)} />
    </span>
  );
}
