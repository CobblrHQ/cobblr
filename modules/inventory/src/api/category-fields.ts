// The body of a category, as the page's route and the assistant's writer both read it.
import { z } from "zod";
import { optionalField } from "@cobblr/platform-contract/optional-fields";

export const CategoryCreate = z.object({
  name: z.string().trim().min(1).max(120),
  color: optionalField(z.string().regex(/^#[0-9a-fA-F]{3,8}$/)),
  parent_id: z.string().uuid().nullable().optional(),
});
