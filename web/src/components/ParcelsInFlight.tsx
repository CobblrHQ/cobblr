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
  state: string | null;
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
        what: g.vendor ? `${g.vendor} order` : "A receipt",
        state: g.shipmentState,
        where: g.shipmentLocation,
        to: "/scan",
        unfiled: true,
      })),
    ...(orders.data?.items ?? [])
      // A tracking number and not yet taken in. `arrived_at` is the person's
      // own confirmation, so an order they have closed drops off here even if
      // the carrier is still talking about it.
      .filter((o) => !!o.tracking_number && !o.arrived_at && o.status !== "cancelled")
      .map((o) => ({
        key: `o:${o.id}`,
        what: o.vendor ? `${o.vendor} order` : (o.order_number ?? "An order"),
        state: o.shipment_state,
        where: null,
        to: "/purchases",
        unfiled: false,
      })),
  ].sort((a, b) => (URGENCY[a.state ?? "unknown"] ?? 9) - (URGENCY[b.state ?? "unknown"] ?? 9));

  if (parcels.length === 0) return null;

  const landed = parcels.filter((p) => p.state === "delivered").length;

  return (
    // Deliberately spare. A dashboard box earns its space by being scannable,
    // and an early version with card padding and a nested bordered list ate a
    // whole band of the page to say three short things. No outer card: a header
    // line and the rows.
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 px-0.5">
        <div className="text-[10px] font-mono uppercase tracking-widest text-accent">// on its way</div>
        {/* The count that matters is the one you can act on, so it leads. */}
        {landed > 0 && (
          <div className="text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
            {landed} {landed === 1 ? "has" : "have"} landed
          </div>
        )}
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
              className="flex items-center gap-2 px-2.5 py-1.5 text-[13px] whitespace-nowrap hover:bg-subtle dark:hover:bg-slate-800/60"
            >
              {delivered ? (
                <PackageCheck size={15} className="text-emerald-600 dark:text-emerald-400 shrink-0" aria-hidden />
              ) : (
                <Truck size={15} className="text-faint shrink-0" aria-hidden />
              )}
              <span className="font-medium text-content dark:text-mortar-100 truncate min-w-0">{p.what}</span>
              <span
                className={`text-xs shrink-0 ${
                  delivered ? "text-emerald-600 dark:text-emerald-400 font-medium" : "text-muted"
                }`}
              >
                {p.state ? (LABEL[p.state] ?? p.state) : "Not checked yet"}
              </span>
              {p.where && (
                <span className="text-[11px] text-faint truncate min-w-0 hidden sm:inline">· {p.where}</span>
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
