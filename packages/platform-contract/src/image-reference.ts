import { z } from "zod";
import { PICTURE_REFUSED, isPicturePath } from "@cobblr/platform-contract/safe-href";

// A stored picture is a file in this workspace (a path, or a bare file name an
// import brought) or an https address (#4115). A broken one shows the record's
// initial. Refused: nothing to read, control characters, another site's
// address with no scheme (`//host/x.png`), plain http (it travels in the clear
// and a secure page will not draw it), and any other scheme, `javascript:` and
// `data:` among them. The page draws only what this rule keeps
// (drawablePicture, in useImageSrc), so a row saved before it is never drawn.

export { PICTURE_REFUSED };

export function canBeAPicture(value: string): boolean {
  return isPicturePath(value);
}

export const imagePathField = (max = 500) => z.string().max(max).refine(canBeAPicture, PICTURE_REFUSED);

/** A picture an entity writer is handed (the assistant's door, an import, a
 *  sync): the value to store, null for none, or a thrown refusal in words the
 *  assistant can repeat. */
export function storedPicture(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > 2000 || !canBeAPicture(value)) throw new Error(PICTURE_REFUSED);
  return value;
}

/** The same rule for a value a connector brings from elsewhere: kept when it
 *  can be a picture, otherwise dropped, so one odd address never sinks the
 *  record it came with. */
export function pictureOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" && value.length <= 2000 && canBeAPicture(value) ? value : null;
}
