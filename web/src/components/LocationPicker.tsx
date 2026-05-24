// LocationPicker — picks a row from core-locations:location. Used
// wherever an entity has a `location_id: string | null` field (machines,
// assets, inventory parts, future kinds). Renders as a nested-indent
// dropdown so the hierarchy is legible at a glance.
//
// The "+ new location" sentinel in the dropdown opens an inline modal
// that creates the row, then auto-selects it — so a user discovering
// they need a new location doesn't have to abandon their form.

import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal, useToast } from "@cobblr/platform-web";
import { ApiError, api, type Location } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

const CREATE_SENTINEL = "__new__";
// U+00A0 (non-breaking space) for option indentation — regular spaces
// get collapsed in <option> text by every major browser.
const INDENT = "  ";

interface Props {
  value: string | null;
  onChange: (value: string | null) => void;
  /** When set, the option for this id is excluded — used in the
   *  Locations admin form to prevent picking yourself as a parent.
   *  Doesn't filter descendants (caller's job if needed). */
  excludeId?: string;
  /** Visible <label> wrapped around the select. Omit when the caller
   *  draws their own label. */
  label?: string;
  className?: string;
  size?: "sm" | "md";
}

export function LocationPicker({
  value,
  onChange,
  excludeId,
  label,
  className,
  size = "md",
}: Props) {
  const { activeSlug } = useActiveOrg();
  const [createOpen, setCreateOpen] = useState(false);

  const list = useQuery({
    queryKey: ["core-locations", activeSlug],
    queryFn: () => api.listLocations(activeSlug),
    enabled: !!activeSlug,
  });
  const items = (list.data?.items ?? []).filter((i) => i.id !== excludeId);

  const sizeClass = size === "sm" ? "px-2 py-1 text-xs" : "px-2 py-1 text-sm";

  const select = (
    <select
      value={value ?? ""}
      onChange={(e) => {
        if (e.target.value === CREATE_SENTINEL) {
          setCreateOpen(true);
          return;
        }
        onChange(e.target.value || null);
      }}
      className={
        "w-full border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-900 " +
        sizeClass +
        (className ? " " + className : "")
      }
    >
      <option value="">(no location)</option>
      {items.map((loc) => (
        <option key={loc.id} value={loc.id}>
          {INDENT.repeat(loc.depth)}
          {loc.short_name ?? loc.name}
          {loc.short_name && loc.short_name !== loc.name ? ` — ${loc.name}` : ""}
        </option>
      ))}
      <option value={CREATE_SENTINEL}>+ new location…</option>
    </select>
  );

  const body = label ? (
    <label className="block">
      <span className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">
        {label}
      </span>
      {select}
    </label>
  ) : (
    select
  );

  return (
    <>
      {body}
      {createOpen && (
        <QuickCreateLocationModal
          slug={activeSlug}
          parents={list.data?.items ?? []}
          onClose={() => setCreateOpen(false)}
          onCreated={(loc) => {
            onChange(loc.id);
            setCreateOpen(false);
          }}
        />
      )}
    </>
  );
}

// Minimal create modal — name + parent + kind, mirrors the full form
// on /configuration/locations but trimmed for in-flight use. The
// shared "edit a location" modal isn't extracted yet; if it gets
// extracted, replace this body with that component.
function QuickCreateLocationModal({
  slug,
  parents,
  onClose,
  onCreated,
}: {
  slug: string;
  parents: Location[];
  onClose: () => void;
  onCreated: (loc: Location) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState("");
  const [shortName, setShortName] = useState("");
  const [kind, setKind] = useState<"area" | "container">("container");
  const [parentId, setParentId] = useState<string>("");

  const create = useMutation({
    mutationFn: () =>
      api.createLocation(slug, {
        name: name.trim(),
        short_name: shortName.trim() || null,
        kind,
        parent_id: parentId || null,
      }),
    onSuccess: (loc) => {
      void qc.invalidateQueries({ queryKey: ["core-locations", slug] });
      toast.success("Location created");
      onCreated(loc);
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : String(err));
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    create.mutate();
  }

  return (
    <Modal open onClose={onClose} title="New location">
      <form onSubmit={submit} className="space-y-3">
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">
            Name
          </span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            placeholder="e.g. Bin 17"
            className="w-full px-2 py-1 text-sm border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-900"
          />
        </label>
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">
            Short name (optional)
          </span>
          <input
            type="text"
            value={shortName}
            onChange={(e) => setShortName(e.target.value)}
            className="w-full px-2 py-1 text-sm border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-900"
          />
        </label>
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">
            Parent
          </span>
          <select
            value={parentId}
            onChange={(e) => setParentId(e.target.value)}
            className="w-full px-2 py-1 text-sm border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-900"
          >
            <option value="">(top-level)</option>
            {parents.map((p) => (
              <option key={p.id} value={p.id}>
                {INDENT.repeat(p.depth)}
                {p.short_name ?? p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">
            Kind
          </span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as "area" | "container")}
            className="w-full px-2 py-1 text-sm border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-900"
          >
            <option value="container">container (bin, drawer, shelf)</option>
            <option value="area">area (room, corner, workshop)</option>
          </select>
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!name.trim() || create.isPending}
            className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white"
          >
            {create.isPending ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
