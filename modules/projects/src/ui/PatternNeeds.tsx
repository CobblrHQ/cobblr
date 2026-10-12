import { FieldPack, fieldNeed, RecordFormModal, MutationError, useUnits } from "@cobblr/platform-web";
// What this pattern needs: each yarn and each hook or needle, read from the
// pattern PDF and kept on the pattern (pattern-needs.ts on the server).
//
// One card per requirement, so a two-colour blanket reads as two yarns with
// two lengths. A length the pattern leaves open (it gives a solid's and a
// print's length per ball and does not say which this colour is) is asked,
// one tap, rather than guessed. Every row can be corrected by hand, and a
// corrected row survives reading the pattern again.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, RefreshCw, X } from "lucide-react";
import { countOf, NOTION_NAMES } from "@cobblr/platform-contract";
import type { NeedMatch, PatternNeed, PatternNeedInput, PatternNeedKind, PatternNeedsState, ProjectsApi } from "./api";

export const patternNeedsKey = (designId: string) => ["pattern-needs", designId] as const;

const WEIGHTS = ["0 – Lace", "1 – Fingering", "2 – Sport", "3 – DK", "4 – Worsted", "4 – Aran", "5 – Bulky", "6 – Super Bulky"];

export function yarnTitle(n: Pick<PatternNeed, "brand" | "product" | "color" | "color_code" | "weight" | "fiber">): string {
  const line = [n.brand, n.product].filter(Boolean).join(" ");
  const colour = n.color ? `${n.color}${n.color_code ? ` (${n.color_code})` : ""}` : n.color_code ? `#${n.color_code}` : "";
  // A yarn line names what it is; a colour alone never does ("blue" read as
  // if the pattern needed a colour): it follows what the yarn is, by weight.
  if (line) return [line, colour].filter(Boolean).join(" · ");
  const weight = n.weight ? n.weight.replace(/^\s*\d+\s*[–-]\s*/, "").trim() : "";
  if (colour) return `${weight ? `${weight} yarn` : "Yarn"}, ${colour}`;
  // No brand, line or colour: the pattern takes any yarn of its weight.
  return "Yarn, any brand";
}

export function toolTitle(n: Pick<PatternNeed, "kind" | "size_mm" | "size_label">): string {
  const what = n.kind === "needle" ? "Needle" : "Hook";
  const size = n.size_mm != null ? `${n.size_mm} mm` : "";
  return [what, size, n.size_label ? `(${n.size_label})` : ""].filter(Boolean).join(" ");
}

function readLine(s: PatternNeedsState | undefined): { text: string; tone: "muted" | "warn" } | null {
  if (!s) return null;
  switch (s.read.status) {
    case "none":
      return { text: "Add the pattern PDF (Files, below) and the yarn and hooks it lists are read from it.", tone: "muted" };
    case "pending":
      return { text: "Reading the pattern…", tone: "muted" };
    case "ready":
      return s.read.method === "ai"
        ? { text: "Read by your AI. Check it against the PDF.", tone: "warn" }
        : { text: "Read from the pattern's own materials list.", tone: "muted" };
    default:
      return { text: s.read.reason ?? "Nothing in the pattern could be read as its materials. Add what it needs by hand.", tone: "warn" };
  }
}

