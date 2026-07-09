// ContentsPanel — "what's installed / stored inside this container?".
// Generic: drop it on ANY container entity's detail (a server asset, a 3D
// printer machine, a drawer) and it lists what's placed inside, with add +
// remove. Reads/writes the placement primitive via core-placement's HTTP API;
// a Location is just one kind of container, so this is the same panel
// everywhere. Nothing here is use-case-specific.

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Package, Plus, X } from "lucide-react";
import { api, ApiError, type PlatformResolvedEntity } from "../lib/api";
import { useToast } from "@cobblr/platform-web";

// A kind can be placed inside a container when it declares a containment trait
// (containable OR container — both are physical things). Read off the registry,
// tolerating the `{ trait, uncertain }` inference form — mirrors the server's
// canBeContained gate. NEVER a hardcoded module list: the registry is what
// keeps this panel working for every current and future module
// (scripts/lint-generic-component-kinds.ts enforces this).
function isContainable(traits: Record<string, unknown> | null | undefined): boolean {
  const v = traits?.containment;
  if (v == null) return false;
  return typeof v === "string" || typeof (v as { trait?: unknown }).trait === "string";
}

export function ContentsPanel({
  slug,
  container,
  title = "Contents",
}: {
  slug: string;
  container: { kind: string; id: string };
  title?: string;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const key = ["placement-contents", slug, container.kind, container.id];

  const contents = useQuery({
    queryKey: key,
    queryFn: () => api.placementContents(slug, container.kind, container.id),
    enabled: !!slug && !!container.id,
    staleTime: 30_000,
  });
  const items = contents.data?.items ?? [];

  const [adding, setAdding] = useState(false);
  const [addKind, setAddKind] = useState("");
  const [addId, setAddId] = useState("");

  // Containable kinds, from the entity-kind registry's declared traits.
  const kindsQ = useQuery({
    queryKey: ["entity-kinds", slug],
    queryFn: () => api.listEntityKinds(slug),
    enabled: adding && !!slug,
    staleTime: 60_000,
  });
  const containeeKinds = useMemo(
    () =>
      (kindsQ.data?.items ?? [])
        .filter((k) => isContainable(k.traits))
        .map((k) => ({ kind: k.id, label: k.display_name })),
    [kindsQ.data],
  );

  // Candidate entities of the chosen kind (for the add picker).
  const candidates = useQuery({
    queryKey: ["placement-candidates", slug, addKind],
    queryFn: () => api.listEntities(slug, addKind),
    enabled: adding && !!slug && !!addKind,
    staleTime: 30_000,
  });

  const place = useMutation({
    mutationFn: () =>
      api.placementPlace(slug, { containee: { kind: addKind, id: addId }, container }),
    onSuccess: () => {
      toast.success("Added");
      setAdding(false);
      setAddId("");
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const remove = useMutation({
    mutationFn: (it: PlatformResolvedEntity) =>
      api.placementRemove(slug, { kind: it.kind, id: it.id }),
    onSuccess: () => {
      toast.success("Removed");
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  return (
    <div className="rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900">
      <div className="flex items-center justify-between px-3 py-2 border-b border-line dark:border-slate-700">
        <div className="flex items-center gap-2 text-sm font-medium text-content dark:text-slate-200">
          <Package size={15} className="text-muted" />
          {title}
          {items.length > 0 && <span className="text-xs text-faint">({items.length})</span>}
        </div>
        <button
          type="button"
          onClick={() => setAdding((v) => !v)}
          className="flex items-center gap-1 text-xs text-accent hover:underline"
        >
          <Plus size={13} /> Add
        </button>
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
