// A recount of a collection (#6302): everything of it, across every place,
// scanned again. A scan box (a scanner types into it and presses Enter), what
// the label says for a thing with no barcode, the record picked from the list
// by its picture, and where you are now. Each answer says what it counted,
// asks which one when two kinds read alike, or notes something new. Nothing
// on the records changes until the recount is finished and reconciled.
import { useRef, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, MapPin, ScanLine, Tag, Undo2 } from "lucide-react";
import { EntityPhoto, PlacePickList, noteRecentPlace, usePageTitle, usePhotoPick, usePlatformWeb, useRunAction, useToast, type PlaceChoice } from "@cobblr/platform-web";
import { countOf } from "@cobblr/platform-contract/plural";
import { useInventory } from "./context";
import { placeChoices } from "./BulkMoveToPlace";
import { RecountFinish } from "./RecountFinish";

type Answer =
  | { kind: "matched"; title: string }
  | { kind: "new"; title: string }
  | { kind: "ask"; candidates: Array<{ id: string; title: string; place: string | null; image_path: string | null }> }
  /** New here, and two of the collection's kinds read alike: which kind it is. */
  | { kind: "ask_type"; candidates: Array<{ id: string; title: string; place: string | null; image_path: string | null }> }
  | { kind: "refused"; reason: string };

const PLACE_KEY = (id: string) => `cobblr:recount-place:${id}`;
function readPlace(id: string): PlaceChoice | null {
  try {
    const raw = JSON.parse(localStorage.getItem(PLACE_KEY(id)) ?? "null");
    return raw && typeof raw.id === "string" ? raw : null;
  } catch {
    return null;
  }
}