export function PatternNeedsPanel({
  designId,
  api,
  bodyText,
}: {
  designId: string;
  api: ProjectsApi;
  /** The pattern's own text (its description). A pattern saved from words,
   *  before its text was read on the way in, lists nothing until this is
   *  read: the panel offers that as one tap. */
  bodyText?: string | null;
}) {
  const qc = useQueryClient();
  const units = useUnits();
  const [editing, setEditing] = useState<PatternNeed | { kind: PatternNeedKind } | null>(null);
  const [pasting, setPasting] = useState(false);
  const [text, setText] = useState("");
  const needs = useQuery({
    queryKey: patternNeedsKey(designId),
    queryFn: () => api.patternNeeds(designId),
    retry: false,
    refetchInterval: (q) => (q.state.data?.read.status === "pending" ? 1500 : false),
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: patternNeedsKey(designId) });
  const reread = useMutation({ mutationFn: () => api.rereadPattern(designId), onSuccess: refresh });
  const fromText = useMutation({ mutationFn: () => api.readPastedMaterials(designId, (bodyText ?? "").slice(0, 20_000)), onSuccess: refresh });
  const pickLength = useMutation({
    mutationFn: (v: { id: string; choice: string }) => api.updateNeed(designId, v.id, { length_choice: v.choice }),
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: (id: string) => api.deleteNeed(designId, id), onSuccess: refresh });
  const paste = useMutation({
    mutationFn: () => api.readPastedMaterials(designId, text),
    onSuccess: (r) => {
      refresh();
      if (r.ai || r.needs.length) {
        setPasting(false);
        setText("");
      }
    },
  });

  if (needs.isError) return null;
  const s = needs.data;
  const yarns = (s?.items ?? []).filter((n) => n.kind === "yarn");
  const tools = (s?.items ?? []).filter((n) => n.kind === "hook" || n.kind === "needle");
  const notions = (s?.items ?? []).filter((n) => n.kind === "notion");
  // Nothing listed, no PDF, but words on the page: read them, one tap.
  const canReadText = !!s && s.items.length === 0 && s.read.status === "none" && !!bodyText?.trim();
  const line = canReadText ? { text: "Its text is on this page. Read the yarn, hook and notions it names from it.", tone: "muted" as const } : readLine(s);
  const metres = (m: number) => units.format(Math.round(m), "m");

  return (
    <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-5" data-testid="pattern-needs-panel">
      <div className="flex items-center gap-2 mb-2">
        <div className="text-[10px] font-mono uppercase tracking-widest text-accent">// what this pattern needs</div>
        {s && s.read.status !== "none" && s.read.status !== "pending" && s.read.pattern_file_id && (
          <button
            type="button"
            onClick={() => reread.mutate()}
            disabled={reread.isPending}
            className="ml-auto inline-flex items-center gap-1 text-xs text-muted hover:text-accent disabled:opacity-40"
            title="Read the pattern PDF again. Rows you changed are kept."
          >
            <RefreshCw size={12} className={reread.isPending ? "animate-spin" : ""} /> Read again
          </button>
        )}
      </div>
      <MutationError mutation={reread} className="block mb-2">Could not read it again:</MutationError>
      <MutationError mutation={fromText} className="block mb-2">Could not read its text:</MutationError>
      <MutationError mutation={pickLength} className="block mb-2">Could not pick that length:</MutationError>
      <MutationError mutation={remove} className="block mb-2">Could not remove that row:</MutationError>
      {line && (
        <p className={`text-xs mb-3 ${line.tone === "warn" ? "text-ember-600 dark:text-ember-400" : "text-faint dark:text-slate-500"}`} data-testid="pattern-needs-read">
          {line.text}
        </p>
      )}

      {s?.sewing && <section aria-label="Sewing supplies and sizes" className="space-y-3 mb-4">
        <h3 className="font-semibold">Supplies and sizes</h3>
        <p className="text-sm text-muted">Check these against the PDF for your chosen size. Keep corrections in the pattern's supply notes.</p>
        <p className="break-words">Sizes: {s.sewing.sizes.length ? s.sewing.sizes.join(", ") : "Not stated in a readable sizes line"}</p>
        <ul className="space-y-2">{s.sewing.supplies.map((supply,i)=><li key={i} className="text-sm break-words">{supply.text}</li>)}</ul>
      </section>}
      {canReadText && (
        <div className="mb-3">
          <button
            type="button"
            onClick={() => fromText.mutate()}
            disabled={fromText.isPending}
            className="rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm px-3 py-2 min-h-9 disabled:opacity-40"
            data-testid="pattern-needs-read-text"
          >
            {fromText.isPending ? "Reading…" : "Read what it needs from its text"}
          </button>
          {fromText.data && !fromText.data.ai && fromText.data.reason && (
            <p className="text-xs text-ember-600 dark:text-ember-400 mt-2">{fromText.data.reason}</p>
          )}
        </div>
      )}

      {yarns.length > 0 && (
        <ul className="space-y-2 mb-3" data-testid="pattern-needs-yarns">
          {yarns.map((n) => (
            <li key={n.id} className="rounded-lg border border-line dark:border-slate-700 px-3 py-2" data-testid="pattern-need">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  {/* The pattern's own short name (MC, A) is a tag; a longer note
                      ("Designer used …") reads as a line under the title. */}
                  {n.label && n.label.length <= 16 && (
                    <span className="inline-block mb-1 text-[10px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded border border-line dark:border-slate-600 text-muted">
                      {n.label}
                    </span>
                  )}
                  <div className="text-sm text-content dark:text-mortar-100 break-words">{yarnTitle(n)}</div>
                  {n.label && n.label.length > 16 && <div className="text-xs italic text-muted dark:text-slate-400">{n.label}</div>}
                  {(n.weight || n.fiber) && (
                    <div className="text-xs text-muted dark:text-slate-400">{[n.weight, n.fiber].filter(Boolean).join(" · ")}</div>
                  )}
                  <div className="text-xs text-muted dark:text-slate-400 mt-0.5" data-testid="pattern-need-amount">
                    {[
                      n.quantity != null ? countOf(n.quantity, n.quantity_unit || "ball") : null,
                      n.length_m != null ? metres(n.length_m) : n.length_choices ? null : "length not given",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                  {n.length_m == null && n.length_choices && n.length_choices.length > 0 && (
                    <div className="mt-1.5">
                      <div className="text-xs text-content dark:text-mortar-200">
                        The pattern gives more than one length per {n.quantity_unit || "ball"}. Which is {n.color || "this yarn"}?
                      </div>
                      <div className="flex flex-wrap gap-1.5 mt-1">
                        {n.length_choices.map((c) => (
                          <button
                            key={c.label}
                            type="button"
                            disabled={pickLength.isPending}
                            onClick={() => pickLength.mutate({ id: n.id, choice: c.label })}
                            className="min-h-9 rounded-md border border-line dark:border-slate-600 px-2.5 text-xs hover:border-accent"
                          >
                            {c.label ? `${c.label[0]!.toUpperCase()}${c.label.slice(1)}` : "This"}: {metres(c.unit_length_m)} each
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <YarnMatch designId={designId} api={api} need={n} onChanged={refresh} metres={metres} />
                </div>
                <RowTools onEdit={() => setEditing(n)} onRemove={() => remove.mutate(n.id)} />
              </div>
            </li>
          ))}
        </ul>
      )}

      {tools.length > 0 && (
        <ul className="space-y-2 mb-3" data-testid="pattern-needs-tools">
          {tools.map((n) => (
            <li key={n.id} className="rounded-lg border border-line dark:border-slate-700 px-3 py-2" data-testid="pattern-need">
              <div className="flex items-center gap-2">
                <span className="text-sm text-content dark:text-mortar-100 flex-1 min-w-0">{toolTitle(n)}</span>
                <RowTools onEdit={() => setEditing(n)} onRemove={() => remove.mutate(n.id)} />
              </div>
              <ToolMatch designId={designId} api={api} need={n} onChanged={refresh} />
            </li>
          ))}
        </ul>
      )}

      {notions.length > 0 && (
        <ul className="space-y-2 mb-3" data-testid="pattern-needs-notions">
          {notions.map((n) => (
            <li key={n.id} className="rounded-lg border border-line dark:border-slate-700 px-3 py-2" data-testid="pattern-need">
              <div className="flex items-center gap-2">
                <span className="text-sm text-content dark:text-mortar-100 flex-1 min-w-0">{notionTitle(n)}</span>
                <RowTools onEdit={() => setEditing(n)} onRemove={() => remove.mutate(n.id)} />
              </div>
              <NotionMatch designId={designId} api={api} need={n} onChanged={refresh} />
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-x-4 gap-y-2">
        <button type="button" onClick={() => setEditing({ kind: "yarn" })} className="inline-flex items-center gap-1 text-xs text-accent hover:underline min-h-9">
          <Plus size={12} /> Add a yarn
        </button>
        <button type="button" onClick={() => setEditing({ kind: "hook" })} className="inline-flex items-center gap-1 text-xs text-accent hover:underline min-h-9">
          <Plus size={12} /> Add a hook or needle
        </button>
        <button type="button" onClick={() => setEditing({ kind: "notion" })} className="inline-flex items-center gap-1 text-xs text-accent hover:underline min-h-9">
          <Plus size={12} /> Add a notion
        </button>
        <button type="button" onClick={() => setPasting((v) => !v)} className="inline-flex items-center gap-1 text-xs text-muted hover:text-accent min-h-9">
          Paste the materials list
        </button>
      </div>
      {pasting && (
        <div className="mt-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            placeholder={"2 skeins worsted acrylic, colour A\n5 mm crochet hook"}
            className="input text-sm w-full resize-y mb-2"
          />
          <button
            type="button"
            disabled={!text.trim() || paste.isPending}
            onClick={() => paste.mutate()}
            className="rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm px-3 py-2 disabled:opacity-40"
          >
            {paste.isPending ? "Reading…" : "Read it"}
          </button>
          {paste.data && !paste.data.ai && paste.data.reason && (
            <p className="text-xs text-ember-600 dark:text-ember-400 mt-2">{paste.data.reason}</p>
          )}
          <MutationError mutation={paste} className="block mt-2" />
        </div>
      )}

      {editing && (
        <NeedEditor
          designId={designId}
          api={api}
          need={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

/** "✓ You have it", "Short by 300 m", "Nothing in your stash fits", with the
 *  one thing to do about it: use the yarn, change it, or list what is missing. */
function YarnMatch({
  designId,
  api,
  need,
  onChanged,
  metres,
}: {
  designId: string;
  api: ProjectsApi;
  need: PatternNeed;
  onChanged: () => void;
  metres: (m: number) => string;
}) {
  const m = need.match;
  const [choosing, setChoosing] = useState(false);
  const [usedSoFar, setUsedSoFar] = useState("");
  const use = useMutation({
    mutationFn: (partId: string | null) =>
      api.useYarnFor(designId, need.id, {
        part_id: partId,
        ...(need.part_id && partId !== need.part_id && usedSoFar.trim() !== "" ? { used_so_far_m: Number(usedSoFar) } : {}),
      }),
    onSuccess: () => {
      setChoosing(false);
      setUsedSoFar("");
      onChanged();
    },
  });
  const shop = useMutation({ mutationFn: () => api.shopNeed(designId, need.id), onSuccess: onChanged });
  if (need.settled_at) {
    return (
      <p className="text-xs text-moss-700 dark:text-moss-400 mt-1.5" data-testid="pattern-need-settled">
        Finished. {need.settle_note}
      </p>
    );
  }
  if (!m) return null;
  const best = m.fits[0];
  const short = m.short_m != null && m.short_m > 0 ? metres(m.short_m) : m.short_units ? countOf(m.short_units, need.quantity_unit || "ball") : null;
  const verdict = m.chosen
    ? m.status === "short"
      ? `Using ${m.chosen.name}. Short by ${short}.`
      : `Using ${m.chosen.name}.`
    : !best
      ? "Nothing in your stash fits."
      : best.fit === "same"
        ? m.status === "short"
          ? `You have ${best.yarn.name}, but ${short} short.`
          : `You have it: ${best.yarn.name}.`
        : `Not in your stash. Closest: ${best.yarn.name} (${best.same_line ? "the same yarn in another colour" : "another yarn of the same weight"}).`;
  const tone = m.status === "have" && (m.chosen || best?.fit === "same") ? "text-moss-700 dark:text-moss-400" : "text-ember-600 dark:text-ember-400";
  const offerShop = (m.status === "none" || m.status === "short" || (!m.chosen && best?.fit !== "same")) && !need.list_item_id;
  return (
    <div className="mt-2 space-y-1.5" data-testid="pattern-need-match">
      <p className={`text-xs ${tone}`} data-testid="pattern-need-verdict">
        {verdict}
      </p>
      {m.chosen && (m.used_m > 0 || m.bound.length > 0) && (
        <p className="text-xs text-muted dark:text-slate-400">
          {m.used_m > 0 ? `Used so far: ${metres(m.used_m)}.` : ""}
          {m.bound.length > 0 ? ` On the needles: ${m.bound.map((b) => metres(b.left_m)).join(", ")} left.` : ""}
        </p>
      )}
      {need.list_item_id && <p className="text-xs text-muted dark:text-slate-400">On your shopping list.</p>}
      <div className="flex flex-wrap gap-2">
        {!m.chosen && best && best.fit === "same" && (
          <button
            type="button"
            disabled={use.isPending}
            onClick={() => use.mutate(best.yarn.id)}
            className="min-h-9 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-xs px-3 disabled:opacity-40"
          >
            Use it
          </button>
        )}
        {(m.chosen || m.fits.length > 0) && (
          <button type="button" onClick={() => setChoosing((v) => !v)} className="min-h-9 rounded-md border border-line dark:border-slate-600 text-xs px-3">
            {m.chosen ? "Change yarn" : "Pick a yarn"}
          </button>
        )}
        {offerShop && (
          <button
            type="button"
            disabled={shop.isPending}
            onClick={() => shop.mutate()}
            className="min-h-9 rounded-md border border-line dark:border-slate-600 text-xs px-3 disabled:opacity-40"
            data-testid="pattern-need-shop"
          >
            Add to shopping list
          </button>
        )}
      </div>
      {choosing && (
        <div className="rounded-md border border-line dark:border-slate-700 p-2 space-y-2" data-testid="pattern-need-choose">
          {m.chosen && (
            <label className="block">
              <span className="block text-xs text-muted mb-0.5">
                How much of {m.chosen.name} have you used? It stays on its balls; the rest moves to the new yarn.
              </span>
              <input
                value={usedSoFar}
                onChange={(e) => setUsedSoFar(e.target.value)}
                type="number"
                min={0}
                step="any"
                inputMode="decimal"
                placeholder={m.used_m ? `${m.used_m} (logged)` : "metres used"}
                className="input text-sm"
              />
            </label>
          )}
          <ul className="space-y-1">
            {m.fits.filter((f) => f.yarn.id !== m.chosen?.id).map((f) => (
              <li key={f.yarn.id} className="flex items-center gap-2 text-xs">
                <span className="flex-1 min-w-0">
                  {f.yarn.name}
                  <span className="text-muted">
                    {" · "}
                    {f.fit === "same" ? "same yarn" : f.same_line ? "another colour" : "same weight"}
                    {f.free_m != null ? ` · ${metres(f.free_m)} free` : ` · ${countOf(Math.max(0, f.yarn.free_units), f.yarn.unit || "ball")} free`}
                  </span>
                </span>
                <button
                  type="button"
                  disabled={use.isPending}
                  onClick={() => use.mutate(f.yarn.id)}
                  className="shrink-0 min-h-9 rounded-md border border-line dark:border-slate-600 px-2.5 hover:border-accent"
                >
                  Use this
                </button>
              </li>
            ))}
            {m.fits.filter((f) => f.yarn.id !== m.chosen?.id).length === 0 && (
              <li className="text-xs text-muted">No other yarn in your stash fits.</li>
            )}
          </ul>
          {m.chosen && (
            <button type="button" onClick={() => use.mutate(null)} className="text-xs text-faint hover:text-ember-500 min-h-9">
              Stop using {m.chosen.name} for this
            </button>
          )}
        </div>
      )}
      {use.isError && <p className="text-xs text-ember-600 dark:text-ember-400">{(use.error as Error).message}</p>}
      {shop.isError && <p className="text-xs text-ember-600 dark:text-ember-400">{(shop.error as Error).message}</p>}
    </div>
  );
}

function ToolMatch({ designId, api, need, onChanged }: { designId: string; api: ProjectsApi; need: PatternNeed; onChanged: () => void }) {
  const m: NeedMatch | null | undefined = need.match;
  const shop = useMutation({ mutationFn: () => api.shopNeed(designId, need.id), onSuccess: onChanged });
  if (!m) return null;
  return (
    <div className="mt-1 space-y-1.5" data-testid="pattern-need-match">
      <p className={`text-xs ${m.tools.length ? "text-moss-700 dark:text-moss-400" : "text-ember-600 dark:text-ember-400"}`} data-testid="pattern-need-verdict">
        {m.tools.length ? `You have it: ${m.tools[0]!.name}.` : `No ${need.size_mm} mm ${need.kind === "needle" ? "needle" : "hook"} in your stash.`}
      </p>
      {!m.tools.length && !need.list_item_id && (
        <button
          type="button"
          disabled={shop.isPending}
          onClick={() => shop.mutate()}
          className="min-h-9 rounded-md border border-line dark:border-slate-600 text-xs px-3 disabled:opacity-40"
          data-testid="pattern-need-shop"
        >
          Add to shopping list
        </button>
      )}
      {need.list_item_id && <p className="text-xs text-muted">On your shopping list.</p>}
    </div>
  );
}

export function notionTitle(n: Pick<PatternNeed, "label" | "size_mm" | "quantity">): string {
  return [n.quantity != null ? `${n.quantity} ×` : "", n.label ?? "Notion", n.size_mm != null ? `${n.size_mm} mm` : ""].filter(Boolean).join(" ");
}

function NotionMatch({ designId, api, need, onChanged }: { designId: string; api: ProjectsApi; need: PatternNeed; onChanged: () => void }) {
  const m = need.match;
  const shop = useMutation({ mutationFn: () => api.shopNeed(designId, need.id), onSuccess: onChanged });
  if (!m) return null;
  const what = (need.label ?? "notion").toLowerCase();
  const verdict =
    m.status === "have"
      ? `You have it: ${m.tools[0]?.name ?? need.label}.`
      : m.status === "short"
        ? `You have ${m.tools.reduce((a, t) => a + t.qty, 0)}; the pattern wants ${need.quantity}.`
        : `No ${what}${need.size_mm != null ? ` of ${need.size_mm} mm` : ""} on hand.`;
  return (
    <div className="mt-1 space-y-1.5" data-testid="pattern-need-match">
      <p className={`text-xs ${m.status === "have" ? "text-moss-700 dark:text-moss-400" : "text-ember-600 dark:text-ember-400"}`} data-testid="pattern-need-verdict">
        {verdict}
      </p>
      {m.status !== "have" && !need.list_item_id && (
        <button
          type="button"
          disabled={shop.isPending}
          onClick={() => shop.mutate()}
          className="min-h-9 rounded-md border border-line dark:border-slate-600 text-xs px-3 disabled:opacity-40"
          data-testid="pattern-need-shop"
        >
          Add to shopping list
        </button>
      )}
      {need.list_item_id && <p className="text-xs text-muted">On your shopping list.</p>}
    </div>
  );
}

function RowTools({ onEdit, onRemove }: { onEdit: () => void; onRemove: () => void }) {
  return (
    <span className="shrink-0 flex items-center">
      <button title="Change" type="button" onClick={onEdit} aria-label="Change" className="h-9 w-9 flex items-center justify-center text-faint hover:text-accent">
        <Pencil size={13} />
      </button>
      <button title="Remove" type="button" onClick={onRemove} aria-label="Remove" className="h-9 w-9 flex items-center justify-center text-faint hover:text-ember-500">
        <X size={14} />
      </button>
    </span>
  );
}

const numOrNull = (v: string) => (v.trim() === "" ? null : Number(v));

function NeedEditor({
  designId,
  api,
  need,
  onClose,
  onSaved,
}: {
  designId: string;
  api: ProjectsApi;
  need: PatternNeed | { kind: PatternNeedKind };
  onClose: () => void;
  onSaved: () => void;
}) {
  const existing = "id" in need ? need : null;
  const [kind, setKind] = useState<PatternNeedKind>(need.kind);
  const init = (k: keyof PatternNeed) => {
    const v = existing?.[k];
    return v == null ? "" : String(v);
  };
  const [f, setF] = useState({
    label: init("label"),
    brand: init("brand"),
    product: init("product"),
    color: init("color"),
    color_code: init("color_code"),
    weight: init("weight"),
    fiber: init("fiber"),
    quantity: init("quantity"),
    quantity_unit: init("quantity_unit") || "ball",
    unit_length_m: init("unit_length_m"),
    length_m: init("length_m"),
    size_mm: init("size_mm"),
    size_label: init("size_label"),
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));
  const save = useMutation({
    mutationFn: () => {
      const s = (v: string) => (v.trim() ? v.trim() : null);
      const body: PatternNeedInput =
        kind === "notion"
          ? {
              kind,
              label: s(f.label),
              brand: null,
              product: null,
              color: null,
              color_code: null,
              weight: null,
              fiber: null,
              quantity: numOrNull(f.quantity),
              quantity_unit: null,
              unit_length_m: null,
              length_m: null,
              size_mm: numOrNull(f.size_mm),
              size_label: null,
            }
          : kind === "yarn"
          ? {
              kind,
              label: s(f.label),
              brand: s(f.brand),
              product: s(f.product),
              color: s(f.color),
              color_code: s(f.color_code),
              weight: s(f.weight),
              fiber: s(f.fiber),
              quantity: numOrNull(f.quantity),
              quantity_unit: s(f.quantity_unit),
              unit_length_m: numOrNull(f.unit_length_m),
              length_m: numOrNull(f.length_m),
              size_mm: null,
              size_label: null,
            }
          : {
              kind,
              label: null,
              brand: null,
              product: null,
              color: null,
              color_code: null,
              weight: null,
              fiber: null,
              quantity: null,
              quantity_unit: null,
              unit_length_m: null,
              length_m: null,
              size_mm: numOrNull(f.size_mm),
              size_label: s(f.size_label),
            };
      return existing ? api.updateNeed(designId, existing.id, body) : api.addNeed(designId, body);
    },
    onSuccess: onSaved,
  });
  const field = (label: string, k: keyof typeof f, props: Record<string, unknown> = {}) => (
    <label className="block">
      <span className="block text-xs text-muted mb-0.5">{label}</span>
      <input value={f[k]} onChange={set(k)} className="input text-sm" {...props} />
    </label>
  );
  return (
    <RecordFormModal open onClose={onClose} title={existing ? "Change what the pattern needs" : kind === "yarn" ? "Add a yarn" : kind === "notion" ? "Add a notion" : "Add a hook or needle"}>
      <div className="space-y-2.5">
        {kind === "notion" ? (
          <>
            <label className="block">
              <span className="block text-xs text-muted mb-0.5">What it is</span>
              <select value={f.label} onChange={set("label")} className="input text-sm">
                <option value="">Pick one</option>
                {NOTION_NAMES.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <FieldPack items={[
              {
                need: fieldNeed("quantity", { control: "number", label: "How many" }),
                node: (
                  field("How many", "quantity", { type: "number", min: 0, step: "any", inputMode: "decimal" })
                ),
              },
              {
                need: fieldNeed("size_mm", { control: "number", label: "Size in mm (eyes, buttons)" }),
                node: (
                  field("Size in mm (eyes, buttons)", "size_mm", { type: "number", min: 0, step: "any", inputMode: "decimal" })
                ),
              },
            ]} />
          </>
        ) : kind === "yarn" ? (
          <>
            {field("Pattern's name for it (MC, A…)", "label")}
            <FieldPack items={[
              {
                need: fieldNeed("brand", { control: "text", label: "Brand" }),
                node: (
                  field("Brand", "brand")
                ),
              },
              {
                need: fieldNeed("product", { control: "text", label: "Yarn line" }),
                node: (
                  field("Yarn line", "product")
                ),
              },
              {
                need: fieldNeed("color", { control: "text", label: "Colour" }),
                node: (
                  field("Colour", "color")
                ),
              },
              {
                need: fieldNeed("color_code", { control: "text", label: "Colour number" }),
                node: (
                  field("Colour number", "color_code")
                ),
              },
            ]} />
            <FieldPack items={[
              {
                need: fieldNeed("w", { control: "choice", label: "Weight" }),
                node: (
                  <label className="block">
                    <span className="block text-xs text-muted mb-0.5">Weight</span>
                    <select value={f.weight} onChange={set("weight")} className="input text-sm">
                      <option value="">Not given</option>
                      {WEIGHTS.map((w) => (
                        <option key={w} value={w}>
                          {w}
                        </option>
                      ))}
                    </select>
                  </label>
                ),
              },
              {
                need: fieldNeed("fiber", { control: "text", label: "Fibre" }),
                node: (
                  field("Fibre", "fiber")
                ),
              },
            ]} />
            <FieldPack items={[
              {
                need: fieldNeed("quantity", { control: "number", label: "How many" }),
                node: (
                  field("How many", "quantity", { type: "number", min: 0, step: "any", inputMode: "decimal" })
                ),
              },
              {
                need: fieldNeed("quantity_unit", { control: "text", label: "Of what (ball, skein, hank)" }),
                node: (
                  field("Of what (ball, skein, hank)", "quantity_unit")
                ),
              },
              {
                need: fieldNeed("unit_length_m", { control: "number", label: "Metres in one" }),
                node: (
                  field("Metres in one", "unit_length_m", { type: "number", min: 0, step: "any", inputMode: "decimal" })
                ),
              },
              {
                need: fieldNeed("length_m", { control: "number", label: "Metres in all" }),
                node: (
                  field("Metres in all", "length_m", { type: "number", min: 0, step: "any", inputMode: "decimal", placeholder: "worked out" })
                ),
              },
            ]} />
          </>
        ) : (
          <>
            <label className="block">
              <span className="block text-xs text-muted mb-0.5">Hook or needle</span>
              <select value={kind} onChange={(e) => setKind(e.target.value as PatternNeedKind)} className="input text-sm">
                <option value="hook">Crochet hook</option>
                <option value="needle">Knitting needle</option>
              </select>
            </label>
            <FieldPack items={[
              {
                need: fieldNeed("size_mm", { control: "number", label: "Size in mm" }),
                node: (
                  field("Size in mm", "size_mm", { type: "number", min: 0, step: "any", inputMode: "decimal" })
                ),
              },
              {
                need: fieldNeed("size_label", { control: "text", label: "Other name (US H-8)" }),
                node: (
                  field("Other name (US H-8)", "size_label")
                ),
              },
            ]} />
          </>
        )}
        {save.isError && <p className="text-xs text-ember-600 dark:text-ember-400">Could not save: {(save.error as Error).message}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-2 text-sm text-muted">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => save.mutate()}
            disabled={save.isPending || (kind === "notion" ? !f.label : kind !== "yarn" && !(Number(f.size_mm) > 0))}
            className="rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm px-3 py-2 disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </div>
    </RecordFormModal>
  );
}
