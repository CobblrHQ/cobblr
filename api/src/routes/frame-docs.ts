// The two doors onto a frame document's one-shot URL (#3300).
//
// See api/src/platform/frame-docs.ts for why a URL at all: an iframe built from
// `srcdoc` inherits the page's policy, so every custom app and installed
// renderer stops running the day `script-src 'self'` is enforced. A URL is
// where the browser applies the RESPONSE's own policy instead.
//
// POST mints a ticket; GET spends it. The GET is deliberately unauthenticated:
// an iframe cannot carry a bearer token (there is no header to set on a frame
// load and this product keeps no session cookie), so the ticket IS the
// capability. That is safe because a ticket is 32 random bytes, lives a minute,
// works once, and only somebody who could already put that HTML on screen can
// mint one.
//
// The POST needs a session, because otherwise this is an open echo on our own
// origin. The public-surface door is its twin in routes/public.ts, gated on the
// surface token, for the anonymous page that has no session and still renders
// custom blocks.
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { FrameDocTooLarge, frameDocPolicy, putFrameDoc, takeFrameDoc } from "../platform/frame-docs.js";

export const frameDocsRouter = Router();

export const FrameDocBody = z.object({
  html: z.string().min(1),
  kind: z.enum(["app-block", "renderer"]),
});

// AI-REACH: exempt — a rendering detail of a frame the person is already
// looking at. There is nothing here an assistant could want that it cannot get
// from the app or the file itself, and the ticket it would mint is spent by
// the browser a second later.
frameDocsRouter.post("/frame-docs", requireAuth, (req, res) => {
  const parsed = FrameDocBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "invalid_body", message: "html and kind are required." } });
    return;
  }
  try {
    const id = putFrameDoc(parsed.data.html, parsed.data.kind);
    res.status(201).json({ url: `/api/v1/frame-docs/${id}`, expires_in: 60 });
  } catch (e) {
    if (e instanceof FrameDocTooLarge) {
      res.status(413).json({ error: { code: "too_large", message: "That frame document is too large to render." } });
      return;
    }
    throw e;
  }
});

// Unauthenticated BY DESIGN (the ticket is the capability) and single-use. The
// headers are the whole point of this route: the policy here is what the
// browser applies to the document, in place of the page's.
// AI-REACH: exempt — spends a one-shot ticket and returns the document the
// browser is about to draw. Unauthenticated by design; nothing to reach for.
frameDocsRouter.get("/frame-docs/:id", (req, res) => {
  const doc = takeFrameDoc(String(req.params.id ?? ""));
  if (!doc) {
    // One answer for unknown, spent and expired.
    res.status(404).type("text/plain").send("no such frame");
    return;
  }
  res.setHeader("Content-Security-Policy", frameDocPolicy(doc.kind));
  res.setHeader("X-Content-Type-Options", "nosniff");
  // Never cached: the ticket is spent, and a cached copy would outlive it.
  res.setHeader("Cache-Control", "no-store");
  // Belt and braces with the CSP sandbox directive above, for a browser that
  // somehow honours one and not the other.
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.status(200).type("html").send(doc.html);
});
