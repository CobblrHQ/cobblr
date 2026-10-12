// How a scan says an amount of something you already have (#6047).
//
// A record kept in metres (a plank, a ribbon) read "×8.4" on the scan's
// match and "You have 8.4 → 9.4", "+1 more" on its count: a count of eight
// planks, as far as anyone could tell. A measured amount says its unit
// through the workspace's own vocabulary ("8.4 m"); a counted one keeps the
// plain number ("×3", "You have 3"), so the two stay apart.
import { useUnits } from "@cobblr/platform-web";

export interface MatchAmount {
  /** The unit measures (metres, grams), as the workspace's vocabulary says. */
  measured: boolean;
  /** "8.4 m" for a measured amount, "8.4" for a count. */
  amount: (n: number) => string;
  /** On the match's title: "8.4 m" measured, "×3" counted. */
  held: (n: number) => string;
}

export function useMatchAmount(unit: string | null | undefined): MatchAmount {
  const units = useUnits();
  const def = unit ? units.resolve(unit) : null;
  const measured = !!def && def.category !== "count";
  const amount = (n: number) => (measured ? units.format(n, unit) : String(n));
  return { measured, amount, held: (n) => (measured ? amount(n) : `×${n}`) };
}
