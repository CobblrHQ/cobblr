// POST /orgs/:slug/resolve — the resolvable registry's HTTP entry.
//
// "What could this value mean, on this surface?" The palette (surface: palette),
// the search page (search), and a scan (scan) all ask here. The registry runs the
// providers serving the surface and lets the count decide: one navigates, several
// ask, none is a miss. See docs/design-decisions/resolvable-registry.md.
//
// Member+, session only. Bare identifiers are low-entropy (a 2-char serial), so
// they never resolve unauthenticated the way a 72-bit /qr token can; this route
// is inside the session and the entities it returns are already projected through
// each kind's exposableFields. resolvable-registry.md D2.

import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { withTenant } from "../middleware/tenant.js";
import { resolveValue, type ResolveSurface } from "../platform/resolvables.js";

export const resolveRouter = Router({ mergeParams: true });

const Body = z.object({
  value: z.string().min(1).max(2000),
  surface: z.enum(["scan", "palette", "search"]),
  source: z.enum(["typed", "wedge", "camera", "bridge"]).optional(),
  scope: z
    .object({ kind: z.string().min(1).max(120), filter: z.record(z.string()).optional() })
    .optional(),
});

resolveRouter.post("/:slug/resolve", requireAuth, withTenant, async (req, res, next) => {
  try {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "bad_request", detail: parsed.error.flatten() });
      return;
    }
    const orgId = req.tenant!.org.id;
    const { value, surface, source, scope } = parsed.data;
    const outcome = await resolveValue(orgId, value, {
      surface: surface as ResolveSurface,
      source,
      scope,
    });
    res.json(outcome);
  } catch (e) {
    next(e);
  }
});