export function RecountPage() {
  const { id = "" } = useParams();
  const { api, orgSlug } = useInventory();
  const qc = useQueryClient();
  const toast = useToast();
  // PRESS-ARGS: a scan passes this recount's id, what was scanned, typed, read off a label or picked, and the place chosen on this page; taking one back out passes the recount and that scan's id; Undo passes the recount it finished; a label is printed for each counted record that has no barcode, by its own kind and id.
  const runAction = useRunAction();
  const q = useQuery({ queryKey: ["inventory-recount", orgSlug, id], queryFn: () => api.recount(id), enabled: !!id });
  const locs = useQuery({ queryKey: ["inventory-locations"], queryFn: () => api.listLocations() });
  usePageTitle(q.data ? `Recount of ${q.data.label}` : "Recount");
  const [code, setCode] = useState("");
  const [text, setText] = useState("");
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [busy, setBusy] = useState(false);
  const [place, setPlace] = useState<PlaceChoice | null>(() => readPlace(id));
  const [picking, setPicking] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [reading, setReading] = useState(false);
  const [printing, setPrinting] = useState(false);
  // The words a question was asked about, for "none of these: it's new".
  const [asked, setAsked] = useState<Record<string, unknown> | null>(null);
  // The workspace's camera reader for codes, where the host has one.
  const { barcodeCapture: Capture } = usePlatformWeb();
  const cameraScope = useRef<HTMLDivElement | null>(null);

  const scan = async (args: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await runAction({ actionId: "inventory:recount-scan", args: { recount_id: id, ...args, ...(place ? { place_id: place.id } : {}) } });
      const out = (res.result ?? {}) as { summary?: string; data?: { result?: string; candidates?: Extract<Answer, { kind: "ask" }>["candidates"] } };
      const data = out.data ?? {};
      const summary = out.summary ?? "";
      if (data.result === "ask" || data.result === "ask_type") {
        setAnswer({ kind: data.result, candidates: data.candidates ?? [] });
        setAsked(args);
      } else {
        setAnswer({ kind: data.result === "new" ? "new" : "matched", title: summary });
        setAsked(null);
      }
      setCode("");
      setText("");
      void qc.invalidateQueries({ queryKey: ["inventory-recount", orgSlug, id] });
    } catch (e) {
      setAnswer({ kind: "refused", reason: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  const takeOut = async (scanId: string, title: string) => {
    try {
      await runAction({ actionId: "inventory:recount-remove-scan", args: { recount_id: id, scan_id: scanId } }, { undo: "is-undo" });
      void qc.invalidateQueries({ queryKey: ["inventory-recount", orgSlug, id] });
      toast.success(`Took ${title} back out.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };
  const readLabel = async (file: File) => {
    setReading(true);
    setAnswer(null);
    try {
      const uploaded = await api.uploadPhoto(file);
      const { text: words } = await api.recountLabel(id, uploaded.id);
      setText(words);
      await scan({ text: words });
    } catch (e) {
      setAnswer({ kind: "refused", reason: e instanceof Error ? e.message : String(e) });
    } finally {
      setReading(false);
    }
  };
  const labelPhoto = usePhotoPick((files) => {
    if (files[0]) void readLabel(files[0]);
  }, { title: "The thing's label", label: "Photo of the label" });
  const printLabels = async (rows: Array<{ id: string; kind: string }>) => {
    setPrinting(true);
    let done = 0;
    try {
      for (const r of rows) {
        await runAction({ actionId: "labels:print", entityKind: r.kind, entityId: r.id });
        done += 1;
      }
      toast.success(`Queued ${countOf(done, "label")} to print. The next recount can scan them.`);
    } catch (e) {
      toast.error(`${done ? `Queued ${countOf(done, "label")}, then: ` : ""}${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPrinting(false);
    }
  };
  const undoAll = async () => {
    try {
      await runAction({ actionId: "inventory:undo-recount", args: { recount_id: id } }, { undo: "is-undo" });
      void qc.invalidateQueries({ queryKey: ["inventory-recount", orgSlug, id] });
      toast.success("Put everything back as it was.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };
  const choosePlace = (c: PlaceChoice) => {
    setPlace(c);
    setPicking(false);
    noteRecentPlace(orgSlug, c);
    try {
      localStorage.setItem(PLACE_KEY(id), JSON.stringify(c));
    } catch {
      /* storage blocked: the place is kept for this visit only */
    }
  };

  if (q.isError) return <p role="alert" className="text-sm text-ember-600 dark:text-ember-400">This recount could not be read.</p>;
  if (!q.data) return <p className="text-sm text-muted">Reading the recount…</p>;
  const r = q.data;
  const open = r.status === "open";
  const field = "min-w-0 flex-1 rounded-md border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-3 py-2 text-base text-content dark:text-mortar-100";
  const button = "min-h-11 rounded-md bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white px-4 text-sm font-medium";
  const submit = (e: FormEvent, args: Record<string, unknown>) => {
    e.preventDefault();
    void scan(args);
  };

  return (
    <div className="mx-auto max-w-2xl space-y-4" data-testid="recount-page">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="text-lg font-semibold text-content dark:text-mortar-100">Recount of {r.label}</h2>
          <p className="text-sm text-muted dark:text-slate-400" data-testid="recount-progress">
            {r.progress.seen} of {countOf(r.progress.expected, "thing")} seen{r.progress.new ? `, ${r.progress.new} new` : ""}.{open ? " Nothing changes until you finish." : ""}
          </p>
        </div>
        {open && !finishing && (
          <button type="button" onClick={() => setFinishing(true)} className={button} data-testid="recount-finish-open">
            Finish…
          </button>
        )}
      </div>
      {open && finishing && <RecountFinish id={id} onClose={() => setFinishing(false)} />}
      {!open && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-line dark:border-slate-700 px-3 py-2 text-sm" data-testid="recount-finished">
          <span className="mr-auto text-content dark:text-mortar-100">
            {r.status === "undone"
              ? "Finished, then undone: everything is back as it was."
              : r.applied
                ? `Finished: ${[
                    r.applied.moved.length ? `${r.applied.moved.length} moved` : null,
                    r.applied.counted.length ? `${r.applied.counted.length} recounted` : null,
                    r.applied.added.length ? `${r.applied.added.length} added` : null,
                    r.applied.gone.length ? `${countOf(r.applied.gone.length, "thing")} marked gone` : null,
                    r.applied.later.length ? `${r.applied.later.length} to check later` : null,
                  ].filter(Boolean).join(", ") || "nothing changed"}.`
                : "Finished."}
          </span>
          {r.status === "applied" && (
            <button type="button" onClick={() => void undoAll()} className="min-h-11 rounded-md border border-line dark:border-slate-600 px-3 text-sm">
              Undo this recount
            </button>
          )}
        </div>
      )}

      {open && (
        <div className="space-y-3 rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <MapPin size={14} className="text-accent shrink-0" />
            <span className="min-w-0 flex-1 truncate text-content dark:text-mortar-100" data-testid="recount-place">{place ? `Putting things in ${place.name}` : "Places as on record"}</span>
            <button type="button" onClick={() => setPicking((v) => !v)} className="min-h-11 rounded-md border border-line dark:border-slate-600 px-3 text-sm">
              {place ? "Change" : "I'm in a place…"}
            </button>
          </div>
          {picking && (
            <div className="rounded-md border border-line dark:border-slate-700">
              <PlacePickList slug={orgSlug} places={placeChoices(locs.data?.items ?? [])} holders={[]} onPick={choosePlace} />
            </div>
          )}
          {Capture && (
            <div ref={cameraScope}>
              <Capture scope={cameraScope} onCode={(c) => void scan({ barcode: c })} />
            </div>
          )}
          <form className="flex gap-2" onSubmit={(e) => submit(e, { barcode: code })}>
            <input value={code} onChange={(e) => setCode(e.target.value)} aria-label="Scan or type a barcode" placeholder="Scan or type a barcode" autoComplete="off" className={field} />
            <button type="submit" disabled={busy || !code.trim()} className={button}>Count</button>
          </form>
          <form className="flex gap-2" onSubmit={(e) => submit(e, { text })}>
            <input value={text} onChange={(e) => setText(e.target.value)} aria-label="What the label says" placeholder="No barcode? What the label says" autoComplete="off" className={field} />
            <button type="submit" disabled={busy || !text.trim()} className={button}>Find</button>
          </form>
          {labelPhoto.input}
          <button type="button" disabled={busy || reading} onClick={labelPhoto.pick} className="flex min-h-11 items-center gap-2 rounded-md border border-line dark:border-slate-600 px-3 text-sm disabled:opacity-50">
            <Camera size={16} /> {reading ? "Reading the label…" : "Photo of the label"}
          </button>
          {answer && (
            <div role="status" data-testid="recount-answer" className="text-sm">
              {answer.kind === "ask" || answer.kind === "ask_type" ? (
                <div className="space-y-2">
                  <p className="text-content dark:text-mortar-100">
                    {answer.kind === "ask"
                      ? `That could be ${countOf(answer.candidates.length, "thing")} you have. Which is it?`
                      : `That is new here, and could be ${countOf(answer.candidates.length, "kind")} you keep. Which kind is it?`}
                  </p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {answer.candidates.map((c) => (
                      <button key={c.id} type="button" disabled={busy} onClick={() => void scan(answer.kind === "ask" ? { record_id: c.id } : { ...(asked ?? {}), new: true, type_id: c.id })} className="flex min-h-11 items-center gap-2 rounded-md border border-line dark:border-slate-600 p-2 text-left hover:border-cobble-400">
                        <EntityPhoto src={c.image_path} alt={c.title} size={40} className="rounded-md bg-subtle text-muted shrink-0" />
                        <span className="min-w-0">
                          <span className="block truncate text-content dark:text-mortar-100">{c.title}</span>
                          {c.place && <span className="block truncate text-xs text-muted dark:text-slate-400">{c.place}</span>}
                        </span>
                      </button>
                    ))}
                  </div>
                  {asked && (
                    <button type="button" disabled={busy} onClick={() => void scan({ ...asked, new: true })} className="min-h-11 text-sm text-muted underline decoration-dotted underline-offset-2">
                      None of these: it's new
                    </button>
                  )}
                </div>
              ) : answer.kind === "refused" ? (
                <p className="text-ember-600 dark:text-ember-400">{answer.reason}</p>
              ) : (
                <p className={answer.kind === "new" ? "text-amber-700 dark:text-amber-400" : "text-emerald-700 dark:text-emerald-400"}>{answer.title}</p>
              )}
            </div>
          )}
        </div>
      )}

      {(() => {
        // Labels for next time: the things counted that carry no code to scan.
        const bare = r.expected.filter((e) => e.seen && !e.barcode);
        return bare.length > 0 && r.status !== "undone" ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-line dark:border-slate-700 px-3 py-2 text-sm" data-testid="recount-labels">
            <span className="mr-auto text-content dark:text-mortar-100">{countOf(bare.length, "thing")} counted here {bare.length === 1 ? "has" : "have"} no barcode. A Cobblr label makes the next recount a scan.</span>
            <button type="button" disabled={printing} onClick={() => void printLabels(bare)} className="flex min-h-11 items-center gap-2 rounded-md border border-line dark:border-slate-600 px-3 text-sm disabled:opacity-50">
              <Tag size={16} /> {printing ? "Queuing…" : `Print ${countOf(bare.length, "label")}`}
            </button>
          </div>
        ) : null;
      })()}

      {r.new.length > 0 && (
        <section className="space-y-1">
          <h3 className="text-[10px] font-mono uppercase tracking-widest text-accent">New: not on record</h3>
          <ul className="divide-y divide-line dark:divide-slate-800 rounded-md border border-line dark:border-slate-700">
            {r.new.map((n) => (
              <li key={n.scan_id} className="flex items-center gap-2 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate text-content dark:text-mortar-100">{n.title}</span>
                {open && (
                  <button type="button" aria-label={`Take ${n.title} back out`} title="Take it back out" onClick={() => void takeOut(n.scan_id, n.title)} className="grid min-h-11 min-w-11 place-items-center rounded-md text-muted hover:text-accent">
                    <Undo2 size={16} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-1">
        <h3 className="text-[10px] font-mono uppercase tracking-widest text-accent">Expected: tap one to count it</h3>
        <ul className="divide-y divide-line dark:divide-slate-800 rounded-md border border-line dark:border-slate-700" data-testid="recount-expected">
          {r.expected.map((e) => (
            <li key={e.id} className="flex items-center gap-2 px-2 py-1.5" data-testid="recount-row" data-seen={e.seen ? "true" : "false"}>
              <button
                type="button"
                disabled={!open || !!e.seen || busy}
                onClick={() => void scan({ record_id: e.id })}
                className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md text-left disabled:cursor-default"
              >
                <EntityPhoto src={e.image_path} alt={e.title} size={36} className="rounded-md bg-subtle text-muted shrink-0" />
                <span className="min-w-0">
                  <span className={`block truncate text-sm ${e.seen ? "text-content dark:text-mortar-100" : "text-muted dark:text-slate-400"}`}>{e.title}</span>
                  <span className="block truncate text-xs text-muted dark:text-slate-400">{e.seen ? "Seen" : "Not seen yet"}{e.place ? ` · ${e.place}` : ""}</span>
                </span>
              </button>
              {open && e.seen && (
                <button type="button" aria-label={`Take ${e.title} back out`} title="Take it back out" onClick={() => void takeOut(e.seen!.scan_id, e.title)} className="grid min-h-11 min-w-11 place-items-center rounded-md text-muted hover:text-accent">
                  <Undo2 size={16} />
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/** "Recount all…" on a collection's page: starts a recount of it (of the
 *  category the list is narrowed to, when it is), or picks up the open one. */
export function RecountButton({ categoryId, className }: { categoryId?: string | null; className: string }) {
  const { instance, basePath } = useInventory();
  const navigate = useNavigate();
  const toast = useToast();
  // PRESS-ARGS: the collection this page shows and the category it is narrowed to are the whole scope.
  const runAction = useRunAction();
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try {
      const res = await runAction(
        { actionId: "inventory:start-recount", args: { scope: { collection: instance ?? "inventory", ...(categoryId ? { category_id: categoryId } : {}) } } },
      );
      const id = (res.result as { data?: { recount_id?: string } } | null)?.data?.recount_id;
      if (id) navigate(`${basePath}/recounts/${id}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" disabled={busy} onClick={() => void start()} className={className} data-testid="recount-start">
      <ScanLine size={14} /> {busy ? "Starting…" : categoryId ? "Recount this category…" : "Recount all…"}
    </button>
  );
}
