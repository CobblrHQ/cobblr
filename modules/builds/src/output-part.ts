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
  const found = await platform().entities.list(orgId, PART, { q: wanted, limit: 50 });
  const same = found.items.find((p) => String(p.title ?? "").trim().toLowerCase() === wanted.toLowerCase());
  if (same) return { ok: true, partId: same.id, created: false };
  const writer = await platform().entities.getWriter(orgId, PART);
  if (!writer) return { ok: false, reason: "Inventory is not turned on, so there is no part for this build to add to." };
  const id = await writer.create(orgId, { name: wanted, qty: 0 });
  return { ok: true, partId: id, created: true };
}
