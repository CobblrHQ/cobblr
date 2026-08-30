// What is on its way to you, on the dashboard.
//
// Tracking answered "where is it" in two places and neither was the one you
// look at first: a row on the scan inbox, and a panel inside one order. So the
// only way to learn a parcel had landed was a notification you might have
// missed, or going looking for something you had no reason to think had moved.
//
// NOT the Live box. That surface is for ongoing session modes — things you are
// actively driving this second, where the toggle IS the control. A parcel moves
// on a carrier's schedule over days; it is news, not a mode.
//
// Self-hiding: nothing in flight, nothing rendered. A permanent empty
// "Deliveries" box on a dashboard teaches people to stop reading that spot.
//
// Both sources, because a parcel is followed whether or not the receipt has
// been filed (that was the whole point of the inbox sweeper): unfiled receipts
// from core-scan, filed orders from purchases. Merging them here is the web
// app's job — neither module may read the other's tables.

import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { PackageCheck, Truck } from "lucide-react";
import { api } from "../lib/api";
import { trimEcho } from "../lib/parcelDetail";

/** The carrier vocabulary in words a person uses. */
const LABEL: Record<string, string> = {
  pre_transit: "Label created",
  in_transit: "In transit",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  exception: "Needs attention",
  unknown: "No information yet",
};

/** Sort key: what needs doing first. Delivered is top because it is the only
 *  one with an action attached — go and get it, then say you have it. */
const URGENCY: Record<string, number> = {
  delivered: 0,
  exception: 1,
  out_for_delivery: 2,
  in_transit: 3,
  pre_transit: 4,
  unknown: 5,
};

interface Parcel {
  key: string;
  what: string;
  /** How many things are in it. Shown only past one — "1 item" beside a named
   *  row is noise, since the name already IS the one item. */
  count: number | null;
  /** Vendor and order number, when the row is led by an item name instead. */
  from: string | null;
  state: string | null;
  /** The carrier's own wording ("Left at garage"), which is more specific than
   *  our six states and is usually the sentence a person actually wants. */
  detail: string | null;
  /** Where the carrier SCANNED it, which is not the same as where it is.
   *  Reads correctly in transit ("it got as far as Perrysburg") and misleads
   *  once delivered, where it is usually the station that ran the route rather
   *  than the address — so it is suppressed there. See the render. */
  where: string | null;
  /** Where the next action lives: the inbox for a receipt, the order for one
   *  already filed. */
  to: string;
  /** Still sitting in the scan inbox rather than filed into an order. */
  unfiled: boolean;
}

