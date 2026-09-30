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
  // Skip this many of EACH kind: the next page of a search is the next
  // per_kind rows of every kind that had more.
  offset: z.coerce.number().int().min(0).max(5000).default(0),
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
  tenant: { org: { id: string }; role?: string };
  session?: { id: string };
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
    // The reader, so a field they may not read is neither shown nor matched.
    const tr = req as unknown as TenantReq;
    const viewer = { userId: tr.session?.id, role: tr.tenant.role };
    const { q, per_kind, tag, offset } = parsed.data;
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

    // Discover the candidate kinds, for THIS workspace. listKinds() is the
    // process registry: base kinds only, every module whether or not this
    // workspace enabled it. A record in a named collection (a Bookshelf, a
    // Groceries list) lives under its own `<instance>:item` kind, which only
    // listKindsForOrg synthesizes, so searching the registry could never find
    // a book or a grocery while the page's own kind chips (org-aware) showed
    // both. list() returns { items: [] } for kinds without a list resolver,
    // so those fall out of kinds_searched naturally.
    const allKinds = await platform().entities.listKindsForOrg(orgId);
    const candidateIds = kindsParam
      ? allKinds.filter((k) => kindsParam.includes(k.id)).map((k) => k.id)
      : allKinds.map((k) => k.id);

    // Fan out, in parallel. Each kind's list resolver is independent
    // — one slow kind doesn't block fast ones. A resolver that throws comes
    // back `failed`, and is NAMED in `kinds_failed` rather than counted as
    // "no matches": a search that could not ask two kinds looked exactly like
    // one that asked and found nothing, for three weeks (#3824).
    const perKindResults = await Promise.all(
      candidateIds.map(async (kind) => {
        // Search finds what was retired too: "where is my old drill" is a
        // question about something archived, and a search that cannot find
        // it lies by omission. Lists and views leave retired records out
        // unless asked; search asks, and ranks them below the live ones.
        const result = await platform().entities.list(orgId, kind, {
          q,
          limit: per_kind,
          offset,
          filter: tag ? { _tag: tag } : undefined,
          include_retired: true,
        }, viewer);
        return { items: result.items.map((item) => ({ ...item, kind })), failed: result.failed === true };
      }),
    );
    const kindsFailed = candidateIds.filter((_, i) => perKindResults[i]!.failed);
    const perKind = perKindResults.map((r) => r.items);

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

    // Live ones first, whatever kind; retired ones after, still found.
    const ranked = [...merged.filter((i) => i.retired !== true), ...merged.filter((i) => i.retired === true)];

    res.json({
      q,
      kinds_searched: candidateIds.filter((_, i) => perKind[i]!.length > 0),
      kinds_failed: kindsFailed,
      items: ranked,
      // A kind that filled its share may have more: ask again with
      // offset + per_kind.
      has_more: perKind.some((list) => list.length === per_kind),
    });
  })().catch(next);
});

export default router;
