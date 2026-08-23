// How prominent should a tag be right now?
//
// Tags were ordered alphabetically everywhere, which carries no information: a
// tag called "3DPrintopia 2026" sorted above "in service" forever, because it
// starts with a digit. After the trade show it is history — worth keeping,
// not worth reading every time you open a printer.
//
// The obvious rule, "fade whatever has not been used lately", is wrong on its
// own. It punishes tags that are STABLE rather than stale: `fragile`,
// `consumable`, `in service` may get no new assignment for a year and still be
// exactly what you want to see.
//
// What separates them is SHAPE, not age:
//
//   3DPrintopia 2026   ▁▁▁▁▁█▇▁▁▁▁▁   3 records, one week, 6 months ago
//   in service         ▂▃▂▃▄▂▃▂▄▃▂▃   41 records, still accruing
//   fragile            ▁▂▁▁▂▁▁▁▂▁▁▂   28 records, occasional, long-lived
//
// An EVENT tag is narrow, bursty and old. A STRUCTURAL tag is broad, or still
// growing. Both signals are already in core_tags_assignments — count, spread,
// recency — so this needs no new writes and no new bookkeeping.
//
// Pure on purpose: `now` is a parameter, never Date.now(), so the ranking is
// testable and gives the same answer for the same inputs.

/** What the scorer needs about one tag. All of it is already stored. */
export interface TagUsage {
  id: string;
  name: string;
  /** Records carrying this tag, workspace-wide. */
  uses: number;
  /** Most recent assignment, or null if the tag has never been attached. */
  lastUsedAt: Date | null;
  /** Oldest assignment, or null. Together with lastUsedAt this is the spread. */
  firstUsedAt: Date | null;
  /** User override: always ranks first, never collapses. */
  pinned?: boolean;
}

const DAY_MS = 86_400_000;

/** Recency halves a tag's weight every this many days. ~a quarter: long enough
 *  that a seasonal tag survives its off-season, short enough that a one-week
 *  event has visibly receded a few months later. */
export const HALF_LIFE_DAYS = 90;

/** Not used in this long → eligible to collapse behind "+N". A concrete
 *  number, not the score, because a hidden thing has to come with a reason a
 *  person can read: "not used in 6 months" explains itself, "relevance 0.31"
 *  does not. */
export const QUIET_AFTER_DAYS = 180;

/** A tag on at least this many records is STRUCTURAL — it describes how the
 *  workspace is organised, so it stays up front however long ago it was last
 *  applied. This is what stops `fragile` fading just because nothing new has
 *  been fragile lately. */
export const STRUCTURAL_USES = 12;

export function daysBetween(from: Date, to: Date): number {
  return Math.max(0, (to.getTime() - from.getTime()) / DAY_MS);
}

/** Higher is more prominent.
 *
 *  Breadth enters as a log so that 40 records beats 4 without 400 burying
 *  everything else; recency enters as an exponential decay. A tag still being
 *  applied today is fresh by definition, so "still accruing" needs no separate
 *  term — it falls out of lastUsedAt. */
export function relevance(tag: TagUsage, now: Date): number {
  if (tag.uses === 0 || !tag.lastUsedAt) return 0;
  const breadth = Math.log2(1 + tag.uses);
  const age = daysBetween(tag.lastUsedAt, now);
  return breadth * Math.pow(0.5, age / HALF_LIFE_DAYS);
}

/** Should this tag fold behind "+N" on a record's chip row?
 *
 *  Deliberately NOT "score below a cutoff". The score is fine for ordering,
 *  where nobody asks why #4 comes before #5, but hiding something needs a
 *  stated cause. Pinned tags never collapse; broad tags never collapse. */
export function isQuiet(tag: TagUsage, now: Date): boolean {
  if (tag.pinned) return false;
  if (tag.uses >= STRUCTURAL_USES) return false;
  if (!tag.lastUsedAt) return true;
  return daysBetween(tag.lastUsedAt, now) >= QUIET_AFTER_DAYS;
}

/** Why a tag is folded away, in words, for the "+N" tooltip. */
export function quietReason(tag: TagUsage, now: Date): string {
  if (!tag.lastUsedAt) return `${tag.name} · never used`;
  const days = Math.floor(daysBetween(tag.lastUsedAt, now));
  const months = Math.floor(days / 30);
  const when = months >= 12
    ? `${Math.floor(months / 12)}y ago`
    : months >= 1
      ? `${months}mo ago`
      : `${days}d ago`;
  return `${tag.name} · last used ${when}`;
}

/** Pinned first, then most relevant, then by name so the order is stable when
 *  two tags score the same (a fresh workspace, where everything was tagged the
 *  same afternoon, would otherwise shuffle between renders). */
export function rankTags<T extends TagUsage>(tags: T[], now: Date): T[] {
  return [...tags].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    const d = relevance(b, now) - relevance(a, now);
    if (Math.abs(d) > 1e-9) return d;
    return a.name.localeCompare(b.name);
  });
}
