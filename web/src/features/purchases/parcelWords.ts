// How a parcel reads to a person, in one place (#5351): an order's line, the
// record it becomes and the scan inbox row all say it the same way.
//
//   "On its way: Amazon Logistics TBA335321582286, expected Oct 11"
//   "Out for delivery: Amazon Logistics TBA335321582286"
//   "Not shipped yet"
//   "On its way, no date yet"            (an online order nobody has a day for)
import { dayLabel } from "@cobblr/platform-contract/day";

const STATE_WORDS: Record<string, string> = {
  pre_transit: "Label made",
  in_transit: "On its way",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  exception: "Delivery problem",
};

export interface ParcelFacts {
  tracking_number: string | null;
  carrier_name?: string | null;
  shipment_state?: string | null;
  expected_arrival?: string | null;
}

/** "Oct 11" for an ISO day; the day as written when it is not one. */
export function shortDay(iso: string): string {
  return dayLabel(iso, { month: "short", day: "numeric" }, "en-US");
}

export function parcelWords(p: ParcelFacts | null): string {
  if (!p || !p.tracking_number) {
    return p?.expected_arrival ? `On its way, expected ${shortDay(p.expected_arrival)}` : p ? "On its way, no date yet" : "Not shipped yet";
  }
  const state = STATE_WORDS[p.shipment_state ?? ""] ?? "On its way";
  const number = [p.carrier_name, p.tracking_number].filter(Boolean).join(" ");
  const due = p.expected_arrival && p.shipment_state !== "delivered" ? `, expected ${shortDay(p.expected_arrival)}` : "";
  return `${state}: ${number}${due}`;
}
