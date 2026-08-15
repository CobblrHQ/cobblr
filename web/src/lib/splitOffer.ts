/** Should the card offer to split this item into several?
 *
 *  The observation pass counts the distinct things in frame for EVERY item that
 *  has a photo, and the offer used to appear whenever that count was 2 or more.
 *  On a barcode scan that is the wrong question. The camera took that photo
 *  automatically, at whatever the barcode happened to be lying on, so a second
 *  "item" in it is usually the bench: a monitor behind the label, a jar of
 *  something next to the one being scanned (reported 2026-08-14, twice).
 *
 *  The distinction is not how many things are visible. It is whether the PHOTO
 *  WAS THE POINT. When someone deliberately photographs a group, splitting is
 *  the feature. When they scanned a barcode and a photo came along with it, the
 *  barcode names one product and the rest of the frame is background.
 *
 *  The observation pass still runs on both — it is paid for either way and its
 *  count corroborates a multipack — so this gates the OFFER, not the work. */

export interface SplitOfferInput {
  /** `photo_distinct` from the observation pass. */
  distinct: number | null | undefined;
  /** The item carries a scanned barcode, so its photo is incidental. */
  hasBarcode: boolean;
  /** The user already said to keep it as one. */
  keepGrouped: boolean;
  /** This row is itself the result of a split, or has already been split. */
  alreadySplit: boolean;
  /** Anything the user has finished with is not worth an offer. */
  status: string | null | undefined;
}

export function shouldOfferSplit(x: SplitOfferInput): boolean {
  if (!x.distinct || x.distinct < 2) return false;
  if (x.hasBarcode) return false;
  if (x.keepGrouped || x.alreadySplit) return false;
  return x.status === "pending";
}
