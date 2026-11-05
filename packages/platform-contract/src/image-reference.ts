import { z } from "zod";

// A stored picture may be a file path, a bare file name an import brought, or a
// web address. A broken one shows the record's initial, so the rule only refuses
// what can never be a picture: nothing to read, control characters, or another
// scheme such as javascript:.
const SCHEME = /^[a-z][a-z0-9+.-]*:(?=\S)/i;
const PICTURE_SCHEME = /^(https?:|data:image\/)/i;

export function canBeAPicture(value: string): boolean {
  if (value === "") return true;
  if (!/[\p{L}\p{N}]/u.test(value) || /\p{Cc}/u.test(value)) return false;
  return !SCHEME.test(value) || PICTURE_SCHEME.test(value);
}

export const imagePathField = (max = 500) =>
  z.string().max(max).refine(canBeAPicture, "This doesn't look like a picture's path or web address.");
