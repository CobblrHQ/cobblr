// An order line's units on its card (#5734). The owner: "The important
// distinction is 10 different things vs qty 10 of the same thing." The line
// says which, switched in one tap; a line of the same thing counts its units
// as they are scanned in, and can split off the few that differ. A scan that
// looks like one of an open line's units is offered to it.
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { NumberStepper, useToast } from "@cobblr/platform-web";
import { lineReceivedSentence, lineUnitsOf, lineUnitsSentence, lineUnitsSwitchLabel } from "@cobblr/platform-contract/line-units";
import { api, ApiError, type ScanInboxItem } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { scanInboxKeys } from "../lib/scan-inbox-keys";

const pill = "inline-flex items-center gap-1 rounded-full border border-line dark:border-slate-700 px-2.5 py-1 text-xs font-medium text-content dark:text-mortar-100 hover:bg-subtle disabled:opacity-50";

function useRowMutation<T>(fn: () => Promise<T>, done?: (r: T) => void) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
      done?.(r);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
}

/** What a pending order line holds, and what can be done about it. */
export function OrderLineUnits({ item }: { item: ScanInboxItem }) {
  const { activeSlug } = useActiveOrg();
  const navigate = useNavigate();
  const meta = (item.suggested_metadata ?? {}) as { line_received?: unknown; split_off_from?: unknown };
  const units = item.source_kind === "receipt" && item.status === "pending" ? lineUnitsOf(item) : null;
  const received = Number(meta.line_received ?? 0);
  const [offOpen, setOffOpen] = useState(false);
  const [offCount, setOffCount] = useState(1);
  const [offName, setOffName] = useState("");
  const toggle = useRowMutation(() => api.setLineUnits(activeSlug, item.id, units?.mode === "same" ? "different" : "same"));
  const splitOff = useRowMutation(() => api.splitOffUnits(activeSlug, item.id, offCount, offName.trim() || undefined), () => {
    setOffOpen(false);
    setOffName("");
  });
  const rejoin = useRowMutation(() => api.rejoinOrderLine(activeSlug, item.id));
  const scanIn = useRowMutation(() => api.scanTheItems(activeSlug, item.id), (r) => navigate(`/scan?batch=${r.batch_id}`));
  // The last scan counted toward the line was not one of its units after all.
  const takeBack = useRowMutation(async () => {
    const slots = await api.orderLineSlots(activeSlug, { line_id: item.id });
    const last = slots.units.at(-1);
    if (!last) throw new Error("No scan is counted toward this line.");
    return api.unfillOrderLine(activeSlug, last.id);
  });
  const splitOffFrom = typeof meta.split_off_from === "string" && item.status === "pending";
  if (!units && !splitOffFrom) return null;
  return (
    <div className="space-y-1.5" data-testid="order-line-units">
      {units && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium text-content dark:text-mortar-100" data-testid="line-units-sentence">
            {lineUnitsSentence(units)}
          </span>
          {units.mode === "same" && received > 0 && (
            <>
              <span className="text-xs text-muted" data-testid="line-received">
                · {lineReceivedSentence(received, units.count)}
              </span>
              <button type="button" className={pill} disabled={takeBack.isPending} onClick={() => takeBack.mutate()}>
                Take the last one back
              </button>
            </>
          )}
          <button type="button" className={pill} disabled={toggle.isPending} onClick={() => toggle.mutate()} data-testid="line-units-switch">
            {lineUnitsSwitchLabel(units)}
          </button>
          {units.mode === "same" && received < units.count && (
            <button type="button" className={pill} disabled={scanIn.isPending} onClick={() => scanIn.mutate()}>
              Scan the items
            </button>
          )}
          {units.mode === "same" && (
            <button type="button" className={pill} aria-expanded={offOpen} onClick={() => setOffOpen((o) => !o)}>
              Split off…
            </button>
          )}
        </div>
      )}
      {units && offOpen && (
        <form
          className="flex flex-wrap items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            splitOff.mutate();
          }}
        >
          <span className="text-xs text-muted">How many differ</span>
          <NumberStepper value={offCount} onChange={setOffCount} min={1} max={units.count - 1} label="How many differ" testId="split-off-count" />
          <input
            type="text"
            placeholder="What they are"
            value={offName}
            onChange={(e) => setOffName(e.target.value)}
            className="min-w-0 flex-1 rounded border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-1.5 py-0.5 text-xs"
          />
          <button type="submit" className={pill} disabled={splitOff.isPending}>
            Split off {offCount}
          </button>
        </form>
      )}
      {splitOffFrom && (
        <button type="button" className={pill} disabled={rejoin.isPending} onClick={() => rejoin.mutate()}>
          Put back into its line
        </button>
      )}
    </div>
  );
}

/** "Part of Kingroon 3D #KR52731, line 1?" on a scan that looks like one of
 *  an open line's units. Yes counts it there; no stops asking. */
export function OrderLineOffer({ item }: { item: ScanInboxItem }) {
  const { activeSlug } = useActiveOrg();
  const offer = (item.suggested_metadata as { line_offer?: { line_id?: unknown; label?: unknown } } | null)?.line_offer;
  const lineId = typeof offer?.line_id === "string" ? offer.line_id : null;
  const yes = useRowMutation(() => api.fillOrderLine(activeSlug, item.id, lineId ?? ""));
  const no = useRowMutation(() => api.declineLineOffer(activeSlug, item.id));
  if (!lineId || item.status !== "pending" || typeof offer?.label !== "string") return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-emerald-300 dark:border-emerald-800 px-2 py-1.5" data-testid="line-offer">
      <span className="text-xs text-content dark:text-mortar-100">{offer.label}</span>
      <button type="button" className={pill} disabled={yes.isPending} onClick={() => yes.mutate()}>
        Yes, count it
      </button>
      <button type="button" className={pill} disabled={no.isPending} onClick={() => no.mutate()}>
        No
      </button>
    </div>
  );
}

/** A purchase's line of several, not yet received: scan its units in. Opens
 *  the scan page on a session bound to the line's inbox row. */
export function OrderLineScanIn({ itemId }: { itemId: string }) {
  const { activeSlug } = useActiveOrg();
  const navigate = useNavigate();
  const toast = useToast();
  const start = useMutation({
    mutationFn: async () => {
      const slots = await api.orderLineSlots(activeSlug, { order_item_id: itemId });
      return api.scanTheItems(activeSlug, slots.line_id);
    },
    onSuccess: (r) => navigate(`/scan?batch=${r.batch_id}`),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  return (
    <button type="button" className={pill} disabled={start.isPending} onClick={() => start.mutate()} data-testid="order-line-scan-in">
      Scan the items
    </button>
  );
}

/** The scan page on a session opened from a line: how many of its units are
 *  in, as each scan is counted. */
export function ScanningInBanner({ batchId }: { batchId: string }) {
  const { activeSlug } = useActiveOrg();
  const slots = useQuery({
    queryKey: ["order-line-slots", activeSlug, batchId],
    queryFn: () => api.orderLineSlots(activeSlug, { batch_id: batchId }).catch(() => null), // quiet: a session that is not bound to a line has no banner
    refetchInterval: 4000,
  });
  const s = slots.data;
  if (!s) return null;
  return (
    <div className="rounded-md border border-emerald-300 dark:border-emerald-800 px-3 py-2 text-sm text-content dark:text-mortar-100" data-testid="scanning-in">
      Scanning in {s.name ?? "an order line"}: <span className="font-medium">{s.sentence}</span>
    </div>
  );
}
