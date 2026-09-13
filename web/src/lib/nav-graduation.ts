// When the top bar stops fitting: the default layout, and how a person is
// offered the sidebar without ever having it forced on them.
//
// The rule that governs all of it: A LAYOUT NEVER CHANGES WITHOUT A CLICK.
// Nothing in the app writes one on its own, not on load, not when a module
// is enabled, not because a workspace is big. The person who has never said
// gets the top bar, and the first time it folds something they did not pin
// they are offered the sidebar, once, as a question; either answer is their
// layout from then on. (A "big workspace starts in the sidebar" rule shipped
// for a few hours and was removed: it re-fired when a sixth module was
// enabled mid-session, and it would have moved every existing never-chosen
// desktop on the first load after it shipped.)
// docs/design-decisions/nav-graduation.md.

import type { NavPref } from "./nav-mode";

/** Has this person said which layout they want, anywhere? The account is
 *  the record; the local key is a choice made on this device that may not
 *  have synced yet (or was made while signed out of sync). Either counts:
 *  offering a layout to someone who has picked one is the nag this exists to
 *  prevent. */
export function layoutExpressed(accountPref: NavPref | null | undefined, localChoice: boolean): boolean {
  return accountPref != null || localChoice;
}

/** The top bar folded something the person did NOT pin. Entries pinned to
 *  More are voluntary and never count: they are the person shaping the bar,
 *  not the bar running out of room. A row that measured ZERO wide is not on
 *  screen at all (the desktop nav is display:none on a phone), and a fold it
 *  reports is a fold of nothing: it offered the sidebar on a phone once. */
export function isInvoluntaryFold(visibleCount: number, rowEligibleCount: number, rowWidth: number): boolean {
  return rowWidth > 0 && visibleCount < rowEligibleCount;
}

/** Show the one-time "switch to the sidebar?" offer. The only graduation
 *  path there is. Not while another surface is asking the same question
 *  (the tour's welcome step): a fresh account at a narrow window got both
 *  cards at once, and the fold is still there when the tour closes. */
export function shouldOfferSidebar(args: {
  expressed: boolean;
  involuntaryFold: boolean;
  otherSurfaceAsking?: boolean;
}): boolean {
  return !args.expressed && args.involuntaryFold && !args.otherSurfaceAsking;
}
