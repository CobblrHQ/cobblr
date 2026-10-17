// The serial number is the anti-theft field (#6942): it is shown, searched and
// written only by someone who holds `assets:view-serials` (owners and admins
// always do; a member only when granted). The kernel's projection already
// holds that for Search, the entity lists, Cobb, exports and shares; this holds
// it for the asset's own routes, which read the table directly, so the asset
// screen neither shows nor sends a serial to a viewer who may not see one.

import type { Request, Response } from "express";
import { platform } from "@cobblr/platform-contract";
import { sessionUser, tenantContext } from "../db.js";

export const VIEW_SERIALS = "assets:view-serials";

export async function maySeeSerials(req: Request): Promise<boolean> {
  const ctx = tenantContext(req);
  return platform().auth.userHasCapability({ orgId: ctx.org.id, userId: sessionUser(req).id, role: ctx.role, actionId: VIEW_SERIALS });
}

/** The row, with no `serial_number` at all (not an empty one) when the viewer
 *  may not see it: a screen shows the field when the key is there. */
export function withoutSerial<T extends Record<string, unknown>>(row: T): Omit<T, "serial_number"> {
  const { serial_number: _serial, ...rest } = row;
  return rest;
}

export async function forViewer<T extends Record<string, unknown>>(req: Request, rows: T[]): Promise<Array<T | Omit<T, "serial_number">>> {
  return (await maySeeSerials(req)) ? rows : rows.map(withoutSerial);
}

/** A write that names a serial, from someone who may not see them: refused,
 *  because writing one is how a stranger's serial gets onto an asset. */
export async function refuseSerialWrite(req: Request, res: Response, body: unknown): Promise<boolean> {
  if (!body || typeof body !== "object" || !("serial_number" in (body as Record<string, unknown>))) return false;
  if (await maySeeSerials(req)) return false;
  const who = { orgId: tenantContext(req).org.id, userId: sessionUser(req).id, role: tenantContext(req).role, actionId: VIEW_SERIALS };
  const blocked = await platform().auth.describeBlockedCapability(who);
  res.status(403).json({ error: { code: "missing_capability", message: blocked.sentence, blocked } });
  return true;
}
