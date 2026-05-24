// Generic inbound webhook handler. Accepts any POST, optionally
// verifies HMAC signature against a per-token secret, and emits
// `core-integrations.inbound.received` with the parsed body.
//
// More specialised inbound handlers (Stripe, GitHub, Twilio) follow
// the same shape but verify signatures their way.

import { platform } from "@cobblr/platform-contract";

export function register(): void {
  platform().integrations.registerInboundHandler({
    id: "webhook",
    label: "Generic inbound webhook",
    describeWebhookConfig: () => ({
      hmac_secret: { label: "HMAC verify secret (optional)", secret: true },
      signature_header: { label: "Signature header (default x-cobblr-signature)", secret: false },
    }),
    emits: ["core-integrations.inbound.received"],
    handle: async (req, ctx) => {
      const secret = ctx.config.hmac_secret;
      if (typeof secret === "string" && secret) {
        const headerName =
          (typeof ctx.config.signature_header === "string" && ctx.config.signature_header) ||
          "x-cobblr-signature";
        const provided = req.headers[headerName.toLowerCase()];
        const sigHeader = Array.isArray(provided) ? provided[0] : provided;
        if (!sigHeader) {
          return { status: 401, body: { error: "missing signature" } };
        }
        const { createHmac, timingSafeEqual } = await import("node:crypto");
        const expected =
          "sha256=" +
          createHmac("sha256", secret).update(req.rawBody ?? "").digest("hex");
        const a = Buffer.from(expected);
        const b = Buffer.from(sigHeader);
        if (a.length !== b.length || !timingSafeEqual(a, b)) {
          return { status: 401, body: { error: "bad signature" } };
        }
      }
      await ctx.emit("core-integrations.inbound.received", {
        orgId: ctx.orgId,
        inboundRowId: ctx.inboundRowId,
        headers: req.headers,
        body: req.body,
      });
      return { status: 200, body: { ok: true } };
    },
  });
}
