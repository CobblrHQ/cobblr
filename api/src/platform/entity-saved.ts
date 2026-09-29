// The kernel says once that a record was made or changed (#3818).
//
// Watches the way OUT of a module's routes and an instance's items: a
// successful create or update whose answer is a record is announced as
// ENTITY_SAVED_EVENT, with its kind from the registry and its title and
// picture read by the kind's own field roles. Every door that reaches a
// module over HTTP passes here: the create form, a list's inline add, the
// API and MCP, the assistant, a scan filed into a table. A module writing in
// process (an import, a sync) gets its writer from platform().entities
// .getWriter, which announces the same way (announceWrites). A capability
// that must react to any record subscribes to the one event.
//
// Announced after the answer is sent and never awaited, so a slow or failing
// subscriber cannot change what the person was answered.

import type { Request, Response, NextFunction } from "express";
import { ENTITY_SAVED_EVENT, type EntitySavedEvent } from "@cobblr/platform-contract/entity-saved";
import type { EntityKindRecord, EntityWriter } from "@cobblr/platform-contract";
import { emit } from "./events.js";
import { getKind, listKinds } from "./entities.js";

/** The kind a module route writes, from its declared endpoints: a POST to the
 *  create endpoint, a PATCH or PUT to the update one. Pure; exported for the
 *  test. */
export function kindForRoute(kinds: readonly Pick<EntityKindRecord, "id" | "module_name" | "endpoints">[], moduleName: string, method: string, path: string): { kind: string; created: boolean } | null {
  const m = method.toUpperCase();
  const clean = path.replace(/\/+$/, "") || "/";
  for (const k of kinds) {
    if (k.module_name !== moduleName || !k.endpoints) continue;
    if (m === "POST" && k.endpoints.create && clean === k.endpoints.create.replace(/\/+$/, "")) return { kind: k.id, created: true };
    if ((m === "PATCH" || m === "PUT") && k.endpoints.update) {
      const re = new RegExp(`^${k.endpoints.update.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{id\}/g, "[^/]+")}$`);
      if (re.test(clean)) return { kind: k.id, created: false };
    }
  }
  return null;
}

/** What the saved answer says: the record's title and whether it has a
 *  picture, by the kind's roles, with the common names as the fallback. */
export function savedFacts(kindRec: Pick<EntityKindRecord, "fields"> | null, body: Record<string, unknown>): { title: string | null; hasImage: boolean | null } {
  const fields = kindRec?.fields ?? [];
  const titleField = fields.find((f) => (f as { role?: string }).role === "title")?.name;
  const imageField = fields.find((f) => (f as { role?: string }).role === "image")?.name;
  const t = body[titleField ?? ""] ?? body.name ?? body.title;
  const title = typeof t === "string" && t.trim() ? t.trim() : null;
  const imageKey = imageField ?? ("image_path" in body ? "image_path" : null);
  const img = imageKey ? body[imageKey] : undefined;
  return { title, hasImage: imageKey ? typeof img === "string" && img.trim().length > 0 : null };
}

/** The saved record in an answer: the answer itself, or the one it wraps. */
function recordIn(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.id === "string") return b;
  for (const key of ["item", "record", "entity", "data"]) {
    const inner = b[key];
    if (inner && typeof inner === "object" && typeof (inner as { id?: unknown }).id === "string") return inner as Record<string, unknown>;
  }
  return null;
}

/** `resolve` is handed the path as it was when the request ARRIVED here: by the
 *  time the answer is sent, the module's own routers have rewritten `req.path`
 *  to whatever is left below their mount ("/" for a create), and the kind
 *  lookup read that and found nothing. */
function announce(req: Request, res: Response, resolve: (path: string) => Promise<{ kind: string; created: boolean; kindRec: EntityKindRecord | null } | null>): void {
  const m = req.method.toUpperCase();
  const arrivedPath = req.path;
  if (m !== "POST" && m !== "PATCH" && m !== "PUT") return;
  const orgId = req.tenant?.org.id;
  if (!orgId) return;
  const sendJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    const out = sendJson(body);
    const record = res.statusCode < 300 ? recordIn(body) : null;
    if (record) {
      void (async () => {
        const hit = await resolve(arrivedPath);
        if (!hit) return;
        const facts = savedFacts(hit.kindRec, record);
        const event: EntitySavedEvent = {
          orgId,
          kind: hit.kind,
          id: record.id as string,
          title: facts.title,
          hasImage: facts.hasImage,
          created: hit.created,
          userId: req.session?.id ?? null,
        };
        await emit(ENTITY_SAVED_EVENT, event);
      })().catch((err) => console.error("[entity-saved] announcing a save failed:", (err as Error).message));
    }
    return out;
  }) as Response["json"];
}

/** Mounted in front of a module's router. */
export function observeModuleSaves(moduleName: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    announce(req, res, async (path) => {
      const kinds = await listKinds();
      const hit = kindForRoute(kinds, moduleName, req.method, path);
      if (!hit) return null;
      return { ...hit, kindRec: kinds.find((k) => k.id === hit.kind) ?? null };
    });
    next();
  };
}

/** Called by the instance-items dispatcher, whose kind is `<instance>:item`
 *  and whose fields are the owning module's primary kind's. */
export function observeInstanceSaves(req: Request, res: Response, instance: string, moduleName: string): void {
  announce(req, res, async (arrived) => {
    // Mounted at .../instances/:name/items, so the path here is "/" for a
    // create and "/<id>" for an update.
    const path = arrived.replace(/\/+$/, "");
    const m = req.method.toUpperCase();
    const created = m === "POST" && path === "";
    const updated = (m === "PATCH" || m === "PUT") && /^\/[^/]+$/.test(path);
    if (!created && !updated) return null;
    const kinds = await listKinds();
    const primary = kinds.find((k) => k.module_name === moduleName && k.is_primary) ?? (await getKind(`${moduleName}:item`));
    return { kind: `${instance}:item`, created, kindRec: primary ?? null };
  });
}

/** A writer handed to a module in process (an import, a sync) announces its
 *  creates and updates the same way the HTTP doors do, so a record an
 *  importer writes is no different to a subscriber from one a person made. */
export function announceWrites(orgId: string, kind: string, writer: EntityWriter): EntityWriter {
  const tell = (id: string, fields: Record<string, unknown>, created: boolean): void => {
    void (async () => {
      const facts = savedFacts(await getKind(kind).catch(() => null), fields);
      const event: EntitySavedEvent = { orgId, kind, id, title: facts.title, hasImage: facts.hasImage, created, userId: null };
      await emit(ENTITY_SAVED_EVENT, event);
    })().catch((err) => console.error("[entity-saved] announcing a write failed:", (err as Error).message));
  };
  return Object.assign(Object.create(writer) as EntityWriter, {
    create: async (o: string, fields: Record<string, unknown>) => {
      const id = await writer.create(o, fields);
      tell(id, fields, true);
      return id;
    },
    update: async (o: string, id: string, fields: Record<string, unknown>) => {
      await writer.update(o, id, fields);
      tell(id, fields, false);
    },
  });
}

