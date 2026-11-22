// The body of a place, as the page's route and the assistant's writer both read it.
import { z } from "zod";
import { imagePathField } from "@cobblr/platform-contract/image-reference";
import { optionalField } from "@cobblr/platform-contract/optional-fields";
import { planProblem } from "@cobblr/platform-contract/plan-clearance";
import { hasSomethingToRead } from "@cobblr/platform-contract/readable-text";

export const LocationCreate = z.object({
  name: z.string().trim().min(1).max(160).refine(hasSomethingToRead, "A place needs a name you can read."),
  short_name: z.string().max(60).nullable().optional(),
  parent_id: z.string().uuid().nullable().optional(),
  // Two bins genuinely both called "Bin" is a real thing people have. Refusing
  // that outright would be a rule about tidiness rather than correctness, so
  // the duplicate is available on purpose — it just cannot happen by accident.
  allow_duplicate: z.boolean().optional(),
  // The parent BY NAME. A person says "in the Garage", not a uuid, and so does
  // every sentence-shaped caller: a chat message, a shipped command, a CSV
  // import. Without it, anything holding a name had to search first, and a
  // caller who simply sent `parent` had it dropped by this schema and got a
  // top-level location while being told it worked.
  parent: optionalField(z.string().min(1).max(160)),
  kind: z.enum(["container", "area"]).optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  metadata: z.record(z.unknown()).optional().superRefine((m, ctx) => {
    const problem = planProblem(m?.floorplan);
    if (problem) ctx.addIssue({ code: "custom", message: problem, path: ["floorplan"] });
  }),
  description: z.string().max(8_000).nullable().optional(),
  notes: z.string().max(8_000).nullable().optional(),
  image_path: imagePathField().nullable().optional(),
});

export const LocationUpdate = LocationCreate.partial();
