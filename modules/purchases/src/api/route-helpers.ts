// D6 from BACKLOG: field-def write-time routing. See
// modules/inventory/src/api/route-helpers.ts for the design rationale
// — modules each have a tiny copy so they can stay decoupled until
// we publish the helper to a shared internal package.

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

/**
 * A pg `date` column comes back as a JS Date at LOCAL midnight (there is no
 * setTypeParser override in this repo), so `.toISOString().slice(0, 10)` moves
 * it a calendar day for any server east of Greenwich - a Berlin box turned
 * "arrives Aug 26" into an Aug 25 calendar event. Local getters read the same
 * day pg parsed.
 */
export function localDayOf(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  }
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}
