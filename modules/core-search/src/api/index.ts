// Default-exported Router. Mounted at
//   /api/v1/orgs/:slug/modules/core-search/
// with requireAuth + withTenant already applied by the platform.

import { Router } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";

const router = Router({ mergeParams: true });

const SearchQuery = z.object({
  // q is optional now — `tag=<name>` alone is a valid query ("show
  // me everything tagged `urgent`"). Still capped at 200 chars when
  // present.
  q: z.string().min(1).max(200).optional(),
  // Comma-separated list of kinds to scope to. Omit = search every
  // kind that's registered a list resolver.
  kinds: z.string().optional(),
  // Per-kind cap so a query that matches 10 000 parts doesn't
  // dominate the merged result. Total returned is at most
  // per_kind * #kinds. Client paginates by re-querying with a higher
  // per_kind when "Show more" is clicked on a specific kind.
  per_kind: z.coerce.number().int().min(1).max(50).default(10),
  // Restrict to entities carrying this tag (case-insensitive). The
  // value is passed straight through as filter._tag to every list
  // resolver that opts into the D7 tag predicate. Resolvers that
  // don't opt in get the filter and ignore it (it's just an unknown
  // key), so the result silently narrows to kinds that DO support
  // tag filtering — which is the right behavior for "show me
  // everything tagged X".
  tag: z.string().min(1).max(80).optional(),
});

interface TenantReq {
  tenant: { org: { id: string } };
}

router.get("/search", (req, res, next) => {
  void (async () => {
    const parsed = SearchQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: { code: "invalid_query", message: "q is required", details: parsed.error.issues },
      });
      return;
    }
    const orgId = (req as unknown as TenantReq).tenant.org.id;
    const { q, per_kind, tag } = parsed.data;
    if (!q && !tag) {
      res.status(400).json({
        error: { code: "empty_query", message: "Supply at least one of ?q or ?tag" },
      });
      return;
    }
    const kindsParam = parsed.data.kinds
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    // Discover the candidate kinds. Use the registry (every kind
    // declared by every module's manifest) as the source of truth;
    // list() returns { items: [] } for kinds without a list resolver,
    // so they're naturally filtered out by the post-filter below.
    const allKinds = await platform().entities.listKinds();
    const candidateIds = kindsParam
      ? allKinds.filter((k) => kindsParam.includes(k.id)).map((k) => k.id)
      : allKinds.map((k) => k.id);

    // Fan out, in parallel. Each kind's list resolver is independent
    // — one slow kind doesn't block fast ones. A resolver that
    // throws gets swallowed by entities.list() (returns empty).
    const perKind = await Promise.all(
      candidateIds.map(async (kind) => {
        const result = await platform().entities.list(orgId, kind, {
          q,
          limit: per_kind,
          filter: tag ? { _tag: tag } : undefined,
        });
        return result.items.map((item) => ({ ...item, kind }));
      }),
    );

    // Interleave so callers don't see "all parts first, then all
    // tasks" — they see a fair mix. Round-robin across kinds.
    const merged: typeof perKind[number] = [];
    let idx = 0;
    while (true) {
      let pulled = 0;
      for (const list of perKind) {
        if (idx < list.length) {
          merged.push(list[idx]!);
          pulled++;
        }
      }
      if (pulled === 0) break;
      idx++;
    }

    res.json({
      q,
      kinds_searched: candidateIds.filter((_, i) => perKind[i]!.length > 0),
      items: merged,
    });
  })().catch(next);
});

export default router;
