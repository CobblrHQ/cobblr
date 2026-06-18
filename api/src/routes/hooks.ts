// /api/v1/hooks/:id — the global, UNAUTHENTICATED public-webhook receiver.
//
// For ACCOUNT-LEVEL provider webhooks (Stripe billing, a GitHub app, a Slack
// app, …) that are NOT tenant-scoped: the URL carries no slug and no
// per-workspace token. A module registers a handler via
// platform().http.registerWebhook({ id, handle }); the handler verifies its OWN
// signature against the captured rawBody and resolves any tenant from the
// payload (or a signed state param).
//
// Both POST (events / interactivity) and GET (OAuth callbacks) are accepted, so
// the same seam serves a provider's webhook AND its "Add to X" redirect_uri. A
// handler can return `headers` + a 3xx status to issue a redirect (the OAuth
// callback case) instead of a JSON body.
//
// Contrast with /api/v1/integrations/:connector/:token/webhook: that is the
// PER-WORKSPACE inbound receiver keyed by a token that resolves to an org. This
// route has no such binding by design — it's for webhooks/callbacks that concern
// the whole instance (our Stripe account, our Slack app), not one workspace.
//
// Open core registers no handlers, so every id 404s until an overlay/module
// registers one. rawBody is captured for /api/v1/hooks/ in server.ts so
// signatures verify against the exact transmitted bytes.

import { Router, type Request, type Response, type NextFunction } from "express";
import { getWebhookHandler } from "../platform/hosted-seams.js";

export const hooksRouter = Router({ mergeParams: true });

async function dispatch(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "hook id required" } });
      return;
    }
    const handler = getWebhookHandler(id);
    if (!handler) {
      res.status(404).json({ error: { code: "no_handler", message: `no webhook handler '${id}'` } });
      return;
    }
    const result = await handler.handle({
      method: req.method,
      headers: req.headers as Record<string, string | string[] | undefined>,
      body: req.body,
      rawBody: (req as unknown as { rawBody?: string }).rawBody,
      query: req.query as Record<string, unknown>,
    });
    if (result.headers) {
      for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
    }
    // A 3xx with a Location header is a redirect (OAuth callback): end without a
    // JSON body so the browser follows it cleanly.
    if (result.status >= 300 && result.status < 400 && result.headers?.Location) {
      res.status(result.status).end();
      return;
    }
    res.status(result.status).json(result.body ?? { ok: result.status < 400 });
  } catch (err) {
    next(err);
  }
}

hooksRouter.post("/:id", dispatch);
hooksRouter.get("/:id", dispatch);
