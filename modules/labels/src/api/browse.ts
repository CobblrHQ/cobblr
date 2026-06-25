// /browse — the "find things to label" surface. The Labels page can't
// only be a queue you push INTO from other modules; you should be able
// to come here, browse what's labelable, and add. companion app did this with
// tabs of categories; this is the platform-native, zero-hardcoding
// version of the same idea.
//
// THE SOURCE OF TRUTH is the `labels:print` action's `appliesTo`
// predicate — the exact same predicate that decides whether an entity
// shows a "Print label" button decides whether it shows up here. So a
// kind is "labelable" iff `labels:print` resolves as applicable to it
// (honouring any per-org appliesTo override). Tabs == those kinds.
// Items within a tab == that kind's rows via the generic entity list.

import { Router } from "express";
import { platform } from "@cobblr/platform-contract";
import { sessionUser, tenantContext } from "../db.js";
import { asyncHandler } from "./util.js";

export const browseRouter = Router({ mergeParams: true });

const LABELS_ACTION = "labels:print";

/** Every entity kind the `labels:print` action applies to in this org —
 *  the platform's own resolver, per-org overrides included. Parallel:
 *  the kind set is small (tens), and listApplicable is a cheap couple of
 *  queries each. */
async function labelableKinds(orgId: string) {
  const kinds = await platform().entities.listKinds();
  const flags = await Promise.all(
    kinds.map(async (k) => {
      const actions = await platform().actions.listApplicable(k.id, orgId);
      return actions.some((a) => a.id === LABELS_ACTION);
    }),
  );
  return kinds.filter((_, i) => flags[i]);
}

// GET /browse/kinds → the tabs. Each labelable kind with a friendly
// label/icon and a count (best-effort — resolvers that don't return a
// total just omit it; the UI shows the loaded count instead).
browseRouter.get(
  "/kinds",
  asyncHandler(async (req, res) => {
    const { org, role } = tenantContext(req);
    const session = sessionUser(req);
    const kinds = await labelableKinds(org.id);
    const out = await Promise.all(
      kinds.map(async (k) => {
        let count: number | undefined;
        try {
          const r = await platform().entities.list(
            org.id,
            k.id,
            { limit: 1 },
            { userId: session.id, role },
          );
          count = r.total;
        } catch {
          count = undefined;
        }
        return {
          kind: k.id,
          label: k.display_name_plural ?? k.display_name,
          icon: k.icon ?? null,
          count,
        };
      }),
    );
    // Stable, friendly ordering: by label.
    out.sort((a, b) => a.label.localeCompare(b.label));
    res.json({ kinds: out });
  }),
);

// GET /browse/kinds/:kind/items?q=&limit=&offset= → one tab's contents.
// Gated to labelable kinds so this can't be turned into a generic
// arbitrary-kind list endpoint. Items carry exactly what a queue-add
// needs (id/title/subtitle/image/detail-url), nothing more.
browseRouter.get(
  "/kinds/:kind/items",
  asyncHandler(async (req, res) => {
    const { org, role } = tenantContext(req);
    const session = sessionUser(req);
    const kind = req.params.kind ?? "";

    const allowed = await labelableKinds(org.id);
    if (!allowed.some((k) => k.id === kind)) {
      res.status(404).json({
        error: { code: "not_labelable", message: `${kind} does not support labels` },
      });
      return;
    }

    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const limit = Math.min(Math.max(Number(req.query.limit) || 60, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const result = await platform().entities.list(
      org.id,
      kind,
      { q: q || undefined, limit, offset, sort: ["title"] },
      { userId: session.id, role },
    );

    res.json({
      items: result.items.map((e) => ({
        kind: e.kind,
        id: e.id,
        title: e.title,
        subtitle: e.subtitle ?? null,
        image_path: e.image_path ?? null,
        detail_url: e.detailUrl ?? null,
      })),
      total: result.total,
    });
  }),
);
