// Shipment — where the parcel is. Contributed by core-shipments onto
// purchases:order through the panel seam, so the purchases page never names
// core-shipments and a workspace without the capability sees nothing.
//
// Renders NOTHING for an order with no tracking number. Most orders never get
// one, and an empty "no shipment" box on every order would be noise on the
// majority to serve the minority.
//
// Two questions, asked separately on purpose. WHICH CARRIER is free, instant
// and cannot fail, so it renders immediately. WHERE IS IT costs a call to the
// carrier and can fail or be unavailable, so it fills in after, and its
// absence never blocks the carrier line or the tracking link.

import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Truck, HelpCircle, PackageCheck, PackageX, Loader2 } from "lucide-react";
import { api, type ShipmentState, type TrackingLookup } from "../../lib/api";
import type { EntityDetailPanelCtx } from "../../panels/types";

/** How each state reads and looks. A row per state, so a new state is a row.
 *  Delivered is the only good news and the only green; an exception is the
 *  only one that wants a person, and is the only amber. */
const STATE_STYLE: Record<ShipmentState, { label: string; tone: string; Icon: typeof Truck }> = {
  pre_transit: { label: "Label created", tone: "text-muted bg-subtle dark:bg-slate-800", Icon: Truck },
  in_transit: { label: "In transit", tone: "text-muted bg-subtle dark:bg-slate-800", Icon: Truck },
  out_for_delivery: {
    label: "Out for delivery",
    tone: "text-cobble-700 dark:text-cobble-300 bg-cobble-500/10",
    Icon: Truck,
  },
  delivered: {
    label: "Delivered",
    tone: "text-emerald-700 dark:text-emerald-400 bg-emerald-500/10",
    Icon: PackageCheck,
  },
  exception: {
    label: "Needs attention",
    tone: "text-amber-700 dark:text-amber-400 bg-amber-500/10",
    Icon: PackageX,
  },
  unknown: { label: "No information yet", tone: "text-muted bg-subtle dark:bg-slate-800", Icon: HelpCircle },
};

