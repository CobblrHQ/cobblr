import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Minus, Plus } from "lucide-react";
import { runAction, useFaces, useToast } from "@cobblr/platform-web";
import {
  SCAN_COUNT_REASON_LABEL,
  SHOPPING_LIST_DOOR,
  scanCountBody,
  scanCountReasonsFor,
  scanCountResult,
  scanCountStart,
  type ScanCountMode,
  type ScanCountSessionMode,
  type ScanCountReason,
} from "@cobblr/platform-contract/scan-count";
import { api, ApiError, type TrackedMatch } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { scanInboxKeys } from "../lib/scan-inbox-keys";

export interface ScanCountDone {
  entity_title: string;
  new_qty: number | null;
  prev_location_id: string | null;
}

const MODE_TONE: Record<ScanCountMode, { box: string; on: string; result: string; save: string }> = {
  change: {
    box: "border-emerald-300 dark:border-emerald-700/60",
    on: "bg-emerald-600 text-white",
    result: "text-emerald-800 dark:text-emerald-200",
    save: "bg-emerald-600 hover:bg-emerald-700 text-white",
  },
  set: {
    box: "border-amber-400 dark:border-amber-600/70 bg-amber-50/70 dark:bg-amber-950/20",
    on: "bg-amber-500 text-white",
    result: "text-amber-800 dark:text-amber-200",
    save: "bg-amber-500 hover:bg-amber-600 text-white",
  },
};

/** "+3", "−2", "0" in Change by; the plain number in Set total. */
function shown(mode: ScanCountMode, v: number): string {
  if (mode === "set") return String(v);
  return v > 0 ? `+${v}` : v < 0 ? `−${-v}` : "0";
}

/** What the person typed, read the way they meant it: "+200", "-1", "−1",
 *  "10". Null while it is not a number yet (an empty field, a lone sign). */
export function readTyped(text: string): number | null {
  const t = text.trim().replace(/^−/, "-");
  if (!/^[+-]?\d+$/.test(t)) return null;
  return Number(t);
}

/** Saving a count: the attach, the confirmation in words, and the shopping
 *  list when a take left the record low. ONE path for the full control and
 *  the phone row's compact stepper, so the two never file or say it
 *  differently. */
