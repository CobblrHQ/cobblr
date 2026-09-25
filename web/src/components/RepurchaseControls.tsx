// The three answers to "you already have one of these, and you just scanned
// another", in the kind's own words. ONE implementation, because TWO surfaces
// show the match: the full TrackedMatchBanner (expanded card, result modal)
// and the scan inbox card's own condensed line. When each drew its own
// buttons they drifted within a day: the banner had three while the card
// still showed the retired "this buy was" chips and a bare "+1 to it"
// (reported 2026-09-09).
//
// The WORDS come from what the collection wears (the faces verdict, through
// repurchaseWords in the contract's kind-label seam), never from here: a
// second copy of The Hobbit was offered the pantry's three (the 2026-09-13
// review). Stock is counted and consumed; one of a thing is kept, so it gets
// "Another copy" and "Same book, replacing the old one"; waste is offered
// only where the face says the thing goes off.
//
// Which answer is primary is decided by what the ledger and the record
// already know: stock that is past its expiry date makes "went bad" the
// obvious one; an empty shelf leaves only "+N to it"; otherwise the everyday
// re-buy, "replaced", leads.
import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, PackagePlus, RefreshCw } from "lucide-react";
import { HeaderMenu, MenuItem } from "./HeaderMenu";
import { useFaces, useToast } from "@cobblr/platform-web";
import { repurchaseWords, type RestockChoice } from "@cobblr/platform-contract/kind-label";
import { api, ApiError, type TrackedMatch } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useKindLabels } from "../lib/useKindLabels";
import { leadAnswer } from "../lib/repurchaseAnswer";
import { scanInboxKeys } from "../lib/scan-inbox-keys";

export type RepurchaseMode = "add-qty" | "replace";
type Resolution = "over_buy" | "consumed" | "discarded";

export interface AttachResult {
  entity_title: string;
  new_qty: number | null;
  prev_location_id: string | null;
}

/** The best tracked match for a scan and the name of where it lives. The inbox
 *  card only carries a cached title, so this resolves the record from the same
 *  endpoint the banner uses; a caller that already holds the match passes it
 *  and no request is made. */
export function useBestTrackedMatch(itemId: string, matchProp?: TrackedMatch | null) {
  const { activeSlug } = useActiveOrg();
  const resolved = useQuery({
    queryKey: ["scan-tracked", activeSlug, itemId],
    queryFn: () => api.scanTrackedMatches(activeSlug, itemId),
    enabled: !matchProp && !!itemId,
    staleTime: 60_000,
  });
  const match: TrackedMatch | null =
    matchProp ??
    (resolved.data?.barcode_matches ?? []).concat(resolved.data?.name_matches ?? [])[0] ??
    null;
  const locations = useQuery({
    queryKey: ["core-locations", activeSlug],
    queryFn: () => api.listLocations(activeSlug),
    enabled: !!activeSlug && !!match?.location_id,
    staleTime: 60_000,
  });
  const where = match?.location_id
    ? ((locations.data?.items ?? []).find((l) => l.id === match.location_id)?.name ?? null)
    : null;
  return { match, where };
}

const pill = {
  primary: "bg-emerald-600 hover:bg-emerald-700 text-white",
  secondary:
    "border border-emerald-400 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100/60 dark:hover:bg-emerald-900/30",
};

export type RepurchaseLayout = "pills" | "stack";

/** The restock answers a scan of a record you already have can give, in the
 *  collection's own words: ONE list for the detail, the card and the File N
 *  plan. Pure. */
export function repurchaseOptions(words: ReturnType<typeof repurchaseWords>): Array<{ key: RepurchaseChoice["key"]; label: string; title?: string }> {
  return [
    words.replace ? { key: "replaced" as const, label: words.replace.label, title: words.replace.title } : null,
    { key: "add" as const, label: words.add.label, title: words.add.title || undefined },
    words.wentBad ? { key: "went_bad" as const, label: words.wentBad.label, title: words.wentBad.title } : null,
  ].filter((x): x is NonNullable<typeof x> => !!x);
}

export interface RepurchaseChoice {
  key: RestockChoice;
  label: string;
  title?: string;
  run: () => void;
}

/** The restock choices for a scan that matched a record the workspace
 *  counts: +1 (still had some), Replaced (the one that ran out), Old one went
 *  bad. ONE list, read by the detail's "Is this the same one?" and by the
 *  inbox card, so the two can never offer different answers (the owner,
 *  2026-09-24: "the key buttons have not been transferred over to the scan
 *  inbox card"). Null until the collection's faces are known. */
