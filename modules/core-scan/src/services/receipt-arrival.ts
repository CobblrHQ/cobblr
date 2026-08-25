// Has this receipt's purchase actually landed?
//
// A receipt says the PURCHASE happened. It says nothing about the DELIVERY, and
// those are the same moment only when you carried the thing out of a shop.
// Filing every receipt as `arrived` was right for a shop counter and wrong for
// anything that ships.
//
// A tracking number is the evidence that they are different moments: nobody
// issues one for something already in your hands.
//
// This is its own function because the consequence is invisible at the call
// site. The arrival sweep selects `status not in ('arrived','cancelled')`, so an
// order filed arrived is never polled again — recording a tracking number on one
// looks like it worked and follows nothing.

/** What the inbox already learned about the parcel, if anything. The inbox
 *  follows its own tracked receipts, so by filing time this is often several
 *  carrier answers old. */
export interface KnownShipment {
  state: string | null;
  checkedAt: Date | string | null;
  nextPollAt: Date | string | null;
  location: string | null;
}

/** The order fields that depend on whether the parcel is still coming. */
export interface ArrivalFiling {
  tracking_number: string | undefined;
  arrived_at: string | undefined;
  status: "in-transit" | "arrived";
  /** Carried over from the inbox so the order continues the watch rather than
   *  restarting it. Absent when the inbox never got an answer. */
  shipment_state?: string;
  shipment_checked_at?: string;
  shipment_next_poll_at?: string;
}

const iso = (v: Date | string | null): string | undefined => {
  if (!v) return undefined;
  return v instanceof Date ? v.toISOString() : v;
};

export function fileReceiptAs(
  trackingNumber: string | null,
  /** Null when the receipt never stated a date, in which case there is no
   *  honest arrival date to claim either. */
  orderedAt: string | null,
  /** What the inbox already knows. Omitted by callers that never tracked. */
  known?: KnownShipment | null,
  /** The receipt's own promised date ("arriving August 26"), when it stated
   *  one. A promise still in the future is the same evidence a tracking number
   *  is: nobody promises a delivery date for something already in your hands. */
  expectedArrival?: string | null,
  /** The day that has arrived everywhere on earth - passed in so this stays a
   *  pure function a test can pin. */
  today?: string,
): ArrivalFiling {
  const tracking = (trackingNumber ?? "").trim();
  if (!tracking) {
    // A future promised date means the parcel is still coming even without a
    // number yet. Orders born at parse time always land here (nobody has had a
    // chance to type a number), and filing them 'arrived' put EVERY receipt
    // order outside the arrival sweep's selection forever - the "was due
    // today, did it turn up?" ask was structurally dead (2026-08-25 audit).
    if (expectedArrival && today && expectedArrival >= today) {
      return { tracking_number: undefined, arrived_at: undefined, status: "in-transit" };
    }
    // Unchanged, and the common case: already in hand when the receipt arrived.
    return { tracking_number: undefined, arrived_at: orderedAt ?? undefined, status: "arrived" };
  }

  // Hand the watch over rather than starting a new one. Without this the order
  // opens at "no information" and re-asks the carrier immediately, which is a
  // wasted call on a metered service and a visible step backwards on screen:
  // a parcel the inbox had followed to PERRYSBURG reverted to knowing nothing.
  const state = known?.state ?? null;

  // A parcel the carrier already delivered is still not ARRIVED — only the
  // person who took it in can say that, and filing the receipt is not the same
  // act as putting the thing away. So a delivered parcel stays in-transit here
  // and the arrival question gets asked, exactly as it would have been.
  return {
    tracking_number: tracking,
    // Deliberately absent rather than the order date: stamping arrival from the
    // purchase date puts a parcel in your hands days before the carrier has it.
    arrived_at: undefined,
    status: "in-transit",
    ...(state ? { shipment_state: state } : {}),
    ...(iso(known?.checkedAt ?? null) ? { shipment_checked_at: iso(known!.checkedAt) } : {}),
    ...(iso(known?.nextPollAt ?? null) ? { shipment_next_poll_at: iso(known!.nextPollAt) } : {}),
  };
}
