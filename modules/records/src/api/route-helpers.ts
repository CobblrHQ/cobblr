// Field-def write-time routing. See modules/inventory/src/api/route-helpers.ts
// for the design rationale — modules each have a tiny copy so they can stay
// decoupled until we publish the helper to a shared internal package.

export function routeUnknownToMetadata<T extends Record<string, unknown>>(
  body: unknown,
  nativeKeys: ReadonlySet<string>,
): T {
  if (!body || typeof body !== "object") return body as T;
  const src = body as Record<string, unknown>;
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
      if (!(k in promoted)) promoted[k] = v;
    }
  }
  if (Object.keys(promoted).length > 0) out.metadata = promoted;
  return out as T;
}

/** Preserve SERVER-MANAGED metadata keys across a client write. Same helper as
 *  inventory's (see that copy for the rationale): metadata is written wholesale,
 *  so a server-stamped value must be re-injected from the STORED row — a
 *  client's value never takes. */
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
