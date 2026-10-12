// The one way the kernel writes a record of any kind on a person's behalf:
// the kind's own writer when it registers one, otherwise its declared
// create/update/delete endpoints, called as that person, with its history
// writer for snapshots and restores. Sending a record and a share's copy
// both write through here, so any kind one can carry the other can too: a
// share used to look for a native writer only, and a shared Pattern
// (projects:project, which declares endpoints but registers no writer) was
// accepted into a share space that could never hold it (#5911).
import { platform, type EntityWriter } from "@cobblr/platform-contract";
import { apiFetch, selfOrigin } from "@cobblr/platform-contract/self-api";
import { meta } from "../db/meta.js";
import { getHistoryWriterFor } from "./history-store.js";
import { listKindsForOrg, resolveKind } from "./entities.js";

type Fail = (message: string) => Error;
const plain: Fail = (m) => new Error(m);

/** Whether a record of `kind` can be written in `orgId` at all: its own
 *  writer, or endpoints for all three of create, update and delete plus a
 *  history writer. What a share may offer. */
export async function kindHoldable(orgId: string, kind: string): Promise<boolean> {
  if (await platform().entities.getWriter(orgId, kind)) return true;
  const { history, shape } = await endpointsOf(orgId, kind);
  return !!history && !!shape?.endpoints?.create && !!shape.endpoints.update && !!shape.endpoints.delete;
}

/** A kind's history writer and declared shape. A named instance's kind
 *  ("designs:item", a Pattern) is its module's primary kind in that instance:
 *  the base kind's endpoints, reached through the instance (#6056). */
async function endpointsOf(orgId: string, kind: string) {
  const { base, instance } = await resolveKind(orgId, kind);
  const history = (await getHistoryWriterFor(orgId, kind)) ?? (base !== kind ? await getHistoryWriterFor(orgId, base) : null);
  const shape = (await listKindsForOrg(orgId)).find((k) => k.id === base);
  return { history, shape, instance };
}

/** A writer for `kind` in `orgId`, acting as `userId` when it goes through
 *  the kind's endpoints; null when the kind cannot be written there. */
export async function writerFor(orgId: string, kind: string, userId: string, fail: Fail = plain): Promise<EntityWriter | null> {
  const native = await platform().entities.getWriter(orgId, kind);
  if (native) return native;
  const { history, shape, instance } = await endpointsOf(orgId, kind);
  if (!history || !shape?.endpoints?.create || !shape.endpoints.update || !shape.endpoints.delete) return null;
  const org = await meta.selectFrom("orgs").select("slug").where("id", "=", orgId).executeTakeFirst();
  if (!org) throw fail("That workspace is gone.");
  const token = await platform().auth.mintSession({ userId });
  // An endpoint refuses a field its kind does not take, where a kind's own
  // writer ignores it: only the kind's writable fields, and its metadata, go.
  const writable = new Set([...shape.fields.filter((f) => !f.readOnly).map((f) => f.name), "metadata"]);
  const only = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([k]) => writable.has(k)));
  const call = async (method: string, endpoint: string, id?: string, fields?: Record<string, unknown>) => {
    const path = endpoint.replace(/\{id\}/g, id ?? "");
    // An instance's records are the module's primary router mounted at the
    // instance (server.ts, dispatchInstanceItems): "/projects/{id}" there is
    // "/instances/designs/items/{id}", and the record lands in that instance.
    const at = instance ? `/instances/${instance}/items${path.replace(/^\/[^/]+/, "")}` : `/modules/${shape.module_name}${path}`;
    const response = await apiFetch(`${selfOrigin()}/api/v1/orgs/${org.slug}${at}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(fields ? { body: JSON.stringify(fields) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await response.json().catch(() => null)) as { id?: string; error?: { message?: string } } | null;
    if (!response.ok) throw fail(body?.error?.message ?? "The collection could not complete this change.");
    return body;
  };
  return {
    create: async (_org, fields) => {
      const body = await call("POST", shape.endpoints!.create!, undefined, only(fields));
      if (!body?.id) throw fail("The collection did not confirm the new record.");
      return body.id;
    },
    update: async (_org, id, fields) => {
      await call("PATCH", shape.endpoints!.update!, id, only(fields));
    },
    delete: async (_org, id) => {
      await call("DELETE", shape.endpoints!.delete!, id);
    },
    snapshot: history.snapshot.bind(history),
    read: history.snapshot.bind(history),
    restore: history.restore.bind(history),
    snapshotDeletion: history.snapshotDeletion?.bind(history),
    restoreDeletion: history.restoreDeletion?.bind(history),
  };
}

/** Why a share may not offer these kinds, or null when it may: a kind no
 *  share space can hold is refused when it is offered, never accepted into
 *  a share space that stays empty for good. */
export async function shareRefusal(orgId: string, kinds: Iterable<string>): Promise<string | null> {
  const cannot: string[] = [];
  for (const kind of new Set(kinds)) if (!(await kindHoldable(orgId, kind))) cannot.push(kind);
  if (!cannot.length) return null;
  const names = await listKindsForOrg(orgId);
  const word = (k: string) => names.find((n) => n.id === k)?.display_name_plural ?? k;
  return `${cannot.map(word).join(", ")} cannot be shared yet: this Cobblr has no way to keep a copy of them in someone else's workspace.`;
}
