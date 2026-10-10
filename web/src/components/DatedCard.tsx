// Everything dated in one collection, as one card: overdue, a Today line,
// then what is coming up (lib/attention-cards.ts composes it from the feed).
//
// Each row finishes the job where it is. Something that goes off offers Used
// up, Tossed and Still good (+3 days); a task is ticked; anything else opens.
// A finished row leaves the card at once, with Undo on the toast, because
// "Open" on every row sent a person to the record to do one tap there and
// back again, 22 times (the owner, 2026-09-28). A stale backlog can be
// cleared in one go, behind a confirm.
import { lazy, Suspense, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ArrowRight, CheckCircle2, ChevronDown } from "lucide-react";
import { useConfirm, useRunAction, useToast, type ActionRun } from "@cobblr/platform-web";
import { api, type AttentionFeedItem } from "../lib/api";
import { datedCounts, type DatedCardModel, type DatedGroup } from "../lib/attention-cards";
import { useDetailRoute } from "../lib/useDetailRoute";
import { countOf } from "@cobblr/platform-contract/plural";
// The merge sheet loads when it is opened (#4945).
const DuplicateRecordsSheet = lazy(() => import("../pages/DuplicateRecordsSheet").then((m) => ({ default: m.DuplicateRecordsSheet })));

type Entry = NonNullable<AttentionFeedItem["entries"]>[number];
/** An action's way back: the invoke route answers a list of steps, run in
 *  order (a single step is accepted too). */
type UndoStep = { action_id: string; args?: Record<string, unknown> };
const undoSteps = (u: unknown): UndoStep[] => (Array.isArray(u) ? u : u ? [u] : []).filter((s): s is UndoStep => !!s && typeof (s as UndoStep).action_id === "string");

type Finish = NonNullable<NonNullable<AttentionFeedItem["collection"]>["finish"]>[number];

// VOCAB-ENUMERATION OK: a short button word and a toast line for each thing a
// declared finishing verb can do; the verbs themselves come from the feed.
const WORDS: Record<Finish["finishes"], { button: string; done: string }> = {
  used: { button: "Used up", done: "Used up" },
  discarded: { button: "Tossed", done: "Tossed" },
  "still-good": { button: "+3 days", done: "Still good for 3 more days" },
};

