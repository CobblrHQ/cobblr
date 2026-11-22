// The body of a part, as the page's route and the assistant's writer both read it.
import { z } from "zod";
import { imagePathField } from "@cobblr/platform-contract/image-reference";
import { RECORD_NOTES_MAX } from "@cobblr/platform-contract/record-limits";
import { webLink } from "@cobblr/platform-contract/web-link";
import { PART_NAME_MAX, PART_WARRANTY_DETAILS_MAX } from "../part-limits.js";

export const PartCreate = z.object({
  name: z.string().min(1).max(PART_NAME_MAX),
  description: z.string().max(8_000).nullable().optional(),
  category_id: z.string().uuid().nullable().optional(),
  location_id: z.string().uuid().nullable().optional(),
  qty: z.number().nonnegative().optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  unit: z.string().max(40).optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  // Nullable: clearing a cost / reorder point is a legitimate edit (the columns
  // are nullable and the write path handles null); without it an inline cell
  // blanking Min gets a 400 and the value can never be unset from a list.
  cost: z.number().nonnegative().nullable().optional(),
  min_qty: z.number().nonnegative().nullable().optional(),
  manufacturer: z.string().max(120).nullable().optional(),
  supplier_url: webLink().max(500).nullable().optional(),
  image_path: imagePathField().nullable().optional(),
  notes: z.string().max(RECORD_NOTES_MAX).nullable().optional(),
  state: z.enum(["active", "draft", "needs_review"]).optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  metadata: z.record(z.unknown()).optional(),
  // An ESTIMATE, not a count. Setting it is what turns a record into an
  // assortment ("roughly 50 adapters"); clearing it turns the estimate off.
  // Kept apart from `qty` on purpose: a thing is counted or it is guessed at,
  // and letting them share a column would make the guess look like arithmetic.
  approximate_qty: z.number().nonnegative().nullable().optional(),
  // HomeBox parity fields.
  serial_number: z.string().max(160).nullable().optional(),
  model_number: z.string().max(160).nullable().optional(),
  assigned_to: z.string().max(160).nullable().optional(),
  warranty_expires: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  lifetime_warranty: z.boolean().optional(),
  warranty_details: z.string().max(PART_WARRANTY_DETAILS_MAX).nullable().optional(),
  insured: z.boolean().optional(),
  archived: z.boolean().optional(),
});

export const PartUpdate = PartCreate.partial();
