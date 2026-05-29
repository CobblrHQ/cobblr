// /configuration/presentation — workspace presentation overrides
// editor. The unified registry where the workspace customises how
// every nav entry (entity kinds, module instances, lens bundles)
// renders: display label, plural form, icon, hidden, nav order.
//
// Edits here trump bundle-shipped defaults. Re-installing a bundle
// doesn't clobber rows in this table (insertOnly on the server).

import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Eye, EyeOff, Pencil, RotateCcw } from "lucide-react";
import { Modal, useToast, useConfirm, usePageTitle } from "@cobblr/platform-web";
import {
  ApiError,
  api,
  type EntityKindOverride,
} from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { HeadingsBuilder } from "../components/HeadingsBuilder";

export function PresentationPage() {
  usePageTitle("Presentation");
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<EntityKindOverride | null>(null);
  const [addingFor, setAddingFor] = useState<
    | null
    | {
        target_kind: "entity_kind" | "instance" | "bundle";
        target_id: string;
        defaultLabel: string;
      }
  >(null);

  const overrides = useQuery({
    queryKey: ["entity-kind-overrides", activeSlug],
    queryFn: () => api.listOverrides(activeSlug),
    enabled: !!activeSlug,
  });
  const instances = useQuery({
    queryKey: ["instances", activeSlug],
    queryFn: () => api.listInstances(activeSlug),
    enabled: !!activeSlug,
  });
  const kinds = useQuery({
    queryKey: ["entity-kinds", activeSlug],
    queryFn: () => api.listEntityKinds(activeSlug),
    enabled: !!activeSlug,
  });

  const reset = useMutation({
    mutationFn: (o: EntityKindOverride) =>
      api.deleteOverride(activeSlug, o.target_kind, o.target_id),
    onSuccess: () => {
      toast.success("Reset to default.");
      void qc.invalidateQueries({ queryKey: ["entity-kind-overrides", activeSlug] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  // Build the rendered list of "things in the nav": every instance +
  // every kind that ISN'T owned by an instance. Each gets a row
  // showing manifest defaults + the override (if any).
  const overridesByTarget = new Map<
    string,
    EntityKindOverride
  >();
  for (const o of overrides.data?.items ?? []) {
    overridesByTarget.set(`${o.target_kind}:${o.target_id}`, o);
  }

  type Row = {
    target_kind: "entity_kind" | "instance" | "bundle";
    target_id: string;
    defaultLabel: string;
    icon: string | null;
    override: EntityKindOverride | null;
    moduleName?: string;
  };
  const rows: Row[] = [];

  // Instances first (each is a top-level workspace thing)
  for (const inst of instances.data?.items ?? []) {
    const key = `instance:${inst.module_name}:${inst.instance_name}`;
    rows.push({
      target_kind: "instance",
      target_id: `${inst.module_name}:${inst.instance_name}`,
      defaultLabel: inst.display_name,
      icon: null,
      override: overridesByTarget.get(key) ?? null,
      moduleName: inst.module_name,
    });
  }

  // Entity kinds that aren't from a multi-instance module's default
  // (those are shown as instances). Show foundational + singleton
  // module kinds.
  const moduleNames = new Set(
    (instances.data?.items ?? []).map((i) => i.module_name),
  );
  for (const k of kinds.data?.items ?? []) {
    if (moduleNames.has(k.module_name)) continue;
    const key = `entity_kind:${k.id}`;
    rows.push({
      target_kind: "entity_kind",
      target_id: k.id,
      defaultLabel: k.display_name,
      icon: k.icon,
      override: overridesByTarget.get(key) ?? null,
    });
  }

  // Sort by nav_order then default label
  rows.sort((a, b) => {
    const ao = a.override?.nav_order ?? 1000;
    const bo = b.override?.nav_order ?? 1000;
    if (ao !== bo) return ao - bo;
    return a.defaultLabel.localeCompare(b.defaultLabel);
  });

  return (
    <div className="space-y-4">
      <div>
        <Link
          to="/configuration"
          className="text-[10px] font-mono uppercase tracking-widest text-slate-400 hover:text-cobble-500 transition inline-flex items-center gap-1"
        >
          <ArrowLeft size={10} /> back to configuration
        </Link>
      </div>
      <div className="flex items-baseline gap-3 border-b border-slate-200 dark:border-slate-700 pb-3">
        <h1 className="text-2xl font-semibold text-slate-700 dark:text-mortar-100">
          Presentation
        </h1>
        <span className="text-sm text-slate-500 dark:text-slate-400">
          {rows.length} things in your workspace
        </span>
      </div>

      <p className="text-sm text-slate-600 dark:text-mortar-200">
        Customise how every top-level thing in your workspace renders —
        rename it, swap its icon, hide it from the nav, change its order.
        Workspace edits override module / bundle defaults; reinstalling
        a bundle doesn't clobber your edits.
      </p>

      <HeadingsBuilder />

      <div className="border-t border-slate-200 dark:border-slate-700 pt-3">
        <div className="text-[10px] font-mono uppercase tracking-widest text-cobble-500 mb-1">
          // entries
        </div>
      </div>

      <div className="space-y-1">
        {rows.map((row) => (
          <PresentationRow
            key={`${row.target_kind}:${row.target_id}`}
            row={row}
            onEdit={() => {
              if (row.override) setEditing(row.override);
              else
                setAddingFor({
                  target_kind: row.target_kind,
                  target_id: row.target_id,
                  defaultLabel: row.defaultLabel,
                });
            }}
            onReset={async () => {
              if (!row.override) return;
              const ok = await confirm({
                title: `Reset '${row.override.display_label ?? row.defaultLabel}' to default?`,
                message: "Restores manifest defaults. The override row is deleted.",
                confirmLabel: "Reset",
                destructive: false,
              });
              if (ok) reset.mutate(row.override);
            }}
          />
        ))}
      </div>

      {editing && (
        <PresentationEditModal
          override={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            void qc.invalidateQueries({ queryKey: ["entity-kind-overrides", activeSlug] });
            setEditing(null);
          }}
        />
      )}
      {addingFor && (
        <PresentationCreateModal
          target={addingFor}
          onClose={() => setAddingFor(null)}
          onSaved={() => {
            void qc.invalidateQueries({ queryKey: ["entity-kind-overrides", activeSlug] });
            setAddingFor(null);
          }}
        />
      )}
    </div>
  );
}

function PresentationRow({
  row,
  onEdit,
  onReset,
}: {
  row: {
    target_kind: "entity_kind" | "instance" | "bundle";
    target_id: string;
    defaultLabel: string;
    icon: string | null;
    override: EntityKindOverride | null;
    moduleName?: string;
  };
  onEdit: () => void;
  onReset: () => void;
}) {
  const o = row.override;
  const label = o?.display_label ?? row.defaultLabel;
  const hidden = o?.hidden ?? false;
  const navOrder = o?.nav_order;
  return (
    <div
      className={
        "rounded border bg-white dark:bg-slate-900 px-3 py-2 flex items-center gap-3 " +
        (hidden ? "border-slate-200 dark:border-slate-700 opacity-60" : "border-slate-200 dark:border-slate-700")
      }
    >
      <span
        className={
          "shrink-0 text-[10px] font-mono uppercase tracking-widest " +
          (row.target_kind === "instance" ? "text-cobble-500" : "text-slate-400")
        }
      >
        {row.target_kind === "instance" ? "instance" : "kind"}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-slate-700 dark:text-mortar-100 truncate">
          {label}
          {o?.display_label && o.display_label !== row.defaultLabel && (
            <span className="ml-2 text-[10px] font-mono text-slate-400">
              (default: {row.defaultLabel})
            </span>
          )}
        </div>
        <div className="text-[10px] font-mono text-slate-400 truncate">
          {row.target_id}
        </div>
      </div>
      {navOrder != null && (
        <span className="text-[10px] font-mono text-slate-400">order:{navOrder}</span>
      )}
      {hidden && <EyeOff size={14} className="text-slate-400" />}
      {!hidden && <Eye size={14} className="text-slate-400" />}
      <button
        type="button"
        onClick={onEdit}
        title="Edit"
        className="text-slate-400 hover:text-cobble-600 transition p-1"
      >
        <Pencil size={14} />
      </button>
      {o && (
        <button
          type="button"
          onClick={onReset}
          title="Reset to manifest default"
          className="text-slate-400 hover:text-ember-500 transition p-1"
        >
          <RotateCcw size={14} />
        </button>
      )}
    </div>
  );
}

function PresentationCreateModal({
  target,
  onClose,
  onSaved,
}: {
  target: {
    target_kind: "entity_kind" | "instance" | "bundle";
    target_id: string;
    defaultLabel: string;
  };
  onClose: () => void;
  onSaved: () => void;
}) {
  const { activeSlug } = useActiveOrg();
  const [label, setLabel] = useState(target.defaultLabel);
  const [plural, setPlural] = useState("");
  const [icon, setIcon] = useState("");
  const [hidden, setHidden] = useState(false);
  const [navOrder, setNavOrder] = useState<string>("");
  const [groupLabel, setGroupLabel] = useState("");
  const showGroupLabel = isModuleDefaultInstance(target.target_kind, target.target_id);
  const toast = useToast();

  const save = useMutation({
    mutationFn: () =>
      api.upsertOverride(activeSlug, {
        target_kind: target.target_kind,
        target_id: target.target_id,
        display_label: label.trim() || null,
        display_label_plural: plural.trim() || null,
        icon: icon.trim() || null,
        hidden,
        nav_order: navOrder === "" ? null : Number(navOrder),
        config: groupLabel.trim() ? { group_label: groupLabel.trim() } : {},
      }),
    onSuccess: () => {
      toast.success("Override saved.");
      onSaved();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  return (
    <Modal open onClose={onClose} title={`Edit "${target.defaultLabel}"`} size="md">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="space-y-3"
      >
        <PresentationFields
          label={label}
          setLabel={setLabel}
          plural={plural}
          setPlural={setPlural}
          icon={icon}
          setIcon={setIcon}
          hidden={hidden}
          setHidden={setHidden}
          navOrder={navOrder}
          setNavOrder={setNavOrder}
          groupLabel={groupLabel}
          setGroupLabel={setGroupLabel}
          showGroupLabel={showGroupLabel}
        />
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
            disabled={save.isPending}
            className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white"
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function PresentationEditModal({
  override,
  onClose,
  onSaved,
}: {
  override: EntityKindOverride;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { activeSlug } = useActiveOrg();
  const [label, setLabel] = useState(override.display_label ?? "");
  const [plural, setPlural] = useState(override.display_label_plural ?? "");
  const [icon, setIcon] = useState(override.icon ?? "");
  const [hidden, setHidden] = useState(override.hidden);
  const [navOrder, setNavOrder] = useState<string>(
    override.nav_order != null ? String(override.nav_order) : "",
  );
  const [groupLabel, setGroupLabel] = useState(
    (override.config?.group_label as string | undefined) ?? "",
  );
  const showGroupLabel = isModuleDefaultInstance(override.target_kind, override.target_id);
  const toast = useToast();

  const save = useMutation({
    mutationFn: () => {
      // Preserve any other config keys; only touch group_label.
      const config: Record<string, unknown> = { ...(override.config ?? {}) };
      const gl = groupLabel.trim();
      if (gl) config.group_label = gl;
      else delete config.group_label;
      return api.upsertOverride(activeSlug, {
        target_kind: override.target_kind,
        target_id: override.target_id,
        display_label: label.trim() || null,
        display_label_plural: plural.trim() || null,
        icon: icon.trim() || null,
        hidden,
        nav_order: navOrder === "" ? null : Number(navOrder),
        config,
      });
    },
    onSuccess: () => {
      toast.success("Override saved.");
      onSaved();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  return (
    <Modal open onClose={onClose} title={`Edit ${override.target_id}`} size="md">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="space-y-3"
      >
        <PresentationFields
          label={label}
          setLabel={setLabel}
          plural={plural}
          setPlural={setPlural}
          icon={icon}
          setIcon={setIcon}
          hidden={hidden}
          setHidden={setHidden}
          navOrder={navOrder}
          setNavOrder={setNavOrder}
          groupLabel={groupLabel}
          setGroupLabel={setGroupLabel}
          showGroupLabel={showGroupLabel}
        />
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
            disabled={save.isPending}
            className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white"
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** A module's default instance (the nav parent that owns the
 *  specialisations/instances dropdown) has target_id "<m>:<m>" — both
 *  halves equal. Only those rows show the specialisations-heading field. */
function isModuleDefaultInstance(targetKind: string, targetId: string): boolean {
  if (targetKind !== "instance") return false;
  const [mod, inst] = targetId.split(":");
  return !!mod && mod === inst;
}

function PresentationFields({
  label,
  setLabel,
  plural,
  setPlural,
  icon,
  setIcon,
  hidden,
  setHidden,
  navOrder,
  setNavOrder,
  groupLabel,
  setGroupLabel,
  showGroupLabel,
}: {
  label: string;
  setLabel: (v: string) => void;
  plural: string;
  setPlural: (v: string) => void;
  icon: string;
  setIcon: (v: string) => void;
  hidden: boolean;
  setHidden: (v: boolean) => void;
  navOrder: string;
  setNavOrder: (v: string) => void;
  groupLabel?: string;
  setGroupLabel?: (v: string) => void;
  showGroupLabel?: boolean;
}) {
  return (
    <>
      <label className="block">
        <span className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">
          Display label
        </span>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="(use manifest default)"
          className="w-full px-2 py-1 text-sm border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-900"
          autoFocus
        />
      </label>
      <label className="block">
        <span className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">
          Plural label (optional)
        </span>
        <input
          type="text"
          value={plural}
          onChange={(e) => setPlural(e.target.value)}
          className="w-full px-2 py-1 text-sm border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-900"
        />
      </label>
      {showGroupLabel && setGroupLabel && (
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">
            Specialisations heading (optional)
          </span>
          <input
            type="text"
            value={groupLabel ?? ""}
            onChange={(e) => setGroupLabel(e.target.value)}
            placeholder={`${(label || "module").toLowerCase()} specialisations`}
            className="w-full px-2 py-1 text-sm border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-900"
          />
          <span className="mt-1 block text-[11px] text-slate-400 dark:text-slate-500">
            The heading over this module's dropdown of lenses / instances
            in the nav. Defaults to "{(label || "module").toLowerCase()}{" "}
            specialisations".
          </span>
        </label>
      )}
      <label className="block">
        <span className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">
          Icon (lucide name, optional)
        </span>
        <input
          type="text"
          value={icon}
          onChange={(e) => setIcon(e.target.value)}
          placeholder="e.g. car, wrench, package"
          className="w-full px-2 py-1 text-sm border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-900"
        />
      </label>
      <label className="block">
        <span className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">
          Nav order (optional)
        </span>
        <input
          type="number"
          value={navOrder}
          onChange={(e) => setNavOrder(e.target.value)}
          placeholder="lower numbers come first"
          className="w-full px-2 py-1 text-sm border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-900"
        />
      </label>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={hidden}
          onChange={(e) => setHidden(e.target.checked)}
        />
        <span className="text-sm">Hide from nav</span>
      </label>
    </>
  );
}
