// What a parcel's state is, in Cobblr's words rather than a carrier's.
//
// Every carrier has its own status vocabulary, and they do not agree: FedEx
// says `DL`, UPS says `D`, USPS writes a sentence. If the sweep read carrier
// codes it would grow a branch per carrier and the second driver would be a
// rewrite. So a driver's whole job is to answer in THIS vocabulary, and the
// only thing that ever sees a carrier's own words is the driver that speaks
// them, plus `description`, which we pass through verbatim for display.

/** The states a parcel can be in, as far as anything outside a driver cares.
 *
 *  Deliberately coarse. The question the rest of the system asks is "is it
 *  here yet, and should I keep looking?" — not which sorting facility it left
 *  at 3am. Detail lives in `events` and in `description`, which are for a
 *  human to read, never for code to branch on. */
export const SHIPMENT_STATES = [
  /** The carrier knows about it but has not got it yet (label made). */
  "pre_transit",
  "in_transit",
  "out_for_delivery",
  "delivered",
  /** Something went wrong that a person may need to act on: refused, damaged,
   *  held at customs, address problem. */
  "exception",
  /** The carrier has no information for this number. Normal for the first
   *  hours after a label is bought, and permanent for a number that was
   *  mistyped past its own check digit or belongs to another carrier. */
  "unknown",
] as const;

export type ShipmentState = (typeof SHIPMENT_STATES)[number];

export interface ShipmentEvent {
  /** ISO 8601, as the carrier reported it, including their offset. */
  at: string;
  /** The carrier's own wording. Shown, never parsed. */
  description: string;
  /** "GREENWOOD, IN" — assembled by the driver, null when not given. */
  location: string | null;
}

export interface ShipmentStatus {
  carrier: string;
  number: string;
  state: ShipmentState;
  /** The carrier's own words for the state. Shown to a person as the honest
   *  detail behind our coarse `state`. */
  description: string;
  location: string | null;
  /** ISO date the carrier expects to deliver, when it says. */
  estimatedDelivery: string | null;
  /** ISO timestamp of actual delivery. Set if and only if state is delivered. */
  deliveredAt: string | null;
  /** Newest first. */
  events: ShipmentEvent[];
  /** When we asked. */
  checkedAt: string;
}

/** A carrier integration. One file per carrier, and nothing generic branches
 *  on `code` — the registry looks a driver up by it, which is the difference
 *  between a table and a switch statement. */
export interface CarrierDriver {
  /** Matches the code `detectCarrier` returns, which is how they are joined. */
  code: string;
  /** False when this deployment has no credentials for the carrier. A driver
   *  that cannot be configured is not an error: most installs will connect one
   *  carrier and never the rest. */
  configured(): boolean;
  /** `carrierCode` matters only to a driver that serves more than one carrier.
   *  `orgId` is only needed to route to a workspace's edge bridge, when the
   *  endpoint lives on the user's own network rather than the public internet. */
  track(number: string, carrierCode?: string, orgId?: string): Promise<ShipmentStatus>;
}

/** Thrown when a carrier answered, and the answer was a failure.
 *
 *  Separate from a network error on purpose. The sweep must be able to tell
 *  "the carrier says this number is bad" (stop asking) from "the carrier did
 *  not answer" (ask again later), and treating either as delivery would mark
 *  an order arrived that is still in a truck. */
export class CarrierError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "CarrierError";
  }
}
