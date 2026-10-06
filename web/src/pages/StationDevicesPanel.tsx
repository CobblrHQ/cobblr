// Configuration → Devices → Stations (#4640): approve a tablet, open a
// station's address, and stop a tablet.
//
// A station is an address (/station/<workspace>/pantry). Opening it on a
// tablet shows a six-character code; approving the code here gives that tablet
// a token that reaches only that station. The tablet's QR opens this tab with
// the code filled in.
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { Copy, Monitor } from "lucide-react";
import { MutationError, useToast } from "@cobblr/platform-web";
import { DEFAULT_STATION_ADDRESS, isStationAddress, normalizeStationCode } from "@cobblr/platform-contract/station-screen";
import { api } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function StationDevicesPanel() {
  const { activeSlug: slug } = useActiveOrg();
  const [params] = useSearchParams();
  const toast = useToast();
  const qc = useQueryClient();
  const [code, setCode] = useState(params.get("approve") ?? "");
  const [label, setLabel] = useState("");
  const [address, setAddress] = useState(DEFAULT_STATION_ADDRESS);
  const canvas = useRef<HTMLCanvasElement | null>(null);

  const devices = useQuery({ queryKey: ["station-devices", slug], queryFn: () => api.listStationDevices(slug).then((r) => r.items) });
  const approve = useMutation({
    mutationFn: () => api.approveStation(slug, code, label.trim() || undefined),
    onSuccess: (r) => {
      toast.success(`Approved. That screen is now the ${r.label} station.`);
      setCode("");
      setLabel("");
      void qc.invalidateQueries({ queryKey: ["station-devices", slug] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeStationDevice(slug, id),
    onSuccess: () => {
      toast.success("That screen is stopped.");
      void qc.invalidateQueries({ queryKey: ["station-devices", slug] });
    },
  });

  const link = isStationAddress(address) ? `${window.location.origin}/station/${slug}/${address}` : "";
  useEffect(() => {
    if (link && canvas.current) void QRCode.toCanvas(canvas.current, link, { width: 168, margin: 4 });
  }, [link]);

  const codeOk = !!normalizeStationCode(code);

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-line p-4 dark:border-slate-700">
        <h2 className="text-base font-semibold">Approve a screen</h2>
        <p className="mt-1 text-sm text-muted">Type the code a tablet shows when it opens a station address.</p>
        <form
          className="mt-3 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (codeOk) approve.mutate();
          }}
        >
          <label className="text-sm">
            <span className="mb-1 block text-muted">Code</span>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="ABC234"
              autoCapitalize="characters"
              className="w-40 rounded-lg border border-line px-3 py-2 font-mono text-lg tracking-widest dark:border-slate-600 dark:bg-slate-800"
              aria-label="Code the screen shows"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-muted">Name (optional)</span>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Pantry" className="w-48 rounded-lg border border-line px-3 py-2 dark:border-slate-600 dark:bg-slate-800" />
          </label>
          <button type="submit" disabled={!codeOk || approve.isPending} className="rounded-lg bg-cobble-600 px-4 py-2 font-medium text-white disabled:opacity-40">
            {approve.isPending ? "Approving…" : "Approve"}
          </button>
        </form>
        {approve.error && <p className="mt-2 text-sm text-red-700 dark:text-red-300">{errText(approve.error)}</p>}
      </section>

      <section className="rounded-xl border border-line p-4 dark:border-slate-700">
        <h2 className="text-base font-semibold">Open a station on a tablet</h2>
        <p className="mt-1 text-sm text-muted">
          Each station has its own address. Open it on the tablet (scan this QR with it), plug in or pair a barcode scanner, and approve the code it shows. Add it to the tablet's home screen to keep it one tap away.
        </p>
        <div className="mt-3 flex flex-wrap items-start gap-4">
          <div className="space-y-2">
            <label className="block text-sm">
              <span className="mb-1 block text-muted">Address</span>
              <input
                value={address}
                onChange={(e) => setAddress(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
                className="w-56 rounded-lg border border-line px-3 py-2 dark:border-slate-600 dark:bg-slate-800"
                aria-label="Station address"
              />
            </label>
            {link ? (
              <div className="flex items-center gap-2 text-sm">
                <code className="break-all">{link}</code>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 dark:border-slate-600"
                  onClick={() => void navigator.clipboard?.writeText(link).then(() => toast.success("Link copied"))}
                >
                  <Copy size={14} /> Copy link
                </button>
              </div>
            ) : (
              <p className="text-sm text-red-700 dark:text-red-300">Lowercase words and dashes, like pantry or garage-bench.</p>
            )}
            {link && (
              <a href={link} className="inline-flex items-center gap-1.5 text-sm text-cobble-700 underline dark:text-cobble-300">
                <Monitor size={14} /> Open it here
              </a>
            )}
          </div>
          {/* White in both themes: a tablet's camera reads dark on light. */}
          {link && <canvas ref={canvas} className="rounded-lg bg-white dark:bg-white" aria-label="QR code that opens the station" />}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-base font-semibold">Approved screens</h2>
        {devices.isPending ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : !devices.data?.length ? (
          <p className="text-sm text-muted">No screen is approved yet.</p>
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line dark:divide-slate-700 dark:border-slate-700">
            {devices.data.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="font-medium">{d.label}</div>
                  <div className="text-sm text-muted">
                    /station/{slug}/{d.address} · approved by {d.approved_by} · {d.last_used_at ? `last used ${new Date(d.last_used_at).toLocaleString()}` : "not used yet"}
                  </div>
                </div>
                <button
                  type="button"
                  // A refused stop says why below the list (MutationError).
                  onClick={() => revoke.mutate(d.id)}
                  disabled={revoke.isPending}
                  className="rounded-lg border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950/40"
                >
                  Stop this screen
                </button>
              </li>
            ))}
          </ul>
        )}
        <MutationError mutation={revoke} className="mt-2" />
      </section>
    </div>
  );
}
