// Which driver packages a workspace's bridges should be running, and the bytes
// for one — served the same way the bridge's own release already is.
//
// Cobblr is a CONDUIT, never a store. It keeps the manifest (kind, version,
// sha256, where it came from) and streams a package through on demand,
// verifying the hash in flight. It does not retain the artifact.
//
// That is a deliberate narrowing and it costs a cache: the source has to be
// reachable when a bridge reconciles, so a fetch failure is a retry rather than
// a hit. The bridge already retries everything. What it buys:
//
//   · a breach of Cobblr exposes no third-party code, because none is held
//   · we do not quietly become a package registry, with the retention,
//     garbage collection and takedown surface that implies
//   · a private-source token is used in flight and never persisted beside the
//     code it fetched, which is a much smaller promise than holding both
//
// See docs/design-decisions/managed-edge-bridge.md.

import { createHash } from "node:crypto";

export interface EdgeDriverEntry {
  /** Referenced by an instance's `driver:` in bridge config. Becomes a
   *  FILENAME on the bridge, so the shape is constrained hard. */
  kind: string;
  version: string;
  sha256: string;
  /** Where the bytes come from. Never sent to the bridge — it asks us. */
  source: string;
}

/** A kind becomes a filename on the bridge. Anything with a slash or a dot-dot
 *  in it is a path-traversal attempt, not a driver. Mirrors the bridge's own
 *  check, deliberately: neither end trusts the other to have done it. */
export const isSafeKind = (k: string): boolean => /^[a-z0-9][a-z0-9-]{0,63}$/.test(k);

/** What the bridge polls. Only what it needs to decide whether to fetch —
 *  never the source URL, which is ours and may carry a credential. */
export const manifestFor = (entries: EdgeDriverEntry[]): { kind: string; version: string; sha256: string }[] =>
  entries
    .filter((e) => isSafeKind(e.kind) && !!e.version && !!e.sha256)
    .map(({ kind, version, sha256 }) => ({ kind, version, sha256 }));

export class DriverFetchError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DriverFetchError";
  }
}

/** Fetch a package and verify it before it goes anywhere.
 *
 *  Verification happens HERE rather than only on the bridge, so a source that
 *  has been tampered with is refused at the first hop and the bridge is never
 *  handed bytes we could already tell were wrong. The bridge checks again
 *  anyway — that is not redundant, it is the two ends not trusting each other.
 *
 *  Returns the bytes; the caller streams them and stores nothing. */
export async function fetchDriverBundle(
  entry: EdgeDriverEntry,
  deps: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<string> {
  const doFetch = deps.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(entry.source, {
      headers: { Accept: "text/javascript, application/javascript, text/plain" },
      signal: AbortSignal.timeout(deps.timeoutMs ?? 30_000),
    });
  } catch (err) {
    // The source being down is a retry, not a corrupt install. The bridge keeps
    // whatever it already had.
    throw new DriverFetchError(`driver source unreachable: ${(err as Error).message}`, 502);
  }

  if (!res.ok) throw new DriverFetchError(`driver source returned HTTP ${res.status}`, 502);

  const js = await res.text();
  if (!js || js.length < 200) throw new DriverFetchError("driver bundle is empty or truncated", 502);

  const sha = createHash("sha256").update(js).digest("hex");
  if (sha !== entry.sha256) {
    // Never pass on unverified bytes. A mismatch means the source changed under
    // a pinned version, which is exactly what pinning exists to catch.
    throw new DriverFetchError(
      `driver bundle sha mismatch (got ${sha.slice(0, 12)}, want ${entry.sha256.slice(0, 12)})`,
      502,
    );
  }

  return js;
}

/** The desired driver set for a workspace, newest declaration per kind.
 *
 *  `bridge_id` null means every bridge; a value scopes it to one, for a
 *  workspace running more than one site. A bridge asks with its own id and
 *  gets the union of the two, which is why this filters rather than the SQL. */
export async function listOrgDrivers(
  orgId: string,
  bridgeId?: string | null,
): Promise<EdgeDriverEntry[]> {
  const { meta } = await import("../db/meta.js");
  const rows = await meta
    .selectFrom("edge_driver_packages" as never)
    .select(["kind", "version", "sha256", "source", "bridge_id"] as never)
    .where("org_id" as never, "=", orgId as never)
    .execute();

  return (rows as unknown as (EdgeDriverEntry & { bridge_id: string | null })[])
    .filter((r) => r.bridge_id === null || (!!bridgeId && r.bridge_id === bridgeId))
    .map(({ kind, version, sha256, source }) => ({ kind, version, sha256, source }));
}

/** Declare (or re-pin) a driver for a workspace.
 *
 *  Upsert on (org, kind, bridge scope): re-declaring the same kind is how you
 *  change version, which is the common edit and should not need a delete
 *  first. */
export async function declareDriver(
  orgId: string,
  entry: EdgeDriverEntry & { bridgeId?: string | null },
): Promise<void> {
  const { meta } = await import("../db/meta.js");
  const { sql } = await import("kysely");
  await sql`
    insert into edge_driver_packages (org_id, kind, version, sha256, source, bridge_id, updated_at)
    values (${orgId}, ${entry.kind}, ${entry.version}, ${entry.sha256}, ${entry.source},
            ${entry.bridgeId ?? null}, now())
    on conflict (org_id, kind, coalesce(bridge_id, '')) do update set
      version = excluded.version,
      sha256 = excluded.sha256,
      source = excluded.source,
      updated_at = now()
  `.execute(meta as never);
}

/** Stop declaring a driver. The bridge removes it on its next reconcile —
 *  nothing here reaches out to the bridge, which is what makes this safe to
 *  call while a bridge is offline. */
export async function undeclareDriver(
  orgId: string,
  kind: string,
  bridgeId?: string | null,
): Promise<void> {
  const { meta } = await import("../db/meta.js");
  const { sql } = await import("kysely");
  await sql`
    delete from edge_driver_packages
     where org_id = ${orgId} and kind = ${kind}
       and coalesce(bridge_id, '') = coalesce(${bridgeId ?? null}, '')
  `.execute(meta as never);
}

/** Everything declared, INCLUDING the source, for the workspace's own settings
 *  page. Distinct from manifestFor(), which is what a bridge may see. */
export async function listDeclared(
  orgId: string,
): Promise<(EdgeDriverEntry & { bridgeId: string | null })[]> {
  const { meta } = await import("../db/meta.js");
  const rows = await meta
    .selectFrom("edge_driver_packages" as never)
    .select(["kind", "version", "sha256", "source", "bridge_id"] as never)
    .where("org_id" as never, "=", orgId as never)
    .execute();
  return (rows as unknown as (EdgeDriverEntry & { bridge_id: string | null })[]).map((r) => ({
    kind: r.kind,
    version: r.version,
    sha256: r.sha256,
    source: r.source,
    bridgeId: r.bridge_id,
  }));
}