export function ParcelsInFlight({ slug }: { slug: string }): React.ReactElement | null {
  // Both lists are already fetched elsewhere in the app, so these mostly hit
  // the query cache. Kept separate so one module being disabled or erroring
  // cannot take the other's parcels off the board.
  const receipts = useQuery({
    queryKey: ["scan-receipt-groups", slug],
    queryFn: () => api.getPendingReceiptGroups(slug),
    staleTime: 60_000,
  });
  const orders = useQuery({
    queryKey: ["orders", slug],
    queryFn: () => api.listOrders(slug),
    staleTime: 60_000,
  });

  const parcels: Parcel[] = [
    ...(receipts.data?.groups ?? [])
      .filter((g) => !!g.trackingNumber)
      .map((g) => ({
        key: `r:${g.groupId}`,
        // What you were waiting for, when the receipt is a single line: the
        // thing's own name beats any reference. A multi-line receipt has no
        // one name, so it falls back to vendor + number, which is what you
        // would search for anyway and tells two same-vendor orders apart.
        what:
          g.onlyItemName?.trim() ||
          [g.vendor, g.orderRef ? `#${g.orderRef}` : null].filter(Boolean).join(" ") ||
          "A receipt",
        count: g.count ?? null,
        from: g.onlyItemName?.trim()
          ? [g.vendor, g.orderRef ? `#${g.orderRef}` : null].filter(Boolean).join(" ") || null
          : null,
        state: g.shipmentState,
        detail: g.shipmentDescription,
        where: g.shipmentLocation,
        // The receipt itself. A row that names one parcel and drops you on a
        // page of thirty has made you do the finding twice.
        to: g.batchId ? `/scan?batch=${g.batchId}` : "/scan",
        unfiled: true,
      })),
    ...(orders.data?.items ?? [])
      // A tracking number and not yet taken in. `arrived_at` is the person's
      // own confirmation, so an order they have closed drops off here even if
      // the carrier is still talking about it.
      .filter((o) => !!o.tracking_number && !o.arrived_at && o.status !== "cancelled")
      .map((o) => ({
        key: `o:${o.id}`,
        what:
          [o.vendor, o.order_number ? `#${o.order_number}` : null].filter(Boolean).join(" ") || "An order",
        count: o.item_count ?? null,
        from: null,
        state: o.shipment_state,
        detail: null,
        where: null,
        // The anchor, not the page — PurchasesPage renders an id per order.
        to: `/purchases#order-${o.id}`,
        unfiled: false,
      })),
  ].sort((a, b) => (URGENCY[a.state ?? "unknown"] ?? 9) - (URGENCY[b.state ?? "unknown"] ?? 9));

  if (parcels.length === 0) return null;

  return (
    // Deliberately spare. A dashboard box earns its space by being scannable,
    // and an early version with card padding and a nested bordered list ate a
    // whole band of the page to say three short things. No outer card: a header
    // line and the rows.
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 px-0.5">
        {/* No count beside this. Every row already says its own state, and a
            box that self-hides is never long enough for a tally to tell you
            something the rows do not. */}
        <div className="text-[10px] font-mono uppercase tracking-widest text-accent">// on its way</div>
      </div>

      <div className="divide-y divide-line dark:divide-slate-800 border border-line dark:border-slate-700 rounded-lg overflow-hidden bg-surface dark:bg-slate-900">
        {parcels.map((p) => {
          const delivered = p.state === "delivered";
          return (
            <Link
              key={p.key}
              to={p.to}
              // One row per order, always: min-w-0 + truncate on the flexible
              // parts, nowrap on the rest. A parcel that wrapped to two lines
              // would make the box grow exactly when there is most to show.
              className="flex items-start sm:items-center gap-2 px-2.5 py-1.5 text-[13px] sm:whitespace-nowrap hover:bg-subtle dark:hover:bg-slate-800/60"
            >
              {delivered ? (
                <PackageCheck size={15} className="text-emerald-600 dark:text-emerald-400 shrink-0" aria-hidden />
              ) : (
                <Truck size={15} className="text-faint shrink-0" aria-hidden />
              )}
              {/* NOT shrink-0. The name is the row's identity and the most
                  flexible thing in it - the comment above has said so since
                  this shipped, and the class said the opposite, so the card's
                  overflow-hidden cut the name mid-word with no ellipsis
                  ("Front & Rear Drilled Brake Rotors & Pads Kit (2016-2",
                  reported 2026-08-30).

                  Two lines on a phone rather than an ellipsis: a truncated
                  parcel name is worse than a wrapped one for the only question
                  the row answers, WHICH parcel. One line from sm up, where the
                  width makes that free. */}
              <span className="font-medium text-content dark:text-mortar-100 min-w-0 line-clamp-2 sm:truncate">
                {p.what}
              </span>
              {/* What is in it. Two orders from the same vendor are otherwise
                  the same row twice. */}
              {/* The order it came from, once the name has taken the lead.
                  Without this a named row loses the vendor entirely. */}
              {p.from && <span className="text-[11px] text-faint shrink-0 hidden sm:inline">{p.from}</span>}
              {p.count != null && p.count > 1 && (
                <span className="text-[11px] text-faint shrink-0 hidden sm:inline">{p.count} items</span>
              )}
              <span
                className={`text-xs shrink-0 ${
                  delivered ? "text-emerald-600 dark:text-emerald-400 font-medium" : "text-muted"
                }`}
              >
                {p.state ? (LABEL[p.state] ?? p.state) : "Not checked yet"}
              </span>
              {/* The carrier's sentence, then the place. These are what the row
                  was missing: "Delivered" alone does not tell you it is sitting
                  in the garage. Truncated so the row stays one line. */}
              {/* Carriers lead the sentence with the state they just reported
                  ("Delivered, Left at garage"), which we have already shown.
                  Drop the echo and keep the part that adds something. */}
              {(() => {
                const label = p.state ? (LABEL[p.state] ?? p.state) : "";
                const extra = trimEcho(p.detail, label);
                return extra ? (
                  <span className="text-[11px] text-muted truncate min-w-0 hidden sm:inline">{extra}</span>
                ) : null;
              })()}
              {/* Not once it has landed: a delivery scan's location is usually
                  the carrier's own station, so "Delivered · DOVER, NJ" reads as
                  a claim about where the parcel is that we cannot support. The
                  description ("Left at garage") is the part that is about your
                  address, and it stays. In transit the same string is honest
                  and useful — it is how far it has got. */}
              {p.where && !delivered && (
                <span className="text-[11px] text-faint truncate min-w-0 hidden md:inline">· {p.where}</span>
              )}
              <span className="flex-1" />
              {/* Says what to DO, which is the difference between a status board
                  and a to-do list. A delivered parcel still in the inbox needs
                  filing; one already filed needs confirming. */}
              {delivered && (
                <span className="text-[11px] text-accent shrink-0">
                  {p.unfiled ? "File it →" : "Confirm →"}
                </span>
              )}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