export function useScanCountSave(itemId: string, match: TrackedMatch, onDone?: (r: ScanCountDone, match: TrackedMatch) => void) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const lists = useQuery({
    queryKey: ["org-modules", activeSlug],
    queryFn: () => api.orgModules(activeSlug),
    enabled: !!activeSlug,
    staleTime: 30_000,
  });
  const listsOn = (lists.data?.items ?? []).some((m) => m.name === SHOPPING_LIST_DOOR.module && m.enabled);
  const addToList = async (title: string) => {
    try {
      // The one action door, in its hook-free form: every inbox card calls this
      // hook, and a card must not need the platform provider to render.
      // PRESS-ARGS: add-item takes its title from the record and its list defaults to the shopping list.
      await runAction(api, qc, activeSlug, { actionId: SHOPPING_LIST_DOOR.action, entityKind: match.kind, entityId: match.id, args: {} });
      toast.success(`${title} is on the shopping list`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };
  const save = useMutation({
    mutationFn: (v: { mode: ScanCountMode; value: number; reason?: ScanCountReason | null; undo?: boolean }) => {
      const body = scanCountBody(v.mode, v.value, v.reason);
      if (!body) throw new Error("Nothing to change");
      return api.scanAttach(activeSlug, itemId, {
        kind: match.kind,
        entity_id: match.id,
        instance: match.instance ?? undefined,
        mode: "count",
        ...body,
      });
    },
    onSuccess: (r, v) => {
      void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
      const now = r.new_qty != null ? ` (now ${r.new_qty})` : "";
      const said =
        v.mode === "set" ? `Set ${r.entity_title} to ${v.value}` : v.value > 0 ? `Added ${v.value} to ${r.entity_title}` : `Took ${-v.value} from ${r.entity_title}`;
      if (v.undo) {
        toast.action(`${said}${now}`, {
          actionLabel: "Undo",
          duration: 10_000,
          onAction: async () => {
            try {
              const restored = await api.unconfirmScanItem(activeSlug, itemId);
              void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
              void qc.invalidateQueries({ queryKey: ["scan-tracked", activeSlug, itemId] });
              toast.success(restored.note ?? `Undid the change to ${r.entity_title}`);
            } catch (e) {
              toast.error(e instanceof Error ? e.message : String(e));
            }
          },
        });
      } else if (r.low && listsOn) {
        toast.action(`${said}${now}`, { actionLabel: "Add to shopping list", onAction: () => addToList(r.entity_title), duration: 10_000 });
      } else {
        toast.success(`${said}${now}`);
      }
      onDone?.(r, match);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  return save;
}

/** The words on the button that saves a count: the contract's own "+1 more"
 *  for adding (so the card, the phone row and the session never name one
 *  action two ways), "Take 1", "Set total to 10". */
export function scanCountVerb(mode: ScanCountMode, value: number, have: number): string {
  if (mode === "set") return value === have ? `Already ${have}` : `Set total to ${value}`;
  if (value > 0) return `+${value} more`;
  if (value < 0) return `Take ${-value}`;
  return "Nothing to change";
}

export function ScanCountBlock({
  itemId,
  match,
  where,
  initialMode = "change",
  sessionMode,
  onDone,
}: {
  itemId: string;
  /** The record the scan matched; `qty` is what it says it has. */
  match: TrackedMatch;
  where?: string | null;
  /** Count mode on the camera opens in Set total; everywhere else, Change by. */
  initialMode?: ScanCountMode;
  sessionMode?: ScanCountSessionMode;
  onDone?: (r: ScanCountDone, match: TrackedMatch) => void;
}) {
  const worn = useFaces(match.kind);
  const perishable = worn.on.has("perishable");
  const stock = worn.on.has("stock");
  const have = Math.max(0, match.qty ?? 0);
  const [mode, setMode] = useState<ScanCountMode>(initialMode);
  const [value, setValue] = useState(() => scanCountStart(initialMode, have, sessionMode));
  const [text, setText] = useState(() => shown(initialMode, scanCountStart(initialMode, have, sessionMode)));
  const [reason, setReason] = useState<ScanCountReason | null>(null);
  // A new scan is a new card: it starts back in Change by (or Count mode's
  // Set total), whatever the last one was left on.
  useEffect(() => {
    const start = scanCountStart(initialMode, have, sessionMode);
    setMode(initialMode);
    setValue(start);
    setText(shown(initialMode, start));
    setReason(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId, initialMode, sessionMode, match.id]);

  // Taking can go down to nothing, never past it: the floor would take what
  // is there anyway, and a stepper that lets you ask for more reads as a lie.
  const floor = mode === "set" ? 0 : -have;
  const put = (v: number) => {
    let next = Math.max(floor, v);
    if (mode === "change" && next === 0) next = have > 0 && v < value ? -1 : 1;
    setValue(next);
    setText(shown(mode, next));
    if (mode === "change" && Math.sign(next) !== Math.sign(value)) setReason(null);
  };
  const switchTo = (m: ScanCountMode) => {
    if (m === mode) return;
    const start = scanCountStart(m, have, sessionMode);
    setMode(m);
    setValue(start);
    setText(shown(m, start));
    setReason(null);
  };
  const typed = readTyped(text);
  const body = typed == null || (mode === "change" && typed === 0) ? null : scanCountBody(mode, value, reason);
  const result = scanCountResult(mode, have, value);
  const reasons = mode === "change" && value > 0 ? scanCountReasonsFor(value, { stock, perishable }) : [];
  const takingReasons = scanCountReasonsFor(-1, { stock, perishable });
  const save = useScanCountSave(itemId, match, onDone);

  const tone = MODE_TONE[mode];
  // 40px floor: one-handed, at a shelf (#3339).
  const step = "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 text-content dark:text-mortar-100 disabled:opacity-40";
  return (
    <div
      data-testid="scan-count"
      data-mode={mode}
      onClick={(e) => e.stopPropagation()}
      className={`rounded-lg border px-2.5 py-2 space-y-2 ${tone.box}`}
    >
      {/* A row that wraps: at 320px with large text the switch and its
          caption do not fit one line, and an inline switch ran off the card. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <div role="radiogroup" aria-label="How this scan changes the count" className="inline-flex max-w-full flex-wrap rounded-full border border-line dark:border-slate-600 p-0.5 text-[11px] font-medium">
        {(["change", "set"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            onClick={() => switchTo(m)}
            className={`rounded-full px-2.5 py-0.5 transition ${mode === m ? MODE_TONE[m].on : "text-muted hover:text-content"}`}
          >
            {m === "change" ? "Change by" : "Set total"}
          </button>
        ))}
      </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" aria-label={mode === "set" ? "One fewer in total" : "One less"} disabled={value <= floor || (mode === "change" && have === 0)} onClick={() => put(value - 1)} className={step}>
          <Minus size={15} />
        </button>
        <input
          type="text"
          inputMode="numeric"
          aria-label={mode === "set" ? "Total" : "Change by"}
          value={text}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => {
            setText(e.target.value);
            const n = readTyped(e.target.value);
            if (n == null || (mode === "change" && n === 0)) return;
            const next = Math.max(floor, n);
            setValue(next);
            if (mode === "change" && Math.sign(next) !== Math.sign(value)) setReason(null);
          }}
          onBlur={() => setText(shown(mode, value))}
          className="h-10 w-16 rounded-md border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 text-center text-base font-semibold tabular-nums text-content dark:text-mortar-100"
        />
        <button type="button" aria-label={mode === "set" ? "One more in total" : "One more"} onClick={() => put(value + 1)} className={step}>
          <Plus size={15} />
        </button>
        <span data-testid="count-result" className={`min-w-0 text-sm ${tone.result}`}>
          {mode === "change" ? (
            <>
              You have {have} → <strong className="tabular-nums">{result}</strong>
            </>
          ) : (
            <>
              Total will be <strong className="tabular-nums">{result}</strong> <span className="text-muted">(was {have})</span>
            </>
          )}
          {where && <span className="text-muted"> · {where}</span>}
        </span>
      </div>
      {takingReasons.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" aria-label="Take one">
          {takingReasons.map((r) => (
            <button
              key={r}
              type="button"
              disabled={have === 0 || save.isPending}
              onClick={() => save.mutate({ mode: "change", value: -1, reason: r, undo: true })}
              className="inline-flex min-h-10 items-center rounded-full border border-line dark:border-slate-600 px-2.5 py-1 text-xs text-content dark:text-mortar-100 hover:bg-surface dark:hover:bg-slate-900 disabled:opacity-40"
            >
              {SCAN_COUNT_REASON_LABEL[r]}
            </button>
          ))}
        </div>
      )}
      {reasons.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" aria-label="Why (optional)">
          <span className="text-[11px] text-faint">Why?</span>
          {reasons.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={reason === r}
              onClick={() => setReason(reason === r ? null : r)}
              className={`rounded-full border px-2 py-0.5 text-[11px] transition ${
                reason === r ? "border-emerald-600 bg-emerald-600 text-white" : "border-line dark:border-slate-600 text-muted hover:text-content"
              }`}
            >
              {SCAN_COUNT_REASON_LABEL[r]}
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        data-testid="scan-count-save"
        disabled={!body || save.isPending || (mode === "set" && value === have)}
        onClick={() => save.mutate({ mode, value, reason })}
        className={`inline-flex min-h-10 items-center justify-center rounded-full px-3 py-1 text-sm font-medium disabled:opacity-50 ${tone.save}`}
      >
        {save.isPending ? "Saving…" : scanCountVerb(mode, value, have)}
      </button>
    </div>
  );
}
