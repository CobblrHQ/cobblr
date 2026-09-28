// One thing kept in several places: the card's top line and a row per place.
//
// The same rows on the list card and on the detail, so the two cannot count a
// supply differently. Each row is a record of its own (a holding, paired to the
// card), so its stepper, minimum and low flag are that place's: an ambulance
// short of gauze says so even when the closet holds plenty.
// See docs/design-decisions/holdings-and-units.md.

import { Link } from "react-router-dom";
import { AlertTriangle, MapPin } from "lucide-react";
import { dayHere } from "@cobblr/platform-contract/day";
import { expiryPhrase, expiryState } from "@cobblr/platform-contract/expiry-grace";
import type { CardRollup } from "@cobblr/platform-contract/holdings";
import type { HoldingRow } from "./api";
import { QtyStepper } from "./QtyStepper";

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : String(parseFloat(n.toFixed(3)));
}

/** "expires in 3d" for the soonest date, the one countdown every surface shows. */
export function goesOffWords(expiresOn: string | null): string | null {
  if (!expiresOn) return null;
  const r = expiryState(expiresOn, 0, dayHere());
  return r ? expiryPhrase(r) : null;
}

/** The card's top line: how many, in how many places, low where, off when. */
export function RollupLine({ rollup, unit }: { rollup: CardRollup; unit?: string }) {
  const off = goesOffWords(rollup.soonest_expiry);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-mono text-muted dark:text-slate-400" data-testid="holdings-rollup">
      <span className="text-content dark:text-mortar-100 font-semibold">
        {fmt(rollup.qty)}
        {unit ? ` ${unit}` : ""} in all
      </span>
      <span>
        {rollup.places} {rollup.places === 1 ? "place" : "places"}
      </span>
      {rollup.low && (
        <span className="inline-flex items-center gap-1 text-ember-600 dark:text-ember-400">
          <AlertTriangle size={10} /> low in {rollup.low_count}
        </span>
      )}
      {off && <span>soonest {off}</span>}
    </div>
  );
}

/** A row per place. `basePath` links each place's row to its own record. */
export function HoldingRows({
  rows,
  basePath,
  onSplit,
}: {
  rows: HoldingRow[];
  basePath: string;
  /** Offered on a holding's row (never the card's own): make it a record of
   *  its own again. */
  onSplit?: (row: HoldingRow) => void;
}) {
  return (
    <ul className="mt-1.5 divide-y divide-line dark:divide-slate-800 rounded-md border border-line dark:border-slate-700" data-testid="holding-rows">
      {rows.map((r) => {
        const off = goesOffWords(r.expires_on);
        return (
          <li
            key={r.id}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1.5 text-[12px]"
            data-testid="holding-row"
            onClick={(e) => e.stopPropagation()}
          >
            <Link
              to={`${basePath}/parts/${r.id}`}
              className="inline-flex items-center gap-1 min-w-0 flex-1 basis-32 text-content dark:text-mortar-100 hover:text-accent"
            >
              <MapPin size={11} className="shrink-0 text-faint" />
              <span className="truncate">{r.location_name ?? "No place set"}</span>
            </Link>
            <span className="inline-flex items-center gap-1 font-mono text-[11px]">
              <QtyStepper partId={r.id} qty={r.qty} size="sm" />
            </span>
            <span className="font-mono text-[11px] text-muted dark:text-slate-400">min {r.min_qty == null ? "—" : fmt(r.min_qty)}</span>
            {r.low && (
              <span className="inline-flex items-center gap-1 text-[10px] text-ember-600 dark:text-ember-400 border border-ember-200 dark:border-ember-800 rounded px-1.5 py-0.5">
                <AlertTriangle size={10} /> low
              </span>
            )}
            {off && <span className="font-mono text-[11px] text-muted dark:text-slate-400">{off}</span>}
            {onSplit && !r.own && (
              <button
                type="button"
                onClick={() => onSplit(r)}
                className="ml-auto text-[11px] text-muted hover:text-accent"
                title="Make this place's stock a record of its own"
              >
                Split into its own
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
