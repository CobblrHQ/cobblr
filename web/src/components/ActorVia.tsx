// Who acted and HOW, for every activity surface: the person (or Automation,
// or Cobblr), then a small chip for the token, MCP, the assistant or the
// automation behind it. One component so the dashboard feed and the Activity
// page cannot disagree again: the dashboard showed no token at all while the
// Activity page named it, and the owner had been told the feed shows both
// (#3833). The words are activity-words.ts's, tested there.
import { actorWords, groupViaWords, viaWords, type ActivityWordsEntry } from "../lib/activity-words";

export function ViaChip({ via }: { via: string | null }) {
  if (!via) return null;
  return (
    <span className="inline-flex items-center rounded px-1 py-0.5 text-[10px] leading-none bg-subtle text-muted dark:bg-slate-800 dark:text-slate-300 whitespace-nowrap">
      {via}
    </span>
  );
}

/** The actor cell of one row. */
export function ActorVia({ entry }: { entry: ActivityWordsEntry }) {
  return (
    <span className="inline-flex items-baseline gap-1 shrink-0">
      <span>{actorWords(entry)}</span>
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
    <span className="inline-flex items-baseline gap-1 shrink-0">
      <span>{actorWords(first)}</span>
      <ViaChip via={groupViaWords(entries)} />
    </span>
  );
}
