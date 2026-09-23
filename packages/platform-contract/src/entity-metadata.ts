// How a record's write reaches its `metadata` column: the kernel's rule for
// every module whose kinds keep custom-field values in a jsonb bag.
//
// Bundles declare custom fields on an entity kind (a set number, a theme, a
// year on an inventory part). The natural way to POST one is at the top level
// beside `name` and `qty`, but the kind's native columns are fixed by its
// migration, so anything not in that list has to land in `metadata`.
// routeUnknownToMetadata lifts those keys in; preserveServerManaged keeps a
// client from writing a field the server owns; coerceMetadata reads the bag
// back whether the driver handed over an object or the raw jsonb string.
//
// Six modules and two kernel files each carried their own copy, identical
// today and free to drift apart (#3499). They import these now.

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

/** Preserve SERVER-MANAGED metadata keys across a client write. Custom-field
 *  values live in the `metadata` jsonb column, written wholesale (the client
 *  does read-modify-write). A server_managed field (e.g. core-mobility's
 *  `away_since`) is owned by the server — a client's value must never take.
 *  So for each managed key: re-inject the STORED value if there is one, else
 *  drop the client's attempt. Only acts when the client actually sent metadata
 *  and the kind has managed fields (`names` from
 *  platform().entities.serverManagedFields). */
export function preserveServerManaged(
  incoming: Record<string, unknown> | undefined,
  current: Record<string, unknown> | undefined,
  names: readonly string[],
): Record<string, unknown> | undefined {
  if (names.length === 0 || incoming === undefined) return incoming;
  const out = { ...incoming };
  for (const n of names) {
    if (current && n in current) out[n] = current[n];
    else delete out[n];
  }
  return out;
}

/** Normalise a jsonb `metadata` value (object, raw string, or null) to a plain
 *  object so custom keys are reachable for the before/after event bag. */
export function coerceMetadata(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return { ...(raw as Record<string, unknown>) };
  if (typeof raw === "string" && raw.trim()) {
    try {
      const p = JSON.parse(raw);
      if (p && typeof p === "object") return p as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
  }
  return {};
}
