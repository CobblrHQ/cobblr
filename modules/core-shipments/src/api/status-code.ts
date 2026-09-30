// The HTTP status /status answers a reason the track action decided with.
//
// Every one of them is an ANSWER about the parcel (not connected, not due, the
// service is full, the carrier did not answer just now), and the panel reads
// its reason to say which. Answered as 502 or 507, the web client took them
// for a failed request and the panel never saw a reason: "at capacity" could
// not be shown. Only a throw from the action itself is a failure (the route's
// catch answers that one 502).
export function statusCodeFor(_reason: string): number {
  return 200;
}
