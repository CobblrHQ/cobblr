// The body of a machine, as the page's route and the assistant's writer both read it.
import { z } from "zod";
import { imagePathField } from "@cobblr/platform-contract/image-reference";
import { RECORD_NOTES_MAX } from "@cobblr/platform-contract/record-limits";

export const MachineCreate = z.object({
  name: z.string().min(1).max(200),
  short_name: z.string().max(40).nullable().optional(),
  family: z.string().max(120).nullable().optional(),
  type: z.string().max(120).nullable().optional(),
  manufacturer: z.string().max(120).nullable().optional(),
  serial_number: z.string().max(120).nullable().optional(),
  state: z.string().max(40).optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  excitement: z.number().int().min(0).max(5).optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  image_path: imagePathField().nullable().optional(),
  notes: z.string().max(RECORD_NOTES_MAX).nullable().optional(),
  quantity: z.number().int().min(0).optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  location_id: z.string().uuid().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
  // What it runs, typed by a person; source and last seen are stamped here.
  firmware_version: z.string().max(120).nullable().optional(),
  software_version: z.string().max(120).nullable().optional(),
  controller: z.string().max(120).nullable().optional(),
});

export const MachineUpdate = MachineCreate.partial();
