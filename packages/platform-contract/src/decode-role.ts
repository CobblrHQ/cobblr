export type DecodeRole =
  | { kind: "identifier"; decoderId: string }
  | { kind: "target"; key: string };

/** Parse a `decode_role` string into its structured form, or null when the
 *  string is absent/blank/malformed. Pure; safe on any input. */
export function parseDecodeRole(raw: string | null | undefined): DecodeRole | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  const id = s.match(/^identifier:([a-z][a-z0-9_-]*)$/i);
  if (id) return { kind: "identifier", decoderId: id[1]!.toLowerCase() };
  const tgt = s.match(/^decode:([a-z][a-z0-9_-]*)$/i);
  if (tgt) return { kind: "target", key: tgt[1]!.toLowerCase() };
  return null;
}