export function DatedCard({ slug, card }: { slug: string; card: DatedCardModel }) {
  const [open, setOpen] = useState(false);
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  // PRESS-ARGS: the finishing verbs (used up, tossed, still good) require nothing; the card adds its timezone.
  const runAction = useRunAction();
  const toast = useToast();
  const confirm = useConfirm();
  const routeFor = useDetailRoute(slug);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { collection } = card;
  // Two of these rows for one thing ("Roma Tomatoes" and "Tomatoes Roma",
  // filed days apart) is the same question twice. The pairs come from the
  // one duplicate rule (core-scan duplicates), offered here, where they were
  // seen, rather than only on the scan page.
  const [merging, setMerging] = useState(false);
  const dupes = useQuery({
    queryKey: ["scan-duplicates", slug],
    queryFn: () => api.scanDuplicates(slug),
    enabled: open,
    staleTime: 60_000,
    retry: false,
  });
  const here = new Set([
    ...[card.overdue, card.today, card.upcoming].flatMap((g) => (g?.entries ?? []).map((e) => e.record?.id ?? e.id)),
    ...(card.overdue?.all_ids ?? []),
  ]);
  const pairs = (dupes.data?.pairs ?? []).filter((p) => p.kind === collection.key && (here.has(p.a.id) || here.has(p.b.id)));
  const late = card.collection.due === "window" ? "Past its best" : "Overdue";
  const tone = card.overdue
    ? "border-red-300 dark:border-red-800 bg-red-50/70 dark:bg-red-950/20"
    : card.today
      ? "border-amber-300 dark:border-amber-800 bg-amber-50/70 dark:bg-amber-950/20"
      : "border-line dark:border-slate-700 bg-surface dark:bg-slate-900";
  const hide = (id: string, on: boolean) =>
    setGone((g) => {
      const next = new Set(g);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const finishes = collection.finish ?? [];
  const toss = finishes.find((f) => f.finishes === "discarded");
  const finish = async (e: Entry, f: Finish) => {
    const rec = e.record;
    if (!rec) return;
    setBusy(`${e.id}:${f.action_id}`);
    try {
      const run: ActionRun = await runAction({ actionId: f.action_id, entityKind: rec.kind, entityId: rec.id, args: { timezone } });
      hide(e.id, true);
      const undo = undoSteps(run.undo);
      toast.action(`${WORDS[f.finishes].done}: ${rec.name}`, {
        actionLabel: "Undo",
        duration: 8000,
        onAction: async () => {
          for (const step of undo) await runAction({ actionId: step.action_id, entityKind: rec.kind, entityId: rec.id, args: step.args ?? {} });
          hide(e.id, false);
        },
      });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const tick = async (e: Entry) => {
    const task = e.action?.task;
    if (!task) return;
    setBusy(`${e.id}:task`);
    try {
      await api.request("PATCH", `/orgs/${slug}/modules/projects/tasks/${task}`, { status: "done" });
      hide(e.id, true);
      toast.action(`Done: ${e.record?.name ?? e.title}`, {
        actionLabel: "Undo",
        duration: 8000,
        onAction: async () => {
          await api.request("PATCH", `/orgs/${slug}/modules/projects/tasks/${task}`, { status: "todo" });
          hide(e.id, false);
        },
      });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const tossAll = async () => {
    const ids = (card.overdue?.all_ids ?? []).filter((id) => !gone.has(id));
    const kind = card.overdue?.entries?.[0]?.record?.kind;
    if (!kind || !toss || ids.length === 0) return;
    const ok = await confirm({
      title: `Mark all ${ids.length} as tossed?`,
      message: `Every ${late.toLowerCase()} item in ${collection.label} is recorded as thrown out, one each. Each one's record keeps its history.`,
      confirmLabel: `Toss ${ids.length}`,
      destructive: true,
    });
    if (!ok) return;
    setBusy("all");
    let done = 0;
    for (const id of ids) {
      try {
        await runAction({ actionId: toss.action_id, entityKind: kind, entityId: id, args: { timezone } });
        hide(id, true);
        done++;
      } catch {
        /* the count below says how many did not go */
      }
    }
    setBusy(null);
    if (done === ids.length) toast.success(`Tossed ${done}.`);
    else toast.error(`Tossed ${done} of ${ids.length}; the rest are still here.`);
  };

  const row = (e: Entry, overdue: boolean) => {
    const to = e.record ? routeFor(e.record.kind, e.record.id) : null;
    const name = e.record?.name ?? e.title;
    return (
      <li key={e.id} className="flex items-center gap-2 pl-9 pr-3 py-1.5 text-[13px]" data-testid="dated-entry">
        {e.action?.task && (
          <button
            type="button"
            onClick={() => void tick(e)}
            disabled={busy !== null}
            title="Mark done"
            className="shrink-0 w-4 h-4 rounded border border-line dark:border-slate-600 hover:border-accent hover:bg-accent/10 transition flex items-center justify-center"
          >
            <CheckCircle2 size={11} className="hover-reveal text-accent" />
          </button>
        )}
        {/* The name over when: on a phone three buttons leave the row little
            room, and "34d ago" cut to "34d …" was the one word that mattered. */}
        <span className="flex-1 min-w-0 flex flex-col leading-tight">
          {to ? (
            <Link to={to} className="truncate text-content dark:text-mortar-100 hover:text-accent">
              {name}
            </Link>
          ) : (
            <span className="truncate text-content dark:text-mortar-100">{name}</span>
          )}
          {e.when && (
            <span className={"text-[11px] " + (overdue ? "text-ember-600 dark:text-ember-400" : "text-muted dark:text-slate-400")}>
              {e.when}
            </span>
          )}
        </span>
        {finishes.length > 0 && e.record && (
          <span className="shrink-0 flex items-center gap-1">
            {finishes.map((f) => (
              <button
                key={f.action_id}
                title={f.label}
                type="button"
                onClick={() => void finish(e, f)}
                disabled={busy !== null}
                className="rounded border border-line dark:border-slate-600 px-1.5 py-0.5 text-[11px] font-medium text-content dark:text-mortar-100 hover:border-accent hover:text-accent transition disabled:opacity-50"
              >
                {busy === `${e.id}:${f.action_id}` ? "…" : WORDS[f.finishes].button}
              </button>
            ))}
          </span>
        )}
      </li>
    );
  };

  const group = (g: DatedGroup | null, heading: string, overdue: boolean) => {
    if (!g) return null;
    const shown = (g.entries ?? []).filter((e) => !gone.has(e.id));
    const more = g.count - (g.entries ?? []).length;
    return (
      <div>
        <div className="flex items-center gap-2 pl-9 pr-3 pt-2 pb-1 text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">
          <span>{heading}</span>
          {overdue && toss && (card.overdue?.all_ids?.length ?? 0) > 1 && (
            <button
              type="button"
              onClick={() => void tossAll()}
              disabled={busy !== null}
              className="ml-auto normal-case tracking-normal font-sans text-[11px] text-ember-700 dark:text-ember-400 hover:underline disabled:opacity-50"
            >
              {busy === "all" ? "Tossing…" : `Mark all ${card.overdue!.all_ids!.filter((id) => !gone.has(id)).length} as tossed`}
            </button>
          )}
        </div>
        <ul className="divide-y divide-line/40 dark:divide-slate-800/40">{shown.map((e) => row(e, overdue))}</ul>
        {more > 0 && (
          <Link to={collection.route} className="block pl-9 pr-3 py-1 text-[11px] text-muted hover:text-accent">
            +{more} more
          </Link>
        )}
      </div>
    );
  };

  return (
    <li data-testid="dated-card">
      <div className={`rounded-lg border text-sm transition ${tone}`}>
        <div className="flex items-center gap-3 px-3 py-2 group">
          <button type="button" onClick={() => setOpen((o) => !o)} className="flex-1 min-w-0 flex items-center gap-3 text-left" aria-expanded={open}>
            <span className="shrink-0">{card.overdue ? "⏰" : card.today ? "📆" : "📅"}</span>
            <span className="min-w-0 text-content dark:text-mortar-100">
              <strong>{collection.label}</strong>
              <span className="text-faint dark:text-slate-400"> · {datedCounts(card)}</span>
            </span>
          </button>
          <button type="button" onClick={() => setOpen((o) => !o)} className="shrink-0" aria-label={open ? "Collapse" : "Expand"}>
            <ChevronDown size={13} className={"text-faint transition-transform " + (open ? "rotate-180" : "")} />
          </button>
          <Link to={collection.route} className="shrink-0" title="Open the page" aria-label="Open the page">
            <ArrowRight size={14} className="text-faint group-hover:text-accent transition" />
          </Link>
        </div>
        {open && (
          <div className="border-t border-line/60 dark:border-slate-700/60 pb-1.5">
            {group(card.overdue, late, true)}
            {(card.overdue || card.upcoming) && (
              <div className="flex items-center gap-2 px-3 pt-2">
                <span className="h-px flex-1 bg-amber-300/70 dark:bg-amber-700/60" />
                <span className="text-[10px] font-mono uppercase tracking-widest text-amber-700 dark:text-amber-400">Today</span>
                <span className="h-px flex-1 bg-amber-300/70 dark:bg-amber-700/60" />
              </div>
            )}
            {card.today && <ul className="divide-y divide-line/40 dark:divide-slate-800/40">{(card.today.entries ?? []).filter((e) => !gone.has(e.id)).map((e) => row(e, false))}</ul>}
            {group(card.upcoming, "Coming up", false)}
            {pairs.length > 0 && (
              <div className="flex items-center gap-2 mx-3 mt-2 rounded border border-amber-300 dark:border-amber-800 bg-amber-50/70 dark:bg-amber-950/20 px-2.5 py-1.5 text-[12px]" data-testid="dated-duplicates">
                <span className="flex-1 min-w-0">
                  {pairs.length === 1
                    ? `${pairs[0]!.a.title} and ${pairs[0]!.b.title} look like one thing.`
                    : `${countOf(pairs.length, "pair")} here look like one thing each.`}
                </span>
                <button type="button" onClick={() => setMerging(true)} className="shrink-0 font-medium text-accent hover:underline">
                  Put together
                </button>
              </div>
            )}
          </div>
        )}
        {merging && (
          <Suspense fallback={null}>
            <DuplicateRecordsSheet slug={slug} onClose={() => setMerging(false)} />
          </Suspense>
        )}
      </div>
    </li>
  );
}
