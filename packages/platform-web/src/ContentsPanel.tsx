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

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Package, Plus, ScanLine, X } from "lucide-react";
import { useToast } from "./ToastContext";
import type { PlatformResolvedEntity } from "./types";

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
  method: "GET" | "POST",
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
function isContainable(traits: Record<string, unknown> | null | undefined): boolean {
  const v = traits?.containment;
  if (v == null) return false;
  return typeof v === "string" || typeof (v as { trait?: unknown }).trait === "string";
}

export function ContentsPanel({
  slug,
  getToken,
  container,
  title = "Contents",
  scanIntoHref,
}: {
  slug: string;
  getToken: GetToken;
  container: { kind: string; id: string };
  title?: string;
  /** When set, a "Scan in" link arms this container in the camera so scanned
   *  items file straight inside it (the caller builds the route). */
  scanIntoHref?: string;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const key = ["placement-contents", slug, container.kind, container.id];

  const contents = useQuery({
    queryKey: key,
    queryFn: () =>
      papi<{ items: PlatformResolvedEntity[] }>(
        slug,
        getToken,
        "GET",
        `/modules/core-placement/contents?container_kind=${encodeURIComponent(container.kind)}&container_id=${encodeURIComponent(container.id)}`,
      ),
    enabled: !!slug && !!container.id,
    staleTime: 30_000,
  });
  const items = contents.data?.items ?? [];

  const [adding, setAdding] = useState(false);
  const [addKind, setAddKind] = useState("");
  const [addId, setAddId] = useState("");
  const [newName, setNewName] = useState("");

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
        .map((k) => ({ kind: k.id, label: k.display_name, createPath: createPathFor(k) })),
    [kindsQ.data],
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

  const place = useMutation({
    mutationFn: () =>
      papi<void>(slug, getToken, "POST", `/modules/core-placement/place`, {
        containee: { kind: addKind, id: addId },
        container,
      }),
    onSuccess: () => {
      toast.success("Added");
      setAdding(false);
      setAddId("");
      void qc.invalidateQueries({ queryKey: key });
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
      toast.success("Created and added");
      setNewName("");
      setAdding(false);
      void qc.invalidateQueries({ queryKey: key });
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
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  return (
    <div className="rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900">
      <div className="flex items-center justify-between px-3 py-2 border-b border-line dark:border-slate-700">
        <div className="flex items-center gap-2 text-sm font-medium text-content dark:text-slate-200">
          <Package size={15} className="text-muted" />
          {title}
          {items.length > 0 && <span className="text-xs text-faint">({items.length})</span>}
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
            <Plus size={13} /> Add
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
            onChange={(e) => setAddId(e.target.value)}
            className="px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900 min-w-[10rem]"
          >
            <option value="">{candidates.isLoading ? "Loading…" : "Pick an item…"}</option>
            {(candidates.data?.items ?? [])
              .filter((c) => !(c.kind === container.kind && c.id === container.id))
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
          </select>
          <button
            type="button"
            disabled={!addId || place.isPending}
            onClick={() => place.mutate()}
            className="px-2.5 py-1 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white"
          >
            Add
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
                Create &amp; add
              </button>
            </>
          )}
        </div>
      )}

      {items.length === 0 ? (
        <div className="px-3 py-4 text-sm text-faint">Nothing inside yet.</div>
      ) : (
        <ul className="divide-y divide-line dark:divide-slate-800">
          {items.map((it) => (
            <li key={`${it.kind}:${it.id}`} className="flex items-center justify-between gap-2 px-3 py-2">
              {it.detailUrl ? (
                <Link to={it.detailUrl} className="text-sm text-content dark:text-slate-200 hover:text-accent truncate">
                  {it.title}
                  {it.subtitle && <span className="text-xs text-faint"> · {it.subtitle}</span>}
                </Link>
              ) : (
                <span className="text-sm text-content dark:text-slate-200 truncate">{it.title}</span>
              )}
              <button
                type="button"
                onClick={() => remove.mutate(it)}
                className="shrink-0 p-1 text-faint hover:text-red-500"
                aria-label={`Remove ${it.title}`}
                title="Remove from this container"
              >
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
