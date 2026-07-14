// Capture-first onboarding — quickstart.
//
// A brand-new workspace lands the user in CAPTURE, not the builder: scan
// something or write something down, with ZERO structure set up. core-scan's
// matchmaker routes each capture against the flagship-bundle MENU below (the
// shapes the workspace could BECOME), extracting fields into each bundle's
// shape and stamping the capture with the bundle it fits. When captures
// cluster, the user materializes one — install the bundle + batch-commit the
// pending captures onto the now-real table. See
// docs/design-decisions/capture-first-onboarding.md.

import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { requireRole } from "../auth/capability.js";
import { withTenant } from "../middleware/tenant.js";
import { validateBundle, applyValidatedBundle } from "./bundles.js";
import {
  flagshipBundleMenu,
  flagshipBundleTargets,
  getFlagshipManifest,
  type BundleMenuEntry,
  type BundleMenuField,
} from "../lib/flagship-bundles.js";
import { meta } from "../db/meta.js";
import { resolveFieldDefsForKind } from "../platform/field-defs.js";

export const quickstartRouter = Router({ mergeParams: true });

const INTERNAL_API = `http://127.0.0.1:${process.env.API_PORT ?? 4000}`;

function bearerOf(req: { headers: Record<string, unknown> }): string | null {
  const h = req.headers["authorization"];
  if (typeof h === "string" && h.toLowerCase().startsWith("bearer ")) return h.slice(7);
  return null;
}

/** One pending capture as core-scan returns it. */
interface InboxItem {
  id: string;
  status: string;
  suggested_name?: string | null;
  suggested_candidates?: Array<{
    bundle_external_id?: string;
    kind?: string;
    name?: string;
    quantity?: number;
    fields?: Record<string, unknown>;
  }> | null;
}

