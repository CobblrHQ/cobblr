// The body of a tag, as the page's route and the assistant's writer both read it.
import { z } from "zod";
import { readableNameField } from "@cobblr/platform-contract/readable-text";

export const TagCreate = z.object({
  name: readableNameField(60),
  color: z.string().max(40).nullable().optional(),
  parent_id: z.string().uuid().nullable().optional(),
  icon: z.string().max(16).nullable().optional(),
});

// `pinned` is update-only on purpose: you pin a tag you already have and can
// see the ranking of, never one you are in the middle of typing.
export const TagUpdate = TagCreate.partial().extend({ pinned: z.boolean().optional(), metadata: z.record(z.unknown()).optional() });
