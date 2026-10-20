// A row or card that opens its record on a tap, and holds controls of its own
// (the name's link, a checkbox, an edit cell): one tap does one thing (#7600).
//
// The Inventory list's row navigated on click and its name was a <Link> to
// the same record, so a tap on the name navigated twice: two history entries
// for one record, and Close or Back left the record open. A tap that started
// on a control inside the row is that control's; the row opens only on the
// rest of its face.
//
//   <tr onClick={rowOpen(() => navigate(href))}>…<Link to={href}>name</Link>…</tr>
import type { MouseEvent } from "react";

/** The controls inside a row that own their own tap. */
export const ROW_OWN_CONTROLS = "a, button, input, select, textarea, label, [role='button'], [role='checkbox'], [role='link']";

/** An onClick for a row that opens something: it runs `open` unless the tap
 *  was already handled or started on a control inside the row. */
export function rowOpen(open: () => void) {
  return (e: MouseEvent<HTMLElement>) => {
    if (e.defaultPrevented) return;
    const own = (e.target as Element | null)?.closest?.(ROW_OWN_CONTROLS);
    if (own && own !== e.currentTarget && e.currentTarget.contains(own)) return;
    open();
  };
}