export function useRepurchaseChoices(
  itemId: string,
  match: TrackedMatch | null,
  quantity: number,
  onDone?: (result: AttachResult, match: TrackedMatch, mode: RepurchaseMode) => void,
): { answers: RepurchaseChoice[]; lead: RepurchaseChoice["key"]; busy: boolean; hasSome: boolean; daysLeft: number | null; ledgerLine: boolean } | null {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const kind = match?.kind ?? "";
  const worn = useFaces(kind);
  const face = match && worn.verdict ? { stock: worn.on.has("stock"), perishable: worn.on.has("perishable") } : null;
  const noun = useKindLabels(activeSlug).noun(kind);
  const cadence = useQuery({
    queryKey: ["cadence-state", activeSlug, kind, match?.id, match?.expired],
    queryFn: () => api.cadenceState(activeSlug, kind, match!.id, { expired: !!match!.expired }).catch(() => null),
    enabled: !!match && match.qty != null && match.qty > 0 && face?.stock === true,
    staleTime: 60_000,
  });
  const cad = cadence.data ?? null;
  const daysLeft = cad?.days_until_runout != null ? Math.round(cad.days_until_runout) : null;
  const attach = useMutation({
    mutationFn: (vars: { mode: RepurchaseMode; resolution?: Resolution; label: string }) =>
      api.scanAttach(activeSlug, itemId, {
        kind: match!.kind,
        entity_id: match!.id,
        instance: match!.instance ?? undefined,
        mode: vars.mode,
        ...(vars.resolution ? { cadence: { resolution: vars.resolution } } : {}),
      }),
    onSuccess: (r, vars) => {
      void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
      // The toast leads with the exact label of the button pressed (#3339).
      const now = r.new_qty != null ? ` (now ×${r.new_qty})` : "";
      toast.success(`${vars.label}: ${r.entity_title}${now}`);
      onDone?.(r, match!, vars.mode);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  if (!match || match.qty == null || !face) return null;
  const hasSome = match.qty > 0;
  const words = repurchaseWords(face, noun, quantity, hasSome);
  const led = leadAnswer(match, cad?.repurchase_means);
  const lead = led === "went_bad" && !words.wentBad ? "replaced" : led;
  if (!lead) return null;
  const runs: Record<RepurchaseChoice["key"], () => void> = {
    replaced: () => attach.mutate({ mode: "replace", resolution: "consumed", label: words.replace!.label }),
    add: () => attach.mutate({ mode: "add-qty", ...(hasSome ? { resolution: "over_buy" as const } : {}), label: words.add.label }),
    went_bad: () => attach.mutate({ mode: "replace", resolution: "discarded", label: words.wentBad!.label }),
  };
  const answers: RepurchaseChoice[] = repurchaseOptions(words).map((o) => ({ ...o, run: runs[o.key] }));
  return { answers, lead, busy: attach.isPending, hasSome, daysLeft, ledgerLine: !!words.ledgerLine };
}

export function RepurchaseAnswers({
  itemId,
  match,
  quantity,
  onDone,
  layout = "pills",
}: {
  itemId: string;
  match: TrackedMatch;
  /** How many this scan is adding. */
  quantity: number;
  onDone?: (result: AttachResult, match: TrackedMatch, mode: RepurchaseMode) => void;
  /** `pills`: the desk's wrapping row. `stack`: a phone's grid, the three
   *  answers one height and one affordance, the lead first and full width,
   *  the other two side by side and no smaller (#3339: the two that were not
   *  the default were the two hardest to hit, one-handed, at a stand). */
  layout?: RepurchaseLayout;
}) {
  const choices = useRepurchaseChoices(itemId, match, quantity, onDone);
  if (!choices) return null;
  const { lead, busy, hasSome, daysLeft } = choices;
  const stacked = layout === "stack";
  // One size for all three on a phone: the same height, padding, type and
  // shape; the lead keeps its fill, the others their outline, and none is a
  // smaller target than another. No icons and 13px type in the stack, so
  // every label fits its row on one line and the rows stay at the 40px
  // floor: the card must not grow (the owner's constraint, #3339).
  const cls = (primary: boolean) =>
    `inline-flex items-center gap-1 font-medium disabled:opacity-50 ${primary ? pill.primary : pill.secondary} ${
      stacked ? "justify-center rounded-lg px-2 py-1.5 text-[13px] leading-tight min-h-10 text-center" : "rounded-full px-2.5 py-1 text-xs"
    }`;
  const icons: Record<RepurchaseChoice["key"], ReactNode> = { replaced: <RefreshCw size={12} />, add: <PackagePlus size={12} />, went_bad: null };
  const answers = choices.answers.map((c) => ({ ...c, icon: stacked ? null : icons[c.key] }));
  // Stacked: the lead first and full width, the rest side by side; with two
  // answers, side by side; with one, full width.
  const span = (i: number) => (!stacked ? "" : answers.length === 3 ? (i === 0 ? "col-span-2" : "col-span-1") : answers.length === 2 ? "col-span-1" : "col-span-2");
  const ordered = stacked ? [...answers].sort((a, b) => Number(b.key === lead) - Number(a.key === lead)) : answers;
  const buttons = ordered.map((a, i) => (
    <button key={a.key} type="button" disabled={busy} title={a.title} onClick={a.run} className={`${cls(lead === a.key)} ${span(i)}`.trim()}>
      {a.icon} {a.label}
    </button>
  ));
  const ledger = choices.ledgerLine && hasSome && daysLeft != null && daysLeft > 0 && (
    <span className={`self-center text-[11px] text-muted ${stacked ? "col-span-2" : ""}`} title="What the cadence ledger expects from your past buys">
      ~{daysLeft} {daysLeft === 1 ? "day" : "days"} of the last one left
    </span>
  );
  if (stacked) {
    return (
      <div className="grid w-full grid-cols-2 auto-rows-fr gap-1" data-testid="repurchase-stack">
        {buttons}
        {ledger}
      </div>
    );
  }
  return (
    <>
      {buttons}
      {ledger}
    </>
  );
}

/** The card's side of the restock choices: every answer but the add (the
 *  card's own +1 more), one tap away in a small menu. Mounted only on a row
 *  that matched a counted record, so no other card pays for the hooks. */
export function CardRestockOther({ itemId, match, quantity }: { itemId: string; match: TrackedMatch; quantity: number }) {
  const choices = useRepurchaseChoices(itemId, match, quantity);
  const others = (choices?.answers ?? []).filter((c) => c.key !== "add");
  if (!others.length) return null;
  return (
    <HeaderMenu
      width={240}
      align="right"
      trigger={({ toggle }) => (
        <button
          type="button"
          data-testid="card-restock-other"
          onClick={(e) => {
            e.stopPropagation();
            toggle();
          }}
          className="shrink-0 inline-flex items-center gap-0.5 rounded-full border border-emerald-400 dark:border-emerald-700 px-2 py-1 text-xs text-emerald-700 dark:text-emerald-300"
        >
          Other <ChevronDown size={11} />
        </button>
      )}
    >
      {({ close }) => (
        <>
          {others.map((c) => (
            <MenuItem
              key={c.key}
              label={c.label}
              hint={c.title}
              disabled={choices?.busy}
              onClick={() => {
                close();
                c.run();
              }}
            />
          ))}
        </>
      )}
    </HeaderMenu>
  );
}

/** The phone row's side: the same answers, as the first entries of its ⋯.
 *  A render prop, so the hooks run only for a row with a match. */
export function WithRestockChoices({ itemId, match, quantity, children }: { itemId: string; match: TrackedMatch | null; quantity: number; children: (others: RepurchaseChoice[]) => ReactNode }) {
  if (!match) return <>{children([])}</>;
  return <WithRestockChoicesInner itemId={itemId} match={match} quantity={quantity}>{children}</WithRestockChoicesInner>;
}
function WithRestockChoicesInner({ itemId, match, quantity, children }: { itemId: string; match: TrackedMatch; quantity: number; children: (others: RepurchaseChoice[]) => ReactNode }) {
  const choices = useRepurchaseChoices(itemId, match, quantity);
  return <>{children((choices?.answers ?? []).filter((c) => c.key !== "add"))}</>;
}

/** The File N plan's side: the same answers as a choice on a line that adds
 *  to a record you already have. The plan files by it (seen[].restock). */
export function RestockPlanChoice({ kind, qty, hasSome, value, onChange }: { kind: string; qty: number; hasSome: boolean; value: RepurchaseChoice["key"]; onChange: (v: RepurchaseChoice["key"]) => void }) {
  const { activeSlug } = useActiveOrg();
  const worn = useFaces(kind);
  const noun = useKindLabels(activeSlug).noun(kind);
  if (!worn.verdict) return null;
  const options = repurchaseOptions(repurchaseWords({ stock: worn.on.has("stock"), perishable: worn.on.has("perishable") }, noun, qty, hasSome));
  if (options.length < 2) return null;
  return (
    <select
      value={value}
      data-testid="plan-restock"
      aria-label="What this one means for what you have"
      onChange={(e) => onChange(e.target.value as RepurchaseChoice["key"])}
      className="shrink-0 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-1.5 py-0.5 text-xs text-content dark:text-mortar-100"
    >
      {options.map((o) => (
        <option key={o.key} value={o.key}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

