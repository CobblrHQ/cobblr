// bricklink router. Mounted at /api/v1/orgs/:slug/modules/bricklink-connector/.
// All routes inherit requireAuth + withTenant from the platform.

import { Router } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { parseWantedList } from "../services/wanted-list.js";
import { parseOrderCsv } from "../services/order-csv.js";
import { diffWantedList, type LoadInventoryParts } from "../services/diff.js";

const router = Router({ mergeParams: true });

// POST /parse-wanted-list — accept a pasted BL XML string, return
// structured items + warnings. Doesn't touch the DB; just parses.
// The UI consumes the parsed items + (later) diffs against inventory.
const ParseWantedBody = z.object({
  xml: z.string().min(1).max(2_000_000),
});

router.post("/parse-wanted-list", (req, res) => {
  const parsed = ParseWantedBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: { code: "invalid_body", message: "xml is required", details: parsed.error.issues },
    });
    return;
  }
  const result = parseWantedList(parsed.data.xml);
  res.json({
    items: result.items,
    warnings: result.warnings,
    counts: {
      items: result.items.length,
      parts: result.items.filter((i) => i.item_type === "P").length,
      sets: result.items.filter((i) => i.item_type === "S").length,
      minifigs: result.items.filter((i) => i.item_type === "M").length,
    },
  });
});

// POST /parse-order — accept a pasted BL order CSV, return
// structured lines + warnings + summary. Doesn't touch the DB; a
// future /commit-order endpoint takes these lines and writes
// inventory + purchases entries.
const ParseOrderBody = z.object({
  csv: z.string().min(1).max(5_000_000),
});

router.post("/parse-order", (req, res) => {
  const parsed = ParseOrderBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: { code: "invalid_body", message: "csv is required", details: parsed.error.issues },
    });
    return;
  }
  const result = parseOrderCsv(parsed.data.csv);
  res.json({
    lines: result.lines,
    warnings: result.warnings,
    summary: result.summary,
  });
});

// POST /diff-wanted-list — diff a parsed wanted-list against the
// workspace's Lego inventory. Returns each wanted line + a status
// bucket (have / partial / need / unmatched). Selecting which
// items to actually order is the UI's job.
const DiffBody = z.object({
  // Accept the same item shape parseWantedList emits — the UI is
  // expected to call parse-wanted-list first, edit/filter, then
  // diff. Keeps the parsing path testable in isolation.
  items: z
    .array(
      z.object({
        item_type: z.enum(["P", "S", "M", "B", "G", "C", "I", "O"]),
        item_id: z.string().min(1),
        color_id: z.number(),
        min_qty: z.number().int().positive(),
        max_price: z.number().nullable(),
        condition: z.enum(["N", "U", "A"]),
        remarks: z.string().nullable(),
      }),
    )
    .max(5000),
});

router.post("/diff-wanted-list", async (req, res, next) => {
  try {
    const parsed = DiffBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: { code: "invalid_body", message: "items array required", details: parsed.error.issues },
      });
      return;
    }
    const orgId = (req as unknown as { tenant?: { org: { id: string } } }).tenant?.org.id;
    if (!orgId) {
      res.status(500).json({ error: { code: "no_tenant", message: "tenant context missing" } });
      return;
    }
    const loader: LoadInventoryParts = async (orgId, partIds) => {
      if (partIds.length === 0) return [];
      // Go through the kernel's entity registry — inventory:part
      // exposes { qty, metadata } in its exposableFields, so this
      // is a layering-clean cross-module read. No more reaching
      // into inventory_parts.
      const resolved = await platform().entities.lookupMany(
        orgId,
        partIds.map((id) => ({ kind: "inventory:part", id })),
      );
      return resolved.map((r) => ({
        id: r.id,
        qty: Number((r.fields as { qty?: number | string }).qty ?? 0) || 0,
        color_id: extractColorId(
          (r.fields as { metadata?: Record<string, unknown> | null }).metadata ?? null,
        ),
      }));
    };
    const result = await diffWantedList(orgId, parsed.data.items, loader);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

function extractColorId(metadata: Record<string, unknown> | null): number {
  if (!metadata) return -1;
  // Conventional shape: metadata.lego.color_id (Rebrickable id).
  const lego = metadata["lego"] as { color_id?: number | string } | undefined;
  if (lego && lego.color_id !== undefined) {
    const n = Number(lego.color_id);
    return Number.isFinite(n) ? n : -1;
  }
  return -1;
}

export default router;
