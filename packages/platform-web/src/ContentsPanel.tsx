// ContentsPanel — "what's installed / stored inside this container?".
//
// Generic + self-contained: drop it on ANY container entity's detail (a server
// asset, a 3D printer machine, a box or bag tracked as a part, a drawer) and it
// lists what's placed inside, with add + remove. It talks to the core-placement
// HTTP API directly using the caller's slug + getToken, so it works from a web
// page OR a module UI with no dependency on the web app's api client — which is
// why it lives here in platform-web, not web/src. A Location is just one KIND of
// container, so this is the same panel everywhere; nothing here is
// use-case-specific.
//
// Containment is gated server-side (a container must be `physical`; a containee
// must be `containable`), so the panel appears on every physical record but only
// accepts things that can actually go inside one.

import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { LogOut, Package, Pencil, Plus, ScanLine, X } from "lucide-react";
import { useToast } from "./ToastContext";
import { useViewerRole } from "./context";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import type { PlatformResolvedEntity } from "./types";
import { formatStoredMoney } from "@cobblr/platform-contract/money";

type GetToken = () => string | null;

interface KindRow {
  id: string;
  display_name: string;
  module_name?: string;
  /** Set only on synthesized instance kinds (`<instance>:item`); its endpoints
   *  are then relative to /instances/<instance_name>, not /modules/<module>. */
  instance_name?: string;
  endpoints?: { create?: string } | null;
  traits?: Record<string, unknown> | null;
}

/** The org-scoped POST path that creates an entity of this kind, from its
 *  registry-declared create endpoint, or null if it declares none. Base kinds
 *  are relative to /modules/<module>; synthesized instance kinds to
 *  /instances/<instance_name>. Registry-driven — never a hardcoded module list. */
function createPathFor(k: KindRow): string | null {
  const suffix = k.endpoints?.create;
  if (!suffix) return null;
  const base = k.instance_name ? `/instances/${k.instance_name}` : k.module_name ? `/modules/${k.module_name}` : null;
  return base ? `${base}${suffix}` : null;
}

