// The rule for what the image-search box SHOWS. Pulled out of the component so
// it can be asserted directly — the bug it prevents is a UI-state bug, and a
// screenshot is the only other way to catch it.
//
// The bug: the box was left empty with the derived phrase only as a greyed-out
// placeholder. The user then cannot see what was actually searched, so they
// cannot tell a bad phrase from a bad web (reported 2026-07-18: "should not be
// blank, it should start with the search term pre-filled in"). A placeholder is
// a hint; this is data, and data goes in the value.
//
// The rule: mirror what was searched into the box until the user types, then
// leave their text alone — a mirror that keeps overwriting mid-edit is worse
// than a blank box.

export function nextTerm(state: {
  /** What the search actually ran with (server-derived, or the applied term). */
  searched: string;
  /** What's in the box right now. */
  term: string;
  /** Has the user edited the box? */
  touched: boolean;
}): string {
  const { searched, term, touched } = state;
  if (touched) return term; // never fight the user's cursor
  if (!searched) return term; // nothing searched yet — don't blank an existing value
  return searched;
}
