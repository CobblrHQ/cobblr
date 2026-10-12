import { z } from "zod";

/** A request field a person may leave blank. Absent, null and "" all say
 *  "none", and none arrives as null (absent stays absent), so a form sending
 *  null for an empty box is never refused. On an edit, null clears the stored
 *  value. lint:optional-fields-accept-none holds request bodies to this. */
export function optionalField<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((v) => (v === "" ? null : v), schema.nullish());
}

export const optionalText = (max: number) => optionalField(z.string().max(max));
export const optionalUuid = () => optionalField(z.string().uuid());
