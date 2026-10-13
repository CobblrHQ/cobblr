// The order an open session is, said where a phone can read it: "Order
// #36772", linked to the purchase it was filed on. The header carried the
// number beside the session's name, where a phone's width cut it off with the
// name ("Kingr…"), and nothing in the session opened its purchase (#6004).
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { openRecordPath } from "@cobblr/platform-contract/instance-detail";
import { MetaParts, distinctParts } from "../components/MetaParts";

/** "Order #36772", the number itself the link to its purchase (#6095: one
 *  line under the header, not a second line saying "Open the purchase"). */
export function SessionOrderRef({ orderRef, purchaseId }: { orderRef: string | null; purchaseId: string | null | undefined }) {
  if (!orderRef && !purchaseId) return null;
  const words = orderRef ? `Order #${orderRef}` : "This order";
  return (
    <span data-testid="session-order">
      {purchaseId ? (
        <Link to={openRecordPath("purchases:order", purchaseId)} title="Open the purchase" className="text-accent hover:underline" data-testid="session-order-purchase">
          {words}
        </Link>
      ) : (
        words
      )}
    </span>
  );
}

/** The line under a session's header: what Add means and which order it is,
 *  one line, joined so no separator is ever left hanging. */
export function SessionMetaLine({ parts }: { parts: ReadonlyArray<ReactNode | null | false | undefined> }) {
  if (!distinctParts(parts).length) return null;
  return (
    <div data-testid="session-meta-line" className="px-2.5 text-[11px] text-muted dark:text-slate-400">
      <MetaParts parts={parts} />
    </div>
  );
}
