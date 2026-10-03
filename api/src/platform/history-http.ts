import { captureHttpDelete } from "./deletion-http.js";
import { getHistoryWriterFor } from "./history-store.js";
import type { Request, Response, NextFunction } from "express";
import { baseKindOf, listKinds } from "./entities.js";
import { kindForRoute } from "./entity-saved.js";
import { finishHistoryWrite } from "./history-writes.js";
import { runHistoryWrite, type HistoryWrite } from "./record-history.js";

async function capture(req: Request, res: Response, next: NextFunction, kind: string, id: string): Promise<void> {
  const orgId = req.tenant!.org.id;
  const writer = await getHistoryWriterFor(orgId, kind);
  const read = writer?.snapshot?.bind(writer);
  const before = read ? await read(orgId, id) : null;
  if (!before || !read) { next(); return; }
  const write: HistoryWrite = { orgId, kind: await baseKindOf(orgId, kind), id, before, readAfter: () => read(orgId, id), logged: false };
  const json = res.json.bind(res);
  res.json = ((body: unknown) => {
    if (res.statusCode >= 300) return json(body);
    void runHistoryWrite(write, async () => {
      try { await finishHistoryWrite(write); json(body); }
      catch (err) { next(err); }
    });
    return res;
  }) as Response["json"];
  runHistoryWrite(write, next);
}

export function observeModuleHistory(moduleName: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (req.method !== "PATCH" && req.method !== "PUT" && req.method !== "DELETE") { next(); return; }
      const hit = kindForRoute(await listKinds(), moduleName, req.method, req.path);
      const id = req.path.replace(/\/+$/, "").split("/").at(-1);
      if (!hit || !id) { next(); return; }
      if (req.method === "DELETE") await captureHttpDelete(req, res, next, hit.kind, id);
      else await capture(req, res, next, hit.kind, id);
    } catch (err) { next(err); }
  };
}

export async function observeInstanceHistory(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if ((req.method !== "PATCH" && req.method !== "PUT" && req.method !== "DELETE") || !req.instance || !/^\/[^/]+\/?$/.test(req.path)) { next(); return; }
    if (req.method === "DELETE") await captureHttpDelete(req, res, next, `${req.instance}:item`, req.path.split("/")[1]!);
    else await capture(req, res, next, `${req.instance}:item`, req.path.split("/")[1]!);
  } catch (err) { next(err); }
}
