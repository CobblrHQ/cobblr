// Read a base64url string only in its one canonical spelling.
//
// base64url's last character can carry bits no byte uses (two of them when
// the bytes are a multiple of three plus two, four when plus one), and
// Node's decoder ignores them: "AAA" and "AAB" are the same two bytes. A
// token checked by DECODING it and comparing the bytes therefore opens for
// several strings, every near spelling of its last character. Nothing is
// guessed that way (the bytes, and any signature, must still be right), but
// a token must be one string, not a family. This decodes and then re-encodes,
// and answers null unless the two spellings are the same.
// lint:base64url-decodes-exactly holds every decode in the api and modules to
// it, or to a written reason.
// Node only (Buffer): the api and modules, never the web app.

/** The bytes of `s`, or null when `s` is not their one canonical spelling
 *  (stray bits in its last character, padding, or a character outside the
 *  alphabet). */
export function decodeBase64urlExact(s: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  const bytes = Buffer.from(s, "base64url");
  return bytes.toString("base64url") === s ? bytes : null;
}
