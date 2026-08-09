// Resolve the NATIVE serial_number / model for a scan-confirm from the two
// sources that carry them: a vision/decoder value stamped on `meta`
// (meta.serial_number = a read service tag; meta.model), or a matchmaker
// candidate's fields — a decoded VIN lands on candidateFields.serial_number via
// applyDecoderFill. The candidate is the FALLBACK.
//
// This exists as a pure function so the "a decoded value must reach the native
// column, not only the metadata blob" rule is locked by a test: the confirm bug
// (reported 2026-07-24) was a decoded VIN landing in metadata.serial_number — a key
// the VIN field never reads — while the native serial_number column stayed blank.
// serial_number/model are native across inventory/assets/machines; a target that
// declares neither drops the key harmlessly downstream.

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);

export function resolveNativeIdentity(
  meta: { serial_number?: unknown; model?: unknown } | null | undefined,
  candidateFields: Record<string, unknown> | null | undefined,
): { serial_number?: string; model?: string } {
  const cf = candidateFields ?? {};
  const serial_number = str(meta?.serial_number) ?? str(cf.serial_number);
  const model = str(meta?.model) ?? str(cf.model);
  return {
    ...(serial_number ? { serial_number } : {}),
    ...(model ? { model } : {}),
  };
}
