// Shared "queue a label for printing" helper. Used by bulk-print
// flows on LocationsPage / AssetsPage / MachinesPage / PartsListPage,
// and by single-print flows on each entity's detail page.
//
// The flow is two steps:
//   1. Mint (or reuse) a QR scan token via core-labels-qr.
//   2. POST to the labels queue with the QR url + description.
// Both calls are scoped to the workspace slug + need a bearer token.
//
// Pulled out of LocationsPage's inline implementation per
// 2026-05-25-audit.md S4 (bulk-print parity).

import { getToken } from "./api";

export interface QueueLabelInput {
  slug: string;
  entityKind: string; // e.g. "core-locations:location"
  entityId: string;
  /** What text shows on the label. Falls back to "Item" if blank. */
  description: string;
  /** Logical (module, type) pair the labels queue uses to attribute
   *  prints. e.g. ("core-locations", "location"). Inferred from
   *  entityKind if not supplied. */
  module_name?: string;
  entity_type?: string;
  qty?: number;
}

function auth(): Record<string, string> {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

/** Mint (or reuse an existing active) QR token for the entity, then
 *  enqueue a label-print row. Throws on the first network failure;
 *  callers loop + track success/fail per entity. */
export async function queueLabel(input: QueueLabelInput): Promise<void> {
  const { slug, entityKind, entityId, description } = input;
  // 1. Try to reuse an active token to avoid littering the table on
  //    repeated bulk prints.
  let tokenSlug: string | null = null;
  const list = await fetch(
    `/api/v1/orgs/${slug}/modules/core-labels-qr/tokens?entity_kind=${encodeURIComponent(entityKind)}&entity_id=${encodeURIComponent(entityId)}`,
    { headers: auth() },
  );
  if (list.ok) {
    const data = (await list.json()) as {
      items: Array<{ token: string; revoked_at: string | null }>;
    };
    const active = data.items.find((t) => !t.revoked_at);
    if (active) tokenSlug = active.token;
  }
  if (!tokenSlug) {
    const mint = await fetch(
      `/api/v1/orgs/${slug}/modules/core-labels-qr/tokens`,
      {
        method: "POST",
        headers: { ...auth(), "Content-Type": "application/json" },
        body: JSON.stringify({
          entity_kind: entityKind,
          entity_id: entityId,
          mode: "navigate",
          auth: "session",
        }),
      },
    );
    if (!mint.ok) throw new Error(`mint token: ${mint.status}`);
    const m = (await mint.json()) as { token: string };
    tokenSlug = m.token;
  }
  // 2. Push to the labels queue.
  // Infer module_name + entity_type from "<module>:<kind>" if not
  // overridden. For "core-locations:location" this yields module=
  // "core-locations", type="location".
  const [defaultModule, defaultType] = entityKind.split(":");
  const qrUrl = `${window.location.origin}/qr/${tokenSlug}`;
  const q = await fetch(`/api/v1/orgs/${slug}/modules/labels/queue`, {
    method: "POST",
    headers: { ...auth(), "Content-Type": "application/json" },
    body: JSON.stringify({
      module_name: input.module_name ?? defaultModule,
      entity_type: input.entity_type ?? defaultType,
      entity_id: entityId,
      qr_payload: qrUrl,
      description: description || "Item",
      qty: input.qty ?? 1,
    }),
  });
  if (!q.ok && q.status !== 409) {
    throw new Error(`queue: ${q.status}`);
  }
}

/** Bulk variant — queues N labels sequentially. Returns counts so
 *  the caller can toast appropriately. Stops aggregating errors past
 *  the first 3 to keep the toast readable. */
export async function queueLabelsBulk(
  inputs: QueueLabelInput[],
): Promise<{ ok: number; fail: number; errors: string[] }> {
  let ok = 0;
  let fail = 0;
  const errors: string[] = [];
  for (const input of inputs) {
    try {
      await queueLabel(input);
      ok++;
    } catch (err) {
      fail++;
      if (errors.length < 3) errors.push((err as Error).message);
    }
  }
  return { ok, fail, errors };
}
