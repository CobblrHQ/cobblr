// "Move to..." — put a record in a different list of the same type.
//
// Shared because every instanceable module needs the identical conversation:
// where to, what happens to the custom fields, confirm. The module supplies the
// records and the noun; this owns the rest.
//
// The preview is the point, not decoration. A record can carry a custom field
// the destination has never heard of (a book's Author moving into Inventory),
// and the value survives either way (it lives on the record) but renders
// unlabeled unless the field comes too. So the user sees exactly which fields
// that is, before anything is written.
//
// See docs/design-decisions/move-between-instances.md.

import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { carryFieldNames, moveDestinations, type InstanceOption } from "./move-destinations";

type CarryField = { name: string; display_label: string; type: string; count: number };

type Plan = { fromKind: string; toKind: string; fieldsToCarry: CarryField[] };

export interface MoveToInstanceModalProps {
  open: boolean;
  onClose: () => void;
  slug: string;
  getToken: () => string | null;
  /** The module whose instances these records belong to. */
  moduleName: string;
  /** The instance the records are in now. */
  fromInstance: string;
  ids: string[];
  /** What the records are called, for the copy ("2 items", "book"). */
  noun?: string;
  /** Fired after a successful move, with the destination's display name. */
  onMoved: (movedCount: number, destinationLabel: string) => void;
}

async function json<T>(
  url: string,
  getToken: () => string | null,
  init?: RequestInit,
): Promise<T> {
  const token = getToken();
  const r = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!r.ok) {
    // The API refuses a cross-module target with a readable message; show it
    // rather than a generic failure, because it is the one error a user can
    // act on.
    const body = (await r.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? `HTTP ${r.status}`);
  }
  return r.json() as Promise<T>;
}

export function MoveToInstanceModal({
  open,
  onClose,
  slug,
  getToken,
  moduleName,
  fromInstance,
  ids,
  noun = "record",
  onMoved,
}: MoveToInstanceModalProps) {
  const [destinations, setDestinations] = useState<InstanceOption[]>([]);
  const [to, setTo] = useState<string>("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [carry, setCarry] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const base = `/api/v1/orgs/${slug}`;
  const count = ids.length;
  const things = count === 1 ? noun : `${count} ${noun}s`;

  useEffect(() => {
    if (!open) return;
    setError(null);
    setPlan(null);
    setTo("");
    json<{ items: InstanceOption[] }>(
      `${base}/instances?module=${encodeURIComponent(moduleName)}`,
      getToken,
    )
      .then((r) => setDestinations(moveDestinations(r.items, fromInstance)))
      .catch((e: Error) => setError(e.message));
  }, [open, base, moduleName, fromInstance, getToken]);

  // Ask what would happen as soon as there is a destination, so the field list
  // is on screen before the user commits rather than after.
  useEffect(() => {
    if (!open || !to) return;
    setError(null);
    json<Plan>(`${base}/record-move/preview`, getToken, {
      method: "POST",
      body: JSON.stringify({ module: moduleName, ids, from: fromInstance, to }),
    })
      .then((p) => {
        setPlan(p);
        setCarry(Object.fromEntries(p.fieldsToCarry.map((f) => [f.name, true])));
      })
      .catch((e: Error) => {
        setPlan(null);
        setError(e.message);
      });
  }, [open, to, base, moduleName, fromInstance, ids, getToken]);

  async function confirm() {
    if (!to) return;
    setBusy(true);
    setError(null);
    try {
      const res = await json<{ moved: string[] }>(`${base}/record-move`, getToken, {
        method: "POST",
        body: JSON.stringify({
          module: moduleName,
          ids,
          from: fromInstance,
          to,
          carry_fields: carryFieldNames(plan?.fieldsToCarry ?? [], carry),
        }),
      });
      const label = destinations.find((d) => d.instance_name === to)?.display_name ?? to;
      onMoved(res.moved.length, label);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={`Move ${things}`} size="md">
      <div className="space-y-4">
        {destinations.length === 0 ? (
          <p className="text-sm text-muted">
            There is nowhere else to move {count === 1 ? "this" : "these"} yet. Create another
            list of the same type first, and it will show up here.
          </p>
        ) : (
          <label className="block space-y-1">
            <span className="text-sm font-medium text-content">Move to</span>
            <select
              className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-content"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            >
              <option value="">Choose a destination…</option>
              {destinations.map((d) => (
                <option key={d.instance_name} value={d.instance_name}>
                  {d.display_name}
                </option>
              ))}
            </select>
          </label>
        )}

        {plan && plan.fieldsToCarry.length > 0 && (
          <div className="space-y-2 rounded-lg border border-line bg-subtle p-3">
            <p className="text-sm text-content">
              These fields do not exist there yet. Bring them along so the values stay labelled:
            </p>
            {plan.fieldsToCarry.map((f) => (
              <label key={f.name} className="flex items-start gap-2 text-sm text-content">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={carry[f.name] ?? true}
                  onChange={(e) => setCarry((c) => ({ ...c, [f.name]: e.target.checked }))}
                />
                <span>
                  <span className="font-medium">{f.display_label}</span>
                  <span className="text-muted">
                    {" "}
                    ({f.count === 1 ? "1 record uses it" : `${f.count} records use it`})
                  </span>
                </span>
              </label>
            ))}
            <p className="text-xs text-muted">
              Unticking one keeps the value on the record, just without its label. Nothing is
              deleted either way.
            </p>
          </div>
        )}

        {plan && (
          <p className="text-xs text-muted">
            History, tags, photos and any printed QR labels come along: the {noun} keeps its
            identity, so a label already stuck on something still works. The destination&apos;s own
            saved views and label templates apply once it arrives.
          </p>
        )}

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-line px-3 py-2 text-sm text-content"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={!to || busy}
            className="rounded-lg bg-cobble-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? "Moving…" : `Move ${things}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
