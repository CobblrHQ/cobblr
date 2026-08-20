// The reading column for /me — your account's pages.
//
// This is the same fix Configuration got in the 2026-07 revamp, applied to the
// area that revamp did not reach. Nine /me pages each set their own wrapper and
// the result was five widths and three centring behaviours: max-w-xl, max-w-2xl,
// max-w-3xl and two pages with none, and five of the nine set a width without
// mx-auto, so they pinned to the left of AppLayout's already-centred region and
// left a void down the right on a wide screen. Nobody chose that; each page
// copied whichever neighbour was open at the time, which is exactly the failure
// CONFIG_COLUMN's comment describes ("six of them and both alignments").
//
// So the column lives HERE and the LAYOUT applies it. A page renders its
// content. That is the part that makes it stay fixed: a per-page wrapper is a
// decision every new page gets to make again, and re-making it is how the drift
// happened the first time.

/** The reading column. Same measure as Configuration, so moving between
 *  "your account" and "this workspace" does not move the text. */
export const ACCOUNT_COLUMN = "w-full max-w-4xl mx-auto";
/** For a long list or a table that a reading column would squeeze. */
export const ACCOUNT_COLUMN_WIDE = "w-full max-w-6xl mx-auto";

/** Width is a pair, not a flag: choosing the wide column obliges you to say
 *  what needs the room. Modelled as a union so TypeScript refuses
 *  `width: "wide"` without a reason — the same shape Configuration uses,
 *  because "wide" started there as a judgement call and decayed into a
 *  default. A reason you have to type is a reason you have to have. */
type AccountWidth =
  | { width?: undefined; wideBecause?: never }
  | { width: "wide"; wideBecause: string };

export type AccountPage = { to: string } & AccountWidth;

/** Every page under /me, and how wide it reads. Longest path first is not
 *  required — the lookup below prefers the longest match, so /me does not
 *  swallow /me/activity. */
export const ACCOUNT_PAGES: AccountPage[] = [
  { to: "/me" },
  { to: "/me/connections" },
  { to: "/me/communication" },
  { to: "/me/notification-channels" },
  { to: "/me/app-settings" },
  { to: "/me/drive" },
  { to: "/me/feedback" },
  {
    to: "/me/activity",
    width: "wide",
    wideBecause: "a dense log: timestamp, actor, action and target on one line each, which wraps to three lines in the reading column",
  },
  {
    to: "/me/notifications",
    width: "wide",
    wideBecause: "a list of notifications with their own timestamps and per-row actions, read by scanning rather than by reading",
  },
];

/** The column for a path under /me. Longest declared prefix wins, so a nested
 *  route inherits its parent's choice instead of silently reverting. */
export function accountColumnFor(pathname: string): string {
  const hit = ACCOUNT_PAGES.filter(
    (p) => pathname === p.to || pathname.startsWith(`${p.to}/`),
  ).sort((a, b) => b.to.length - a.to.length)[0];
  return hit?.width === "wide" ? ACCOUNT_COLUMN_WIDE : ACCOUNT_COLUMN;
}
