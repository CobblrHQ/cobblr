// D6 from BACKLOG: field-def write-time routing.
//
// Bundles declare custom fields on an entity kind (e.g. lego-collector
// adds set_number, theme, year, piece_count on inventory:part). The
// natural way to POST one is to put those at the top level alongside
// `name` and `qty`. But the entity's native columns are fixed by its
// migration — anything not in that list has to land in the `metadata`
// JSONB column.
//
// routeUnknownToMetadata bridges the two: it scans the incoming body
// for keys the schema doesn't know about, lifts them into
// `body.metadata`, and returns the routed body so the schema can
// parse cleanly. Existing callers that already send metadata: { ... }
// keep working — their unknown keys (if any) get merged in.

export function routeUnknownToMetadata<T extends Record<string, unknown>>(
  body: unknown,
  nativeKeys: ReadonlySet<string>,
): T {
  if (!body || typeof body !== "object") return body as T;
  const src = body as Record<string, unknown>;
  // Any caller-provided metadata wins for collisions — we only ADD
  // top-level unknown keys, never overwrite explicit metadata values.
  const callerMetadata =
    src.metadata && typeof src.metadata === "object"
      ? (src.metadata as Record<string, unknown>)
      : {};
  const promoted: Record<string, unknown> = { ...callerMetadata };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (k === "metadata") continue;
    if (nativeKeys.has(k)) {
      out[k] = v;
    } else {
      // Don't clobber an explicit metadata.key set by the caller.
      if (!(k in promoted)) promoted[k] = v;
    }
  }
  // Only attach metadata if something's there — otherwise leave the
  // body alone so optional-metadata schemas don't get an empty obj.
  if (Object.keys(promoted).length > 0) out.metadata = promoted;
  return out as T;
}
