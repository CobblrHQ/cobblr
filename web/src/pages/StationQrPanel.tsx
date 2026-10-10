// A station's kitchen QR, in its settings (#5353). The owner: "a qr label
// with the link should let me (or anyone else?) do the same thing from their
// phone." A member signed in on their phone uses the label as themselves. For
// anyone without an account the owner turns it on here, ticks what it may
// press (off by default), and prints it; printing again retires the old label
// and every phone it let in.

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { api, type StationRecordAction } from "../lib/api";
import type { StationSettings } from "@cobblr/platform-contract/station-screen";

/** The address a printed label opens: the station, marked as from the label,
 *  with the key when anyone may use it. */
export function stationQrUrl(origin: string, slug: string, address: string, key: string | null): string {
  const q = new URLSearchParams({ from: "qr" });
  if (key) q.set("k", key);
  return `${origin}/station/${slug}/${address}?${q.toString()}`;
}

async function printLabel(url: string, title: string): Promise<void> {
  const img = await QRCode.toDataURL(url, { width: 480, margin: 2 });
  const w = window.open("", "_blank", "noopener=no,width=480,height=640");
  if (!w) return;
  w.document.title = title;
  const body = w.document.body;
  body.style.cssText = "font-family: system-ui, sans-serif; text-align: center; padding: 24px;";
  const h = w.document.createElement("h1");
  h.textContent = title;
  const pic = w.document.createElement("img");
  pic.src = img;
  pic.style.width = "60mm";
  const p = w.document.createElement("p");
  p.textContent = "Scan with your phone's camera.";
  body.append(h, pic, p);
  pic.onload = () => w.print();
}

export function StationQrPanel({ slug, address, label, draft, set }: {
  slug: string;
  address: string;
  label: string;
  draft: StationSettings;
  set: <K extends keyof StationSettings>(k: K, v: StationSettings[K]) => void;
}) {
  const qc = useQueryClient();
  const state = useQuery({ queryKey: ["station-qr", slug, address], queryFn: () => api.stationQrState(slug, address) });
  const [anyone, setAnyone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (state.data) setAnyone(state.data.enabled);
  }, [state.data]);

  // The presses a phone could be given: this station's own actions on the
  // collections it keeps, by name.
  const kinds = draft.collections;
  const offered = useQuery({
    queryKey: ["station-qr-actions", slug, address, kinds.join(",")],
    queryFn: async () => {
      const lists = await Promise.all(kinds.map((k) => api.stationActions(slug, address, k).then((r) => r.items).catch(() => [] as StationRecordAction[])));
      const byId = new Map<string, StationRecordAction>();
      for (const a of lists.flat()) if (!byId.has(a.id)) byId.set(a.id, a);
      return [...byId.values()];
    },
    enabled: kinds.length > 0,
  });

  const toggleAction = (id: string, on: boolean) => set("qr_actions", on ? [...new Set([...draft.qr_actions, id])] : draft.qr_actions.filter((a) => a !== id));

  const print = async () => {
    setBusy(true);
    setError("");
    try {
      const key = anyone ? (await api.printStationQr(slug, address)).key : null;
      if (!anyone && state.data?.enabled) await api.stopStationQr(slug, address);
      await qc.invalidateQueries({ queryKey: ["station-qr", slug, address] });
      await printLabel(stationQrUrl(window.location.origin, slug, address, key), `${label}: scan to use`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      await api.stopStationQr(slug, address);
      await qc.invalidateQueries({ queryKey: ["station-qr", slug, address] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3" data-testid="station-qr-panel">
      <p className="text-sm text-muted">
        A label with a QR that opens this station on a phone. Anyone signed in to this workspace uses it as themselves.
      </p>
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-1" checked={anyone} onChange={(e) => setAnyone(e.target.checked)} />
        <span>
          Anyone with this QR can use it, without an account
          <span className="block text-sm text-muted">Only the presses ticked below. Printing a new label stops the old one.</span>
        </span>
      </label>
      {anyone && (
        <div className="space-y-1 rounded-xl border border-line p-3 dark:border-slate-600" data-testid="station-qr-presses">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={draft.qr_use_one} onChange={(e) => set("qr_use_one", e.target.checked)} /> Used one
          </label>
          {(offered.data ?? []).map((a) => (
            <label key={a.id} className="flex items-center gap-2">
              <input type="checkbox" checked={draft.qr_actions.includes(a.id)} onChange={(e) => toggleAction(a.id, e.target.checked)} /> {a.label}
            </label>
          ))}
          {kinds.length === 0 && <p className="text-sm text-muted">Pick the collections this station keeps (above) to choose more of its buttons.</p>}
        </div>
      )}
      {state.data?.enabled && (
        <p className="text-sm text-muted" data-testid="station-qr-state">
          On since {new Date(state.data.printed_at!).toLocaleDateString()}, {state.data.phones === 1 ? "1 phone" : `${state.data.phones} phones`} using it.
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <button type="button" onClick={() => void print()} disabled={busy} className="rounded-xl bg-cobble-600 px-4 py-2 font-medium text-white hover:bg-cobble-700 disabled:opacity-50">
          {state.data?.enabled && anyone ? "Print a new label" : "Print the label"}
        </button>
        {state.data?.enabled && (
          <button type="button" onClick={() => void stop()} disabled={busy} className="rounded-xl border border-line px-4 py-2 text-content hover:border-cobble-400 disabled:opacity-50 dark:border-slate-600">
            Stop the label for people without an account
          </button>
        )}
      </div>
      {anyone && <p className="text-sm text-muted">Save these settings too, so the presses you ticked apply.</p>}
      {error && <p className="text-red-700 dark:text-red-300">{error}</p>}
    </div>
  );
}
