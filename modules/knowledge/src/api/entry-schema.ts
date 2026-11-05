import { z } from "zod";
import { imagePathField } from "@cobblr/platform-contract/image-reference";
import { optionalText } from "@cobblr/platform-contract/optional-fields";

export const EntryCreate = z.object({
  title: z.string().min(1).max(300),
  body: optionalText(200_000),
  kind: optionalText(80),
  pinned: z.boolean().optional(),
  code: optionalText(200),
  image_path: imagePathField(1000).nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export const EntryUpdate = EntryCreate.partial();