async function fetchPendingInbox(baseUrl: string, slug: string, token: string): Promise<InboxItem[]> {
  const res = await fetch(`${baseUrl}/api/v1/orgs/${slug}/modules/core-scan/inbox?status=pending`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const body = (await res.json()) as { items?: InboxItem[] } | InboxItem[];
  const items = Array.isArray(body) ? body : (body.items ?? []);
  return items.filter((i) => i.status !== "resolved");
}

// ── GET /bundle-menu ─────────────────────────────────────────────────────────
// The flagship menu, shaped like core-scan's ScanMenuEntry (+ bundle_external_id).
// core-scan fetches this and merges it with the workspace's live instances so a
// capture on a blank workspace still routes + extracts fields.
quickstartRouter.get("/bundle-menu", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const items = flagshipBundleMenu();
    // Merge in the workspace's TRAIT-SCOPED fields ("Acquired from" on everything
    // physical). A not-yet-installed bundle's items don't exist as a kind yet, so
    // the resolver can't reach them directly — but they WILL inherit their
    // module's primary kind (assets:asset / inventory:part / machines:machine, all
    // physical), so a physical-scoped field applies. Without this, a field scoped
    // to "all physical items" was invisible on every scan routed to an uninstalled
    // bundle (Home Inventory, etc.): the bundle menu is static manifest fields and
    // knows nothing about workspace field defs. A workspace with no scoped fields
    // adds nothing (one resolve per base kind, all empty).
    await mergeScopedFieldsIntoBundleMenu(req.tenant!.org.id, items);
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

/** For each bundle-menu entry, append the workspace's trait-scoped field defs that
 *  the entry's items will inherit once installed — resolved against the entry
 *  module's PRIMARY kind (the base its instance is skinned from). Dedups by name,
 *  never overrides a field the bundle already declares. Mutates `items`. */
async function mergeScopedFieldsIntoBundleMenu(
  orgId: string,
  items: BundleMenuEntry[],
): Promise<void> {
  const primaries = await meta
    .selectFrom("entity_kinds")
    .select(["module_name", "id"])
    .where("is_primary", "=", true)
    .execute();
  const primaryByModule = new Map(primaries.map((k) => [k.module_name, k.id]));

  const scopedByBase = new Map<string, BundleMenuField[]>();
  const scopedFor = async (module: string): Promise<BundleMenuField[]> => {
    const base = primaryByModule.get(module);
    if (!base) return [];
    const cached = scopedByBase.get(base);
    if (cached) return cached;
    const defs = await resolveFieldDefsForKind(orgId, base);
    const scoped: BundleMenuField[] = defs
      .filter((d) => d.scope && d.type !== "computed")
      .map((d) => ({
        name: d.name,
        label: d.display_label,
        type: d.type,
        ...(d.help ? { help: d.help } : {}),
        ...(Array.isArray(d.choices) && d.choices.length ? { choices: d.choices } : {}),
      }));
    scopedByBase.set(base, scoped);
    return scoped;
  };

  for (const it of items) {
    const extra = await scopedFor(it.module);
    if (extra.length === 0) continue;
    const have = new Set(it.fields.map((f) => f.name));
    it.fields.push(...extra.filter((f) => !have.has(f.name)));
  }
}

// ── GET /quickstart ──────────────────────────────────────────────────────────
// Pending captures grouped by the bundle they fit — "These look like yarn (3)".
quickstartRouter.get("/", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const token = bearerOf(req);
    if (!token) {
      res.status(401).json({ error: { code: "no_auth", message: "Bearer token required" } });
      return;
    }
    const baseUrl = (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API;
    const items = await fetchPendingInbox(baseUrl, req.tenant!.org.slug, token);
    const menu = flagshipBundleMenu();
    const labelOf = new Map(menu.map((m) => [m.bundle_external_id, { label: m.label, noun: m.noun }]));

    const groups = new Map<string, { count: number; samples: string[] }>();
    for (const it of items) {
      const top = (it.suggested_candidates ?? [])[0];
      const bid = top?.bundle_external_id;
      if (!bid) continue;
      const g = groups.get(bid) ?? { count: 0, samples: [] };
      g.count += 1;
      const nm = top?.name || it.suggested_name;
      if (nm && g.samples.length < 4) g.samples.push(nm);
      groups.set(bid, g);
    }
    const suggestions = [...groups.entries()]
      .map(([bundle_external_id, g]) => ({
        bundle_external_id,
        bundle_name: labelOf.get(bundle_external_id)?.label ?? bundle_external_id,
        noun: labelOf.get(bundle_external_id)?.noun ?? "item",
        count: g.count,
        sample_names: g.samples,
      }))
      .sort((a, b) => b.count - a.count);

    res.json({ pending_total: items.length, suggestions });
  } catch (err) {
    next(err);
  }
});

// ── POST /materialize ────────────────────────────────────────────────────────
// Install the flagship bundle (registers modules + fields + instances) then
// batch-commit every pending capture that fits it onto the now-real table.
const MaterializeBody = z.object({
  bundle_external_id: z.string().min(1).max(200),
  /** Limit to specific captures; omitted → all pending that fit this bundle. */
  item_ids: z.array(z.string().uuid()).optional(),
  /** The bundle was already installed by the caller (e.g. the feature-picker
   *  modal, which lets the user choose optional capabilities). Skip the
   *  install step and only commit the matching captures onto its tables. */
  skip_install: z.boolean().optional(),
});

quickstartRouter.post("/materialize", requireAuth, withTenant, async (req, res, next) => {
  try {
    // Changes workspace composition (enables modules, adds fields) — owner/admin.
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = MaterializeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad request body", details: parsed.error.issues } });
      return;
    }
    const token = bearerOf(req);
    if (!token) {
      res.status(401).json({ error: { code: "no_auth", message: "Bearer token required" } });
      return;
    }
    const orgId = req.tenant!.org.id;
    const slug = req.tenant!.org.slug;
    const baseUrl = (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API;
    const bundleId = parsed.data.bundle_external_id;

    const manifest = await getFlagshipManifest(bundleId);
    if (!manifest) {
      res.status(404).json({ error: { code: "unknown_bundle", message: `No flagship bundle "${bundleId}".` } });
      return;
    }

    // Install (autoEnable: enable the bundle's required modules in one step).
    // Unless the caller already installed it via the feature-picker modal — then
    // just commit the captures onto the tables that install created.
    if (!parsed.data.skip_install) {
      const v = await validateBundle(orgId, manifest, { autoEnable: true });
      if (!v.valid) {
        res.status(400).json({ error: { code: "invalid_bundle", message: "Bundle failed validation", details: { errors: v.errors } } });
        return;
      }
      await applyValidatedBundle(
        orgId,
        { id: req.session!.id, display_name: req.session!.display_name ?? null, auth_method: req.session!.auth_method, api_token_id: req.session!.api_token_id ?? null },
        v,
      );
    }

    const targets = flagshipBundleTargets(bundleId);
    if (targets.length === 0) {
      // Bundle installed but isn't a trackable capture target — nothing to commit.
      res.status(201).json({ created: 0, module: null, instance: null, route: null });
      return;
    }
    const pickTarget = (kind?: string) =>
      targets.find((t) => t.menu_kind === kind) ?? targets[0]!;

    // Commit each fitting pending capture onto its now-real table.
    const onlyIds = parsed.data.item_ids ? new Set(parsed.data.item_ids) : null;
    const pending = await fetchPendingInbox(baseUrl, slug, token);
    let created = 0;
    const errors: Array<{ id: string; status: number }> = [];
    for (const it of pending) {
      if (onlyIds && !onlyIds.has(it.id)) continue;
      const top = (it.suggested_candidates ?? [])[0];
      if (top?.bundle_external_id !== bundleId) continue;
      const target = pickTarget(top?.kind);
      const confirmRes = await fetch(`${baseUrl}/api/v1/orgs/${slug}/modules/core-scan/inbox/${it.id}/confirm`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          target_module: target.module,
          target_kind: target.base_kind.split(":")[1],
          ...(target.instance ? { instance: target.instance } : {}),
          ...(top?.name ? { name: top.name } : {}),
          ...(typeof top?.quantity === "number" ? { quantity: top.quantity } : {}),
        }),
      });
      if (confirmRes.ok) created += 1;
      else errors.push({ id: it.id, status: confirmRes.status });
    }

    const primary = targets[0]!;
    const route = primary.instance ? `/instances/${primary.instance}/items` : `/${primary.module}`;
    res.status(201).json({
      created,
      module: primary.module,
      instance: primary.instance,
      label: primary.label,
      route,
      ...(errors.length ? { errors } : {}),
    });
  } catch (err) {
    next(err);
  }
});
