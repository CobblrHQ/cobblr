// "Move to…" on the selection bar: pick a place from a popover on the bar,
// confirm in the same popover, and undo from the toast. The list stays in
// view the whole time (FooterActionPopover says why it is not a modal).
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightLeft } from "lucide-react";
import { FooterActionPopover, MoveToInstancePanel, MoveToChoices, noteRecentPlace, useCan, useToast, type PlaceChoice } from "@cobblr/platform-web";
import { countOf } from "@cobblr/platform-contract";
import { useInventory } from "./context";
import { placeOfRow, putPart, type PartPlace } from "./move-part";
import type { Location } from "./api";

interface Row {
  id: string;
  location_id: string | null;
  location_name: string | null;
}

/** Each place with where it is ("in Garage"), from the parent chain. */
export function placeChoices(locations: Location[]): PlaceChoice[] {
  const byId = new Map(locations.map((l) => [l.id, l]));
  return locations.map((l) => {
    const up: string[] = [];
    for (let p = l.parent_id ? byId.get(l.parent_id) : undefined; p && up.length < 6; p = p.parent_id ? byId.get(p.parent_id) : undefined) up.push(p.name);
    return { id: l.id, name: l.name, line: up.length ? `in ${up.join(", in ")}` : null };
  });
}

/** `listMove`: these may also go to another list of the same kind (a list,
 *  not a place), offered as a second step in the same popover. */
type ListMove = { fromInstance: string };

/** `onMoved` clears the list's ticks and may return what Undo calls to tick them again. */
export function BulkMoveToPlace({ rows, onMoved, listMove, label = "Move to…" }: { rows: Row[]; onMoved: () => (() => void) | void; listMove?: ListMove; label?: string }) {
  const mayMove = useCan("inventory:update-part");
  if (!mayMove) return null;
  return (
    <FooterActionPopover label={label} icon={<ArrowRightLeft size={12} />} title="Move to a place" data-testid="bulk-move">
      {(close) => <MoveBody rows={rows} close={close} onMoved={onMoved} listMove={listMove} />}
    </FooterActionPopover>
  );
}

function MoveBody({ rows, close, onMoved, listMove }: { rows: Row[]; close: () => void; onMoved: () => (() => void) | void; listMove?: ListMove }) {
  const { api, orgSlug, itemNoun, getToken } = useInventory();
  const [toList, setToList] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const [choice, setChoice] = useState<PlaceChoice | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locs = useQuery({ queryKey: ["inventory-locations"], queryFn: () => api.listLocations() });
  const holders = useQuery({ queryKey: ["placement-holders"], queryFn: () => api.listHolders() });
  const things = countOf(rows.length, itemNoun);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["inventory-parts"] });
    void qc.invalidateQueries({ queryKey: ["inventory-part"] });
    void qc.invalidateQueries({ queryKey: ["placement-path"] });
    void qc.invalidateQueries({ queryKey: ["placement-holders"] });
    void qc.invalidateQueries({ queryKey: ["inventory-family"] });
  };

  async function move(to: PlaceChoice) {
    setBusy(true);
    setError(null);
    const dest: PartPlace = to.holderKind ? { location_id: null, inside: { kind: to.holderKind, id: to.id } } : { location_id: to.id, inside: null };
    const moved: Array<{ id: string; from: PartPlace }> = [];
    let failure: string | null = null;
    for (const row of rows) {
      try {
        const from = await placeOfRow(api, row);
        await putPart(api, row.id, dest, from);
        moved.push({ id: row.id, from });
      } catch (e) {
        failure = (e as Error).message;
        break;
      }
    }
    setBusy(false);
    refresh();
    if (moved.length === 0) {
      setError(failure ?? "Nothing was moved.");
      return;
    }
    noteRecentPlace(orgSlug, to);
    close();
    const tickAgain = onMoved();
    const said = moved.length === rows.length ? `Moved ${things} to ${to.name}.` : `Moved ${moved.length} of ${rows.length} to ${to.name}. ${failure}`;
    toast.action(said, {
      actionLabel: "Undo",
      duration: 10_000,
      onAction: async () => {
        let back = 0;
        for (const m of moved) {
          try {
            await putPart(api, m.id, m.from, dest);
            back++;
          } catch {
            /* moved again since, or gone: it stays where it is */
          }
        }
        refresh();
        tickAgain?.();
        if (back === moved.length) toast.success(`Put ${countOf(back, itemNoun)} back.`);
        else toast.error(`Put ${back} of ${moved.length} back; the rest had moved again or are gone.`);
      },
    });
  }

  if (toList && listMove) {
    return (
      <div className="overflow-y-auto p-3">
        <MoveToInstancePanel
          slug={orgSlug}
          getToken={getToken}
          moduleName="inventory"
          fromInstance={listMove.fromInstance}
          ids={rows.map((r) => r.id)}
          noun={itemNoun}
          onClose={() => setToList(false)}
          onMoved={(n, where, undo) => {
            close();
            const tickAgain = onMoved();
            void qc.invalidateQueries();
            toast.action(`Moved ${countOf(n, itemNoun)} to ${where}.`, {
              actionLabel: "Undo",
              duration: 10_000,
              onAction: async () => {
                await undo();
                void qc.invalidateQueries();
                tickAgain?.();
              },
            });
          }}
        />
      </div>
    );
  }

  if (choice) {
    return (
      <div className="space-y-3 p-3" data-testid="bulk-move-confirm">
        <p className="text-sm text-content dark:text-mortar-100">
          Move {things} to <span className="font-semibold">{choice.name}</span>
          {choice.line ? <span className="text-muted dark:text-slate-400">, {choice.line}</span> : null}?
        </p>
        {error && (
          <p role="alert" className="text-sm text-ember-600 dark:text-ember-400">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" disabled={busy} onClick={() => setChoice(null)} className="rounded-md border border-line dark:border-slate-600 px-3 py-1.5 text-sm">
            Back
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void move(choice)}
            className="rounded-md bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white px-3 py-1.5 text-sm font-medium"
          >
            {busy ? "Moving…" : `Move ${things}`}
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      {locs.isPending ? (
        <p className="p-3 text-sm text-muted">Loading places…</p>
      ) : (
        <MoveToChoices
          slug={orgSlug}
          places={placeChoices(locs.data?.items ?? [])}
          holders={(holders.data?.items ?? []).map((h) => ({ id: h.id, name: h.title, line: h.line ? `in ${h.line}` : null, holderKind: h.kind }))}
          exclude={new Set(rows.map((r) => r.id))}
          onPick={setChoice}
        />
      )}
      {listMove && (
        <button
          type="button"
          onClick={() => setToList(true)}
          className="border-t border-line dark:border-slate-800 px-3 py-2 text-left text-xs text-muted hover:text-accent"
        >
          Move to another list instead…
        </button>
      )}
    </>
  );
}
