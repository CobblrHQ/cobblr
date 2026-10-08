// The part a build makes, by name. A build with no output part consumes its
// components and adds nothing to stock, so the product a shop makes never
// becomes stock it can sell. When the person names what the build makes (by
// default, the build's own name), the build links the inventory part with
// that name, or makes one with nothing in stock yet. Through the platform's
// entity seams only: builds never reads inventory's tables.

import { platform } from "@cobblr/platform-contract";

const PART = "inventory:part";

export type OutputPartResult =
  | { ok: true; partId: string; created: boolean }
  | { ok: false; reason: string };

export async function resolveOutputPart(orgId: string, name: string): Promise<OutputPartResult> {
  const wanted = name.trim();
  if (!wanted) return { ok: false, reason: "Name the part this build makes." };
  // Inventory first. Its writer is registered for every workspace, on or off,
  // so a workspace without Inventory found no part, made one, and the write to
  // a table that workspace never had answered 500 instead of saying why.
  const off = { ok: false as const, reason: "Inventory is not turned on, so there is no part for this build to add to." };
  if (!(await platform().entities.listable(orgId, PART))) return off;
  const writer = await platform().entities.getWriter(orgId, PART);
  if (!writer) return off;
  const found = await platform().entities.list(orgId, PART, { q: wanted, limit: 50 });
  const same = found.items.find((p) => String(p.title ?? "").trim().toLowerCase() === wanted.toLowerCase());
  if (same) return { ok: true, partId: same.id, created: false };
  const id = await writer.create(orgId, { name: wanted, qty: 0 });
  return { ok: true, partId: id, created: true };
}
