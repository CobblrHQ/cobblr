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

import { platform } from "@cobblr/platform-contract";

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

/** A record UPDATE's `.set()` object with its `metadata` written as THE
 *  merge (#3625): the keys the caller sent are set, a null removes its key,
 *  every other key stays as the live row holds it, in one statement
 *  (platform().db.mergeJsonb). A server-managed key the caller sent is
 *  dropped rather than written. Every entity PATCH wraps its set in this;
 *  writing the object itself replaced the whole bag, so three quick edits to
 *  one item kept only the last and lost the other two with a 200 each. */
export function withMetadataMerged<T extends Record<string, unknown>>(set: T, serverManaged: readonly string[] = [], column = "metadata"): T {
  const incoming = set[column];
  if (incoming === undefined) return set;
  if (incoming === null || typeof incoming !== "object" || Array.isArray(incoming)) {
    const { [column]: _dropped, ...rest } = set;
    return rest as T;
  }
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(incoming as Record<string, unknown>)) if (!serverManaged.includes(k)) fields[k] = v;
  if (Object.keys(fields).length === 0) {
    const { [column]: _dropped, ...rest } = set;
    return rest as T;
  }
  return { ...set, [column]: platform().db.mergeJsonb(column, fields) } as T;
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

/** What a template reading a record sees: its native fields at the top level
 *  and its custom-field values beside them, the way a person names them
 *  (`{{author}}`, not `{{metadata.author}}`). Custom values win a collision,
 *  since that is where authored values sit, and `metadata` stays reachable
 *  for a template that names it.
 *
 *  One rule for every surface that renders a record into text: a computed
 *  field, a label, a wire's arguments. The label and wire doors read only the
 *  native fields, so every shipped label that named a bundle's field printed
 *  its placeholder ("Unknown / Effective Java / ?", #3591). */
export function templateDataOf(fields: Record<string, unknown>): Record<string, unknown> {
  return { ...fields, ...coerceMetadata(fields.metadata) };
}

/** Props on a resolved record that every reader sees whatever the kind's
 *  `exposableFields` say: the ones every renderer needs to show "the entity"
 *  generically. In the contract because two sides must agree on it: the
 *  kernel's projection keeps them, and lint:template-fields-readable counts
 *  them as readable when it judges a bundle's template.
 *
 *  `instance` is the instances-system column (which named collection an item
 *  belongs to). Structural and not sensitive, so it is readable everywhere
 *  without every instanceable module having to list it. */
export const IMPLICIT_EXPOSABLE_PROPS: ReadonlySet<string> = new Set([
  "kind",
  "id",
  "title",
  "subtitle",
  "image_path",
  "detailUrl",
  "instance",
]);
