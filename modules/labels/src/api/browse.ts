// /browse — the "find things to label" surface. The Labels page can't
// only be a queue you push INTO from other modules; you should be able
// to come here, browse what's labelable, and add. companion app did this with
// tabs of categories; this is the platform-native, zero-hardcoding
// version of the same idea.
//
// Tabs == the workspace's INSTANCES (what the navbar actually shows:
// "3D Printers", "Laser Cutters", "Parts", …), NOT the global
// entity-kind registry. A workspace that uses machines-as-instances has
// no generic "Machines" — it has its own named collections, and that's
// what you label by. We keep ONLY the instances whose module's kind is
// labelable (the SAME `labels:print` appliesTo predicate that decides
// the Print-label button, per-org overrides included) AND that hold at
// least one item — an empty tab you can't add anything from is noise.
//
//   instances (org-scoped)  ──filter──►  labelable + non-empty  ──►  tabs
//   named instance → list <instance_name>:item   (3d-printers)
//   default instance → list the base kind         (single-instance domains)

import { Router } from "express";
import { platform } from "@cobblr/platform-contract";
import { sessionUser, tenantContext } from "../db.js";
import { asyncHandler } from "./util.js";

export const browseRouter = Router({ mergeParams: true });

const LABELS_ACTION = "labels:print";

interface LabelableKind {
  kind: string;
  label: string;
  icon: string | null;
}

/** The first entity kind of `moduleName` that `labels:print` applies to in this
 *  org (per-org appliesTo overrides included), or null if the module owns no
 *  labelable kind. Cached per request by the caller. */
async function labelableKindForModule(
  moduleName: string,
  orgId: string,
): Promise<LabelableKind | null> {
  const kinds = (await platform().entities.listKinds()).filter((k) =>
    k.id.startsWith(`${moduleName}:`),
  );
  for (const k of kinds) {
    const actions = await platform().actions.listApplicable(k.id, orgId);
    if (actions.some((a) => a.id === LABELS_ACTION)) {
      return { kind: k.id, label: k.display_name_plural ?? k.display_name, icon: k.icon ?? null };
    }
  }
  return null;
}

/** The kind to LIST an instance's items through the generic entity layer:
 *  named instances scope via `<instance_name>:item`; the module's default
 *  instance (instance_name === module_name) lists the base kind directly. */
function listKindFor(inst: { instance_name: string; is_default: boolean }, baseKind: string): string {
  return inst.is_default ? baseKind : `${inst.instance_name}:item`;
}

// GET /browse/instances → the tabs. One per labelable, non-empty instance the
// workspace actually has. A multi-instance module's (usually empty) default
// instance is dropped when it has named siblings — those named tabs are the
// real thing, and a generic "Machines" alongside "3D Printers" is the exact
// confusion this endpoint exists to avoid.
browseRouter.get(
  "/instances",
  asyncHandler(async (req, res) => {
    const { org } = tenantContext(req);
    const instances = await platform().instances.list(org.id);
    const modulesWithNamed = new Set(
      instances.filter((i) => !i.is_default).map((i) => i.module_name),
    );
    const kindCache = new Map<string, LabelableKind | null>();
    const labelable = async (moduleName: string) => {
      if (!kindCache.has(moduleName)) {
        kindCache.set(moduleName, await labelableKindForModule(moduleName, org.id));
      }
      return kindCache.get(moduleName) ?? null;
    };

    const tabs: { id: string; label: string; count: number | null }[] = [];
    for (const inst of instances) {
      // Drop a default instance that's been superseded by named ones — its tab
      // would list every instance's items under a generic module name.
      if (inst.is_default && modulesWithNamed.has(inst.module_name)) continue;
      const lk = await labelable(inst.module_name);
      if (!lk) continue; // module owns nothing labelable
      // Hide empties — a tab with nothing to add is pure noise (this is what
      // killed the bogus empty "Assets" tab). Only skip when the count is KNOWN
      // zero; an unknown count (module registered no counter) still shows.
      if (inst.item_count === 0) continue;
      tabs.push({
        // Named instance → its own display name ("3D Printers"). Default →
        // the kind's plural ("Parts"), the item-browsing noun.
        id: inst.instance_name,
        label: inst.is_default ? lk.label : inst.display_name,
        count: inst.item_count,
      });
    }
    tabs.sort((a, b) => a.label.localeCompare(b.label));
    res.json({ tabs });
  }),
);

// GET /browse/instances/:id/items?q=&limit=&offset= → one tab's contents.
// `id` is an instance_name; gated to labelable instances so this can't become
// a generic arbitrary-kind list endpoint. Items carry exactly what a queue-add
// needs (id/title/subtitle/image/detail-url), nothing more.
browseRouter.get(
  "/instances/:id/items",
  asyncHandler(async (req, res) => {
    const { org, role } = tenantContext(req);
    const session = sessionUser(req);
    const id = req.params.id ?? "";

    const inst = (await platform().instances.list(org.id)).find(
      (i) => i.instance_name === id,
    );
    if (!inst) {
      res.status(404).json({ error: { code: "not_found", message: `no instance "${id}"` } });
      return;
    }
    const lk = await labelableKindForModule(inst.module_name, org.id);
    if (!lk) {
      res.status(404).json({
        error: { code: "not_labelable", message: `${id} does not support labels` },
      });
      return;
    }

    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const limit = Math.min(Math.max(Number(req.query.limit) || 60, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const result = await platform().entities.list(
      org.id,
      listKindFor(inst, lk.kind),
      { q: q || undefined, limit, offset, sort: ["title"] },
      { userId: session.id, role },
    );

    res.json({
      items: result.items.map((e) => {
        const f = e.fields as { parent_id?: unknown; kind?: unknown; depth?: unknown; position?: unknown };
        // Hierarchy passthrough (generic — populated only for kinds whose
        // exposed fields carry them; today that's locations). Lets the browser
        // render the SAME tree + area/container split, in the SAME order, as the
        // real Locations page (via the shared buildLocationForest). `section` is
        // the within-kind grouping (locations: "area" vs "container");
        // `parent_id` builds the tree; `position` is the manual drag order.
        const parent_id = typeof f.parent_id === "string" ? f.parent_id : null;
        const section = typeof f.kind === "string" ? f.kind : null;
        const depth = typeof f.depth === "number" ? f.depth : null;
        const position = typeof f.position === "number" ? f.position : null;
        return {
          // Always carry the BASE kind so a queue-add records `machines:machine`,
          // not the synthetic `<instance>:item` (the queue + QR want the real kind).
          kind: lk.kind,
          id: e.id,
          title: e.title,
          subtitle: e.subtitle ?? null,
          image_path: e.image_path ?? null,
          detail_url: e.detailUrl ?? null,
          parent_id,
          section,
          depth,
          position,
        };
      }),
      total: result.total,
    });
  }),
);