/** Thin fetch over the org-scoped API, Bearer from the caller's token getter. */
async function papi<T>(
  slug: string,
  getToken: GetToken,
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`/api/v1/orgs/${slug}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const parsed = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (parsed as { error?: { message?: string } } | null)?.error?.message;
    throw new Error(msg ?? `HTTP ${res.status}`);
  }
  return parsed as T;
}

// A kind can be placed inside a container when it declares a containment trait
// (containable OR container — both are physical things). Read off the registry,
// tolerating the `{ trait, uncertain }` inference form — mirrors the server's
// canBeContained gate. NEVER a hardcoded module list: the registry is what keeps
// this panel working for every current and future module.
function isPlaceKind(traits: Record<string, unknown> | null | undefined): boolean {
  const v = traits?.containment;
  return (typeof v === "string" ? v : (v as { trait?: unknown } | null | undefined)?.trait) === "container";
}

function isContainable(traits: Record<string, unknown> | null | undefined): boolean {
  const v = traits?.containment;
  if (v == null) return false;
  return typeof v === "string" || typeof (v as { trait?: unknown }).trait === "string";
}

/** "roughly 50 more" when any of the contents is an estimate rather than a
 *  count. Returns null when everything inside has been counted, so an ordinary
 *  container is unchanged. */
export function assortedSummary(
  items: Array<{ fields?: Record<string, unknown> | null }>,
): string | null {
  let total = 0;
  let n = 0;
  for (const it of items) {
    const a = it.fields?.approximate_qty;
    if (a == null) continue;
    const v = Number(a);
    if (!Number.isFinite(v)) continue;
    total += v;
    n++;
  }
  if (n === 0) return null;
  return `· roughly ${total} in ${n === 1 ? "an assortment" : `${n} assortments`}`;
}

/** A thing built from parts, as /built answers it. */
interface BuiltResp {
  other: number | null;
  parts: Array<{ kind: string; id: string; name: string; qty: number | null; value: number | null; value_total: number }>;
  built: number;
  total: number;
  withheld: boolean;
}

/** A value in the workspace currency's main unit, as every surface shows money. */
function money(n: number): string {
  return formatStoredMoney(n, "amount") ?? "";
}

function contentsQuery(slug: string, getToken: GetToken, container: { kind: string; id: string }) {
  return {
    queryKey: ["placement-contents", slug, container.kind, container.id],
    queryFn: () =>
      papi<{ items: PlatformResolvedEntity[] }>(
        slug,
        getToken,
        "GET",
        `/modules/core-placement/contents?container_kind=${encodeURIComponent(container.kind)}&container_id=${encodeURIComponent(container.id)}`,
      ),
    enabled: !!slug && !!container.id,
    staleTime: 30_000,
  };
}

/** Does anything sit inside this record? The same read ContentsPanel makes
 *  (one request between them), for a container face that is off: a folded
 *  face never hides what a record already holds. */
export function useHoldsContents(slug: string, getToken: GetToken, container: { kind: string; id: string }): boolean {
  return (useQuery(contentsQuery(slug, getToken, container)).data?.items.length ?? 0) > 0;
}

export function ContentsPanel({
  slug,
  getToken,
  container,
  title,
  scanIntoHref,
  builtFrom = false,
  takeOutPicker,
  wordKind,
}: {
  slug: string;
  getToken: GetToken;
  container: { kind: string; id: string };
  title?: string;
  /** When set, a "Scan in" link arms this container in the camera so scanned
   *  items file straight inside it (the caller builds the route). */
  scanIntoHref?: string;
  /** A thing built from parts (a computer, a machine): parts are installed,
   *  some of a counted part at a time, each with its value, and the total adds
   *  them to the thing's own value (other value, not itemized). Take out sends
   *  a part back where it came from, with undo. */
  builtFrom?: boolean;
  /** A place picker for "Take out to…", from the page (the panel cannot know
   *  the places itself); it calls onPick with where the part goes. */
  takeOutPicker?: (onPick: (to: { kind: string; id: string }) => void) => ReactNode;
  /** The kind whose word names this panel ("Parts" for a Computers record);
   *  a collection's kind keeps its own. Defaults to the container's kind. */
  wordKind?: string;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const q = contentsQuery(slug, getToken, container);
  // The kind's own word for what is inside ("Parts", "In the bag"), when the
  // workspace or a bundle gave one; owners and admins rename it from here.
  const kindForWord = wordKind ?? container.kind;
  const wordQ = useQuery({
    queryKey: ["contents-word", slug, kindForWord],
    queryFn: () =>
      papi<{ word: string | null; custom: string | null; default_word: string | null }>(
        slug,
        getToken,
        "GET",
        `/modules/core-placement/word?kind=${encodeURIComponent(kindForWord)}`,
      ),
    enabled: !!slug && !!kindForWord,
    staleTime: 60_000,
  });
  const heading = wordQ.data?.word ?? title ?? (builtFrom ? "Built from" : "Contents");
  const role = useViewerRole();
  const canRename = roleSatisfies(role, ["admin"]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const rename = useMutation({
    mutationFn: (word: string | null) =>
      papi<{ word: string | null }>(slug, getToken, "PUT", `/modules/core-placement/word`, { kind: kindForWord, word }),
    onSuccess: (r) => {
      setRenaming(null);
      void qc.invalidateQueries({ queryKey: ["contents-word", slug, kindForWord] });
      toast.success(r?.word ? `Every one of these now says ${r.word}` : "Back to the default word");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  const contents = useQuery(q);
  const items = contents.data?.items ?? [];

  const built = useQuery({
    queryKey: ["placement-built", slug, container.kind, container.id],
    queryFn: () =>
      papi<BuiltResp>(
        slug,
        getToken,
        "GET",
        `/modules/core-placement/built?container_kind=${encodeURIComponent(container.kind)}&container_id=${encodeURIComponent(container.id)}`,
      ),
    enabled: builtFrom && !!slug && !!container.id,
    staleTime: 30_000,
  });
  const partOf = useMemo(() => new Map((built.data?.parts ?? []).map((p) => [`${p.kind}:${p.id}`, p])), [built.data]);
  // A move changes the counts and values here, and the lists elsewhere.
  const refresh = () => void qc.invalidateQueries();

  const [adding, setAdding] = useState(false);
  const [addKind, setAddKind] = useState("");
  const [addId, setAddId] = useState("");
  const [addQty, setAddQty] = useState(1);
  const [newName, setNewName] = useState("");
  const [takingOut, setTakingOut] = useState<string | null>(null);

  // Containable kinds, from the entity-kind registry's declared traits.
  const kindsQ = useQuery({
    queryKey: ["entity-kinds", slug],
    queryFn: () => papi<{ items: KindRow[] }>(slug, getToken, "GET", `/entity-kinds`),
    enabled: adding && !!slug,
    staleTime: 60_000,
  });
  const containeeKinds = useMemo(
    () =>
      (kindsQ.data?.items ?? [])
        .filter((k) => isContainable(k.traits))
        // A place (a room, a shelf) is not a part anything is built from.
        .filter((k) => !builtFrom || !isPlaceKind(k.traits))
        .map((k) => ({ kind: k.id, label: k.display_name, createPath: createPathFor(k) })),
    [kindsQ.data, builtFrom],
  );
  const selectedKind = containeeKinds.find((k) => k.kind === addKind);

  // Candidate entities of the chosen kind (for the add picker).
  const candidates = useQuery({
    queryKey: ["placement-candidates", slug, addKind],
    queryFn: () =>
      papi<{ items: PlatformResolvedEntity[] }>(
        slug,
        getToken,
        "GET",
        `/entities/${encodeURIComponent(addKind)}`,
      ),
    enabled: adding && !!slug && !!addKind,
    staleTime: 30_000,
  });

  // How many of the picked thing there are: a counted part offers "how many".
  const picked = (candidates.data?.items ?? []).find((c) => c.id === addId);
  const pickedQty = Number(picked?.fields?.qty ?? NaN);
  const counted = builtFrom && Number.isFinite(pickedQty) && pickedQty > 1;

  const place = useMutation({
    mutationFn: () =>
      papi<{ placed?: { kind: string; id: string } }>(slug, getToken, "POST", `/modules/core-placement/place`, {
        containee: { kind: addKind, id: addId },
        container,
        ...(counted && addQty < pickedQty ? { qty: addQty } : {}),
      }),
    onSuccess: (r) => {
      setAdding(false);
      setAddId("");
      setAddQty(1);
      refresh();
      if (!builtFrom) {
        toast.success(`Added to ${heading}`);
        return;
      }
      const placed = r?.placed ?? { kind: addKind, id: addId };
      toast.action(counted ? `Added ${Math.min(addQty, pickedQty)} × ${picked?.title ?? "it"} to ${heading}` : `Added ${picked?.title ?? "it"} to ${heading}`, {
        actionLabel: "Undo",
        onAction: async () => {
          await papi(slug, getToken, "POST", `/modules/core-placement/return-home`, { containee: placed });
          refresh();
        },
        duration: 8000,
      });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  // Take a part out: back where it came from (it joins the spares kept
  // there), or to a place picked; Undo puts that many back in.
  const takeOut = useMutation({
    mutationFn: async ({ it, to }: { it: PlatformResolvedEntity; to?: { kind: string; id: string } }) => {
      const containee = { kind: it.kind, id: it.id };
      if (to) {
        const r = await papi<{ placed?: { kind: string; id: string } }>(slug, getToken, "POST", `/modules/core-placement/place`, { containee, container: to });
        return { it, placed: r?.placed ?? containee, where: null as string | null };
      }
      const r = await papi<{ to: { title?: string } | null; placed?: { kind: string; id: string } }>(slug, getToken, "POST", `/modules/core-placement/return-home`, { containee });
      return { it, placed: r?.placed ?? containee, where: r?.to?.title ?? null };
    },
    onSuccess: ({ it, placed, where }) => {
      setTakingOut(null);
      refresh();
      const n = partOf.get(`${it.kind}:${it.id}`)?.qty ?? null;
      toast.action(where ? `Took ${it.title} out of ${heading}: it is back in ${where}` : `Took ${it.title} out of ${heading}`, {
        actionLabel: "Undo",
        onAction: async () => {
          await papi(slug, getToken, "POST", `/modules/core-placement/place`, { containee: placed, container, ...(n ? { qty: n } : {}) });
          refresh();
        },
        duration: 8000,
      });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  // Create a brand-new containee (a mug you don't have a record for yet) and place
  // it inside, in one step. Uses the kind's registry-declared create endpoint, so
  // it works for any creatable containable kind, not just parts. When a kind
  // declares no create endpoint the "new" field is hidden (pick an existing one).
  const createAndPlace = useMutation({
    mutationFn: async () => {
      const path = selectedKind?.createPath;
      if (!path) throw new Error("this type can't be created here");
      const created = await papi<{ id: string }>(slug, getToken, "POST", path, { name: newName.trim() });
      await papi<void>(slug, getToken, "POST", `/modules/core-placement/place`, {
        containee: { kind: addKind, id: created.id },
        container,
      });
    },
    onSuccess: () => {
      toast.success(`Created and added to ${heading}`);
      setNewName("");
      setAdding(false);
      refresh();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  const remove = useMutation({
    mutationFn: (it: PlatformResolvedEntity) =>
      papi<void>(slug, getToken, "POST", `/modules/core-placement/remove`, {
        containee: { kind: it.kind, id: it.id },
      }),
    onSuccess: () => {
      toast.success("Removed");
      refresh();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  return (
    <div className="rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900">
      <div className="flex items-center justify-between px-3 py-2 border-b border-line dark:border-slate-700">
        <div className="flex items-center gap-2 text-sm font-medium text-content dark:text-slate-200">
          <Package size={15} className="text-muted" />
          {renaming !== null ? (
            <input
              autoFocus
              value={renaming}
              maxLength={40}
              aria-label="What to call what is inside"
              placeholder={wordQ.data?.default_word ?? "Contents"}
              onChange={(e) => setRenaming(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") rename.mutate(renaming.trim() || null);
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setRenaming(null);
                }
              }}
              onBlur={() => setRenaming(null)}
              className="w-40 px-1.5 py-0.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
            />
          ) : (
            heading
          )}
          {canRename && renaming === null && (
            <button
              type="button"
              onClick={() => setRenaming(wordQ.data?.custom ?? heading)}
              className="p-0.5 text-faint hover:text-accent"
              aria-label={`Rename ${heading}`}
              title="Rename this for every one of these (empty puts the default back)"
            >
              <Pencil size={12} />
            </button>
          )}
          {items.length > 0 && <span className="text-xs text-faint">({items.length})</span>}
          {/* An estimate in here means the count on the left is not the story:
              "(3)" on a bin holding an assortment of fifty is technically true
              and completely misleading. Say the rough total too. */}
          {assortedSummary(items) && (
            <span className="text-xs text-faint">{assortedSummary(items)}</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {scanIntoHref && (
            <Link
              to={scanIntoHref}
              className="flex items-center gap-1 text-xs text-accent hover:underline"
              title="Open the camera armed to file scanned items straight into this"
            >
              <ScanLine size={13} /> Scan in
            </Link>
          )}
          <button
            type="button"
            onClick={() => setAdding((v) => !v)}
            className="flex items-center gap-1 text-xs text-accent hover:underline"
          >
            <Plus size={13} /> {builtFrom ? "Install" : "Add"}
          </button>
        </div>
      </div>

      {adding && (
        <div className="flex flex-wrap items-center gap-1.5 px-3 py-2 border-b border-line dark:border-slate-700 bg-subtle dark:bg-slate-800/50">
          <select
            value={addKind}
            onChange={(e) => {
              setAddKind(e.target.value);
              setAddId("");
            }}
            className="px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
          >
            <option value="">{kindsQ.isLoading ? "Loading…" : "Type…"}</option>
            {containeeKinds.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </select>
          <select
            value={addId}
            onChange={(e) => {
              setAddId(e.target.value);
              setAddQty(1);
            }}
            className="px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900 min-w-[10rem]"
          >
            <option value="">{candidates.isLoading ? "Loading…" : "Pick an item…"}</option>
            {(candidates.data?.items ?? [])
              .filter((c) => !(c.kind === container.kind && c.id === container.id))
              // What is already inside is not offered again (a part installed
              // here is a record of its own, and read as a second copy).
              .filter((c) => !items.some((it) => it.id === c.id))
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
          </select>
          {counted && (
            <label className="flex items-center gap-1 text-xs text-muted">
              <input
                type="number"
                min={1}
                max={pickedQty}
                value={addQty}
                onChange={(e) => setAddQty(Math.max(1, Math.min(pickedQty, Math.floor(Number(e.target.value) || 1))))}
                aria-label="How many to install"
                className="w-16 px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
              />
              of {pickedQty}
            </label>
          )}
          <button
            type="button"
            disabled={!addId || place.isPending}
            onClick={() => place.mutate()}
            className="px-2.5 py-1 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white"
          >
            {builtFrom ? "Install" : "Add"}
          </button>
          {selectedKind?.createPath && (
            <>
              <span className="text-xs text-faint px-0.5">or</span>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={`new ${selectedKind.label.toLowerCase()}…`}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newName.trim() && !createAndPlace.isPending) createAndPlace.mutate();
                }}
                className="px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900 min-w-[8rem]"
              />
              <button
                type="button"
                disabled={!newName.trim() || createAndPlace.isPending}
                onClick={() => createAndPlace.mutate()}
                className="px-2.5 py-1 text-sm rounded border border-cobble-600 text-cobble-700 dark:text-cobble-300 hover:bg-cobble-50 dark:hover:bg-slate-800 disabled:opacity-50"
              >
                {builtFrom ? "Create & install" : "Create & add"}
              </button>
            </>
          )}
        </div>
      )}

      {items.length === 0 ? (
        <div className="px-3 py-4 text-sm text-faint">Nothing inside yet.</div>
      ) : (
        <ul className="divide-y divide-line dark:divide-slate-800">
          {items.map((it) => {
            const part = partOf.get(`${it.kind}:${it.id}`);
            const key = `${it.kind}:${it.id}`;
            return (
              <li key={key} className="px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  {it.detailUrl ? (
                    <Link to={it.detailUrl} className="min-w-0 text-sm text-content dark:text-slate-200 hover:text-accent truncate">
                      {builtFrom && part?.qty != null && part.qty !== 1 && <span className="text-faint">{part.qty} × </span>}
                      {it.title}
                      {it.subtitle && <span className="text-xs text-faint"> · {it.subtitle}</span>}
                    </Link>
                  ) : (
                    <span className="min-w-0 text-sm text-content dark:text-slate-200 truncate">{it.title}</span>
                  )}
                  <div className="flex shrink-0 items-center gap-1">
                    {builtFrom && part && part.value_total > 0 && <span className="text-xs tabular-nums text-muted">{money(part.value_total)}</span>}
                    {builtFrom ? (
                      <>
                        <button
                          type="button"
                          onClick={() => takeOut.mutate({ it })}
                          disabled={takeOut.isPending}
                          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted hover:text-accent"
                          aria-label={`Take ${it.title} out`}
                          title="Take it out: back where it came from"
                        >
                          <LogOut size={13} /> Take out
                        </button>
                        {takeOutPicker && (
                          <button
                            type="button"
                            onClick={() => setTakingOut(takingOut === key ? null : key)}
                            className="rounded px-1.5 py-0.5 text-xs text-muted hover:text-accent"
                            title="Take it out to a place you pick"
                          >
                            to…
                          </button>
                        )}
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => remove.mutate(it)}
                        className="p-1 text-faint hover:text-red-500"
                        aria-label={`Remove ${it.title}`}
                        title="Remove from this container"
                      >
                        <X size={14} />
                      </button>
                    )}
                  </div>
                </div>
                {takingOut === key && takeOutPicker && (
                  <div className="mt-2">{takeOutPicker((to) => takeOut.mutate({ it, to }))}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {/* Until something is installed it reads as it always did: no sum. */}
      {builtFrom && built.data && built.data.parts.length > 0 && (
        <div data-testid="built-value" className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-line dark:border-slate-700 px-3 py-2 text-xs text-muted">
          {built.data.other != null && <span>Other value (not itemized) {money(built.data.other)}</span>}
          {built.data.parts.length > 0 && <span>Parts {money(built.data.built)}</span>}
          <span className="font-medium text-content dark:text-slate-200">Total {money(built.data.total)}</span>
          {built.data.withheld && <span className="text-faint">Some part values are not shown to you, so they are left out.</span>}
        </div>
      )}
    </div>
  );
}
