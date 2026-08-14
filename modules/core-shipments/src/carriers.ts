// Which carrier is this, and where does a human go to look at it.
//
// Detection is by NUMBER FORMAT, and it is free: every carrier's numbers carry
// a check digit, so a well-formed number identifies its carrier without asking
// anyone. `ts-tracking-number` (ISC) owns the format table and validates the
// checksum, which is the part worth not hand-rolling — a regex that only
// matches "12 digits" calls a mistyped number FedEx, and then a poll fails
// against the wrong carrier with a message nobody can act on.
//
// This file adds the one thing detection does not carry: where the carrier
// shows the parcel to a person. That is a ROW per carrier, deliberately. A new
// carrier is a new entry in CARRIERS and nothing generic branches on the code.

import { getTracking } from "ts-tracking-number";

export interface CarrierMatch {
  /** Stable lowercase id: "fedex", "ups", "usps", … */
  code: string;
  /** The carrier's own name for itself, for display. */
  name: string;
  /** The number as the carrier writes it, whitespace and dashes removed. */
  number: string;
  /** The carrier's public tracking page for this number, when it has one. */
  trackingUrl: string | null;
}

/** Where to send a person to look at this parcel, and whose page that is.
 *
 *  Always present, even when nothing recognised the number. Somewhere to click
 *  is the whole value of the panel for anyone who has not connected a carrier,
 *  and a dead end is the one outcome not worth rendering. */
export interface TrackingLookup {
  url: string;
  /** Whose page: "FedEx", or the universal resolver's name. */
  via: string;
  /** True when this is the carrier's own page rather than a resolver. The
   *  carrier is authoritative; a resolver is a convenience, and the UI is
   *  allowed to say which one it is sending you to. */
  isCarrier: boolean;
}

/** One row per carrier: how to display it, and how to link a person to it.
 *
 *  `trackingUrl` is null where the carrier genuinely has no single public page.
 *  S10 is the honest case: it is an international postal *format* shared by
 *  dozens of national posts, so the destination depends on a country we do not
 *  know from the number alone. A null here surfaces as "no tracking page",
 *  never as a link that lands on someone else's 404. */
const CARRIERS: Record<string, { name: string; trackingUrl: ((n: string) => string) | null }> = {
  fedex: {
    name: "FedEx",
    trackingUrl: (n) => `https://www.fedex.com/fedextrack/?trknbr=${n}`,
  },
  ups: {
    name: "UPS",
    trackingUrl: (n) => `https://www.ups.com/track?tracknum=${n}`,
  },
  usps: {
    name: "USPS",
    trackingUrl: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`,
  },
  dhl: {
    name: "DHL",
    trackingUrl: (n) => `https://www.dhl.com/global-en/home/tracking.html?tracking-id=${n}`,
  },
  amazon: {
    name: "Amazon",
    trackingUrl: (n) => `https://track.amazon.com/tracking/${n}`,
  },
  ontrac: {
    name: "OnTrac",
    trackingUrl: (n) => `https://www.ontrac.com/tracking/?number=${n}`,
  },
  s10: {
    name: "International post",
    trackingUrl: null,
  },
};

/** The universal resolver: one page that takes any number from any carrier.
 *
 *  Used only as a FALLBACK, never in preference to a carrier's own page. A
 *  carrier is authoritative about its own parcel; a resolver is a third party
 *  reading the same data, so it can lag, and it is not who the user's contract
 *  is with.
 *
 *  This is a LINK, not a data source. The public page is used the way it is
 *  meant to be used, by a person clicking it, and nothing here reads their
 *  endpoints. That distinction is why this needs no account and raises no
 *  terms question, and it is the whole reason the fallback is a link at all.
 *  See docs/design-decisions/shipments.md. */
const UNIVERSAL = {
  name: "17TRACK",
  url: (n: string) => `https://www.17track.net/en/track?nums=${n}`,
};

/** The carriers this build can name, for the "what is supported" surface. */
export const knownCarriers = (): { code: string; name: string; hasTrackingPage: boolean }[] =>
  Object.entries(CARRIERS).map(([code, c]) => ({
    code,
    name: c.name,
    hasTrackingPage: c.trackingUrl !== null,
  }));

/** Identify a tracking number's carrier, or null when nothing recognises it.
 *
 *  Null is a normal answer, not a failure: plenty of real parcels arrive on a
 *  number from a carrier we have no format for, and an unrecognised number must
 *  stay exactly as the user typed it rather than being coerced into a guess. */
export function detectCarrier(raw: string): CarrierMatch | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const found = getTracking(trimmed);
  if (!found) return null;

  const code = found.courier.code;
  const known = CARRIERS[code];
  // A courier the detection table knows and this file does not: still a real
  // identification, so report it rather than dropping the parcel on the floor.
  const name = known?.name ?? found.courier.name;
  const number = found.trackingNumber;

  return {
    code,
    name,
    number,
    trackingUrl: known?.trackingUrl?.(encodeURIComponent(number)) ?? null,
  };
}

/** Somewhere to click, for any number at all.
 *
 *  Prefers the carrier's own page and falls back to the universal resolver, so
 *  the two cases that used to render a dead end now do not:
 *
 *    an S10 international number   recognised, but no single national post to
 *                                  send you to
 *    an unrecognised number        a real parcel on a format we have no table
 *                                  for, which is not the same as a bad number
 *
 *  Both had the tracking number sitting on screen next to nothing to do with
 *  it, which reads as "this feature does not work" rather than "we cannot name
 *  this carrier". */
export function trackingLookup(raw: string, match: CarrierMatch | null): TrackingLookup {
  if (match?.trackingUrl) {
    return { url: match.trackingUrl, via: match.name, isCarrier: true };
  }
  // The resolver takes the number as typed: there is no carrier to normalise it
  // for, and it does its own detection.
  const number = match?.number ?? raw.trim();
  return { url: UNIVERSAL.url(encodeURIComponent(number)), via: UNIVERSAL.name, isCarrier: false };
}
