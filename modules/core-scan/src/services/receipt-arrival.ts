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

/** The order fields that depend on whether the parcel is still coming. */
export interface ArrivalFiling {
  tracking_number: string | undefined;
  arrived_at: string | undefined;
  status: "in-transit" | "arrived";
}

export function fileReceiptAs(
  trackingNumber: string | null,
  /** Null when the receipt never stated a date, in which case there is no
   *  honest arrival date to claim either. */
  orderedAt: string | null,
): ArrivalFiling {
  const tracking = (trackingNumber ?? "").trim();
  if (!tracking) {
    // Unchanged, and the common case: already in hand when the receipt arrived.
    return { tracking_number: undefined, arrived_at: orderedAt ?? undefined, status: "arrived" };
  }
  return {
    tracking_number: tracking,
    // Deliberately absent rather than the order date: stamping arrival from the
    // purchase date puts a parcel in your hands days before the carrier has it.
    arrived_at: undefined,
    status: "in-transit",
  };
}
