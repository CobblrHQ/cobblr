// The body of an asset, as the page's route and the assistant's writer both read it.
import { z } from "zod";
import { imagePathField } from "@cobblr/platform-contract/image-reference";
import { RECORD_NOTES_MAX } from "@cobblr/platform-contract/record-limits";
import { AssetDate } from "./asset-date.js";

export const AssetCreate = z.object({
  name: z.string().trim().min(1, "Give this equipment a name.").max(200),
  short_name: z.string().max(40).nullable().optional(),
  manufacturer: z.string().max(120).nullable().optional(),
  model: z.string().max(120).nullable().optional(),
  type: z.string().max(120).nullable().optional(),
  state: z.string().max(40).optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  excitement: z.number().int().min(0).max(5).optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  quantity: z.number().int().min(0).optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  serial_number: z.string().max(160).nullable().optional(),
  purchased_at: AssetDate.optional(),
  purchase_price_cents: z.number().int().min(0).max(10_000_000_000).nullable().optional(),
  vendor: z.string().max(200).nullable().optional(),
  warranty_until: AssetDate.optional(),
  last_service_at: AssetDate.optional(),
  image_path: imagePathField().nullable().optional(),
  notes: z.string().max(RECORD_NOTES_MAX).nullable().optional(),
  location_id: z.string().uuid().nullable().optional(),
  flags: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const AssetUpdate = AssetCreate.partial();