function day(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** The one thing this panel must always offer: somewhere to click.
 *
 *  Says whose page it is, so "Track on FedEx" and "Look it up on 17TRACK" are
 *  visibly different promises. The carrier is authoritative about its own
 *  parcel; a resolver is a third party reading the same data. */
function LookupLink({ lookup }: { lookup: TrackingLookup }) {
  return (
    <a
      href={lookup.url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
    >
      {lookup.isCarrier ? `Track on ${lookup.via}` : `Look it up on ${lookup.via}`}
      <ExternalLink size={12} aria-hidden />
    </a>
  );
}

export function ShipmentPanel({ ctx }: { ctx: EntityDetailPanelCtx }) {
  const number = ctx.hints?.tracking_number?.trim() ?? "";

  const carrierQ = useQuery({
    queryKey: ["shipment-carrier", ctx.slug, number],
    queryFn: () => api.shipmentCarrier(ctx.slug, number),
    enabled: number.length > 0,
    // The answer is a pure function of the number: it cannot go stale.
    staleTime: Infinity,
  });

  const carrier = carrierQ.data?.carrier ?? null;
  const lookup = carrierQ.data?.lookup ?? null;

  const statusQ = useQuery({
    queryKey: ["shipment-status", ctx.slug, number],
    queryFn: () => api.shipmentStatus(ctx.slug, number),
    // Only worth asking once we know somebody recognises the number.
    enabled: !!carrier,
    // A parcel moves a few times a day; re-asking on every modal open spends a
    // carrier call to tell you the same thing.
    staleTime: 15 * 60_000,
    retry: false,
  });

  if (!number) return null;

  const head = "text-[10px] font-mono uppercase tracking-widest text-accent";
  const status = statusQ.data?.status ?? null;
  const style = status ? STATE_STYLE[status.state] : null;

  return (
    <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-3">
      <div className={head}>// shipment</div>

      {carrierQ.isLoading ? (
        <div className="text-xs text-faint italic" aria-busy="true">
          identifying carrier…
        </div>
      ) : carrier ? (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium bg-subtle dark:bg-slate-800 text-content dark:text-mortar-100">
              <Truck size={13} aria-hidden />
              {carrier.name}
            </span>
            <span className="font-mono text-sm text-content dark:text-mortar-100 break-all">{carrier.number}</span>
            {lookup && <LookupLink lookup={lookup} />}
          </div>

          {statusQ.isLoading && (
            <div className="flex items-center gap-1.5 text-xs text-faint italic" aria-busy="true">
              <Loader2 size={12} className="animate-spin" aria-hidden />
              asking {carrier.name}…
            </div>
          )}

          {status && style && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                <span className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium ${style.tone}`}>
                  <style.Icon size={13} aria-hidden />
                  {style.label}
                </span>
                {/* The carrier's own words, which are always more specific than
                    our coarse state ("Left at front door" beats "Delivered"). */}
                {status.description && status.description !== style.label && (
                  <span className="text-xs text-muted">{status.description}</span>
                )}
                {status.location && <span className="text-xs text-faint">· {status.location}</span>}
              </div>

              {status.state !== "delivered" && day(status.estimatedDelivery) && (
                <div className="text-xs text-muted">Expected {day(status.estimatedDelivery)}</div>
              )}
              {status.deliveredAt && (
                <div className="text-xs text-muted">Delivered {when(status.deliveredAt)}</div>
              )}

              {status.events.length > 0 && (
                <details className="group">
                  <summary className="cursor-pointer text-[11px] text-faint hover:text-muted list-none">
                    {status.events.length} scan{status.events.length === 1 ? "" : "s"} ·
                    <span className="group-open:hidden"> show</span>
                    <span className="hidden group-open:inline"> hide</span>
                  </summary>
                  <div className="mt-2 divide-y divide-line dark:divide-slate-800 border border-line dark:border-slate-800 rounded-lg overflow-hidden">
                    {status.events.map((e, i) => (
                      <div key={`${e.at}-${i}`} className="flex items-baseline justify-between gap-2 px-2.5 py-1.5 text-xs">
                        <span className="text-faint shrink-0 font-mono">{when(e.at)}</span>
                        <span className="flex-1 min-w-0 text-content dark:text-mortar-100">{e.description}</span>
                        {e.location && <span className="text-faint shrink-0">{e.location}</span>}
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          )}

          {/* Why there is no status. Each reason is a different thing to do, so
              none of them may render as silence. */}
          {!statusQ.isLoading && !status && (
            <div className="text-[11px] text-faint">
              {statusQ.data?.reason === "quota_exhausted"
                ? "Your tracking service is at capacity, so Cobblr could not start following this parcel. The link above still works."
                : statusQ.data?.reason === "not_connected"
                ? `${carrier.name} is not connected here, so Cobblr cannot follow this parcel. The link above still works.`
                : statusQ.data?.reason === "no_driver"
                  ? `Cobblr cannot follow ${carrier.name} parcels yet. The link above still works.`
                  : `${carrier.name} did not answer just now. The link above still works.`}
            </div>
          )}
        </>
      ) : (
        // Not recognised is a statement about the number, not a failure. Say so
        // plainly and keep showing what they typed, so a typo is visible and a
        // genuinely unsupported carrier doesn't read as a broken feature.
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="inline-flex items-center gap-1.5 text-xs text-muted">
              <HelpCircle size={13} aria-hidden />
              No carrier recognised this number.
            </span>
            <span className="font-mono text-sm text-content dark:text-mortar-100 break-all">{number}</span>
            {/* The number is still a real parcel. A resolver takes any format,
                so an unnamed carrier is no reason to leave a dead end here. */}
            {lookup && <LookupLink lookup={lookup} />}
          </div>
          <div className="text-[11px] text-faint">
            Cobblr identifies FedEx, UPS, USPS, DHL, Amazon and OnTrac numbers. If yours is not one of those, the link
            above searches every carrier. If it should be, check for a typo.
          </div>
        </div>
      )}
    </div>
  );
}
