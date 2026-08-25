// The inbound half of parcel tracking: a bridge PUSHES "this parcel moved".
//
// The bridge has sent `{ event: "tracker.updated", tracker }` since it first
// shipped — and nothing received it. There was a sender with no door, so the
// push silently no-oped and every update waited for the next polling window.
// The day that mattered, a parcel went out-for-delivery and delivered entirely
// between two windows, and nobody was told until the next morning.
//
// The push is a DOORBELL, not a data channel. Deliberately: the payload names
// a tracking number and nothing else is trusted from it. Whoever follows that
// number re-reads the status through the same authenticated action the sweeps
// use (`core-shipments:track`, force), so a forged or garbled push can cost at
// most one extra read — it cannot write a state, cannot invent a parcel, and
// cannot make anything up. That is also why this handler does not need to
// know what a receipt or an order is: it rings the bell, and the modules that
// own parcels answer it.
//
// Rides core-integrations' inbound door (/integrations/parcel-tracking/
// <token>/webhook): per-org token minted on the Integrations page, optional
// HMAC, audit row, hit counters — all inherited rather than rebuilt.

import { platform } from "@cobblr/platform-contract";

/** What a push must name to ring the bell. Everything else is ignored. */
export function trackingNumberOf(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as { event?: unknown; tracker?: { tracking_code?: unknown } };
  if (b.event !== "tracker.updated") return null;
  const code = b.tracker?.tracking_code;
  if (typeof code !== "string") return null;
  const trimmed = code.trim();
  // Tracking numbers are short. A kilobyte "number" is somebody probing.
  return trimmed.length > 0 && trimmed.length <= 64 ? trimmed : null;
}

export function registerParcelTrackingInbound(): void {
  platform().integrations.registerInboundHandler({
    id: "parcel-tracking",
    label: "Parcel tracking push (shipments bridge)",
    describeWebhookConfig: () => ({
      hmac_secret: { label: "HMAC verify secret (optional)", secret: true },
    }),
    emits: ["core-shipments.tracker.pushed"],
    handle: async (req, ctx) => {
      const number = trackingNumberOf(req.body);
      if (!number) {
        // An event type we do not handle is a 200: webhooks retry on errors,
        // and "not for me" is not an error. A body with no recognisable shape
        // at all is a 400, so a misconfigured sender finds out.
        const isOtherEvent =
          typeof req.body === "object" &&
          req.body !== null &&
          typeof (req.body as { event?: unknown }).event === "string";
        return isOtherEvent
          ? { status: 200, body: { ok: true, ignored: true } }
          : { status: 400, body: { error: "expected { event: \"tracker.updated\", tracker: { tracking_code } }" } };
      }

      await ctx.emit("core-shipments.tracker.pushed", {
        orgId: ctx.orgId,
        tracking_number: number,
      });
      return { status: 200, body: { ok: true } };
    },
  });
}
