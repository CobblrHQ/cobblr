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
import { ArrowLeft, Eye, EyeOff, Pencil, RotateCcw, SlidersHorizontal } from "lucide-react";
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
  const [fieldsFor, setFieldsFor] = useState<{ entityKind: string; label: string } | null>(null);
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
          className="text-[10px] font-mono uppercase tracking-widest text-faint hover:text-accent transition inline-flex items-center gap-1"
        >
          <ArrowLeft size={10} /> back to configuration
        </Link>
      </div>
      <div className="flex items-baseline gap-3 border-b border-line dark:border-slate-700 pb-3">
        <h1 className="text-2xl font-semibold text-content dark:text-mortar-100">
          Presentation
        </h1>
        <span className="text-sm text-muted dark:text-slate-400">
          {rows.length} things in your workspace
        </span>
      </div>

      <p className="text-sm text-content dark:text-mortar-200">
        Customise how every top-level thing in your workspace renders —
        rename it, swap its icon, hide it from the nav, change its order.
        Workspace edits override module / bundle defaults; reinstalling
        a bundle doesn't clobber your edits.
      </p>

      <HeadingsBuilder />

      <div className="border-t border-line dark:border-slate-700 pt-3">
        <div className="text-[10px] font-mono uppercase tracking-widest text-accent mb-1">
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
            onFields={(() => {
              // The entity kind whose native fields this row's form renders:
              // a kind row IS that kind; an instance row resolves to its
              // module's primary kind (what the default form uses).
              const kind =
                row.target_kind === "entity_kind"
                  ? row.target_id
                  : (kinds.data?.items.find((k) => k.module_name === row.moduleName)?.id ?? null);
              return kind ? () => setFieldsFor({ entityKind: kind, label: row.defaultLabel }) : undefined;
            })()}
          />
        ))}
      </div>
      {fieldsFor && (
        <FieldsEditorModal
          entityKind={fieldsFor.entityKind}
          title={fieldsFor.label}
          onClose={() => setFieldsFor(null)}
        />
      )}

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
  onFields,
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
  onFields?: () => void;
}) {
  const o = row.override;
  const label = o?.display_label ?? row.defaultLabel;
  const hidden = o?.hidden ?? false;
  const navOrder = o?.nav_order;
  return (
    <div
      className={
        "rounded border bg-surface dark:bg-slate-900 px-3 py-2 flex items-center gap-3 " +
        (hidden ? "border-line dark:border-slate-700 opacity-60" : "border-line dark:border-slate-700")
      }
    >
      <span
        className={
          "shrink-0 text-[10px] font-mono uppercase tracking-widest " +
          (row.target_kind === "instance" ? "text-accent" : "text-faint")
        }
      >
        {row.target_kind === "instance" ? "instance" : "kind"}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-content dark:text-mortar-100 truncate">
          {label}
          {o?.display_label && o.display_label !== row.defaultLabel && (
            <span className="ml-2 text-[10px] font-mono text-faint">
              (default: {row.defaultLabel})
            </span>
          )}
        </div>
        <div className="text-[10px] font-mono text-faint truncate">
          {row.target_id}
        </div>
      </div>
      {navOrder != null && (
        <span className="text-[10px] font-mono text-faint">order:{navOrder}</span>
      )}
      {hidden && <EyeOff size={14} className="text-faint" />}
      {!hidden && <Eye size={14} className="text-faint" />}
      {onFields && (
        <button
          type="button"
          onClick={onFields}
          title="Fields — relabel / show-hide this thing's fields"
          className="text-faint hover:text-accent transition p-1"
        >
          <SlidersHorizontal size={14} />
        </button>
      )}
      <button
        type="button"
        onClick={onEdit}
        title="Edit"
        className="text-faint hover:text-accent transition p-1"
      >
        <Pencil size={14} />
      </button>
      {o && (
        <button
          type="button"
          onClick={onReset}
          title="Reset to manifest default"
          className="text-faint hover:text-ember-500 transition p-1"
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
  const [nestUnderModule, setNestUnderModule] = useState(false);
  const showGroupLabel = isModuleDefaultInstance(target.target_kind, target.target_id);
  const showNestToggle = target.target_kind === "instance" && !showGroupLabel;
  const moduleName = target.target_id.split(":")[0];
  const toast = useToast();

  const save = useMutation({
    mutationFn: () => {
      const config: Record<string, unknown> = {};
      if (groupLabel.trim()) config.group_label = groupLabel.trim();
      if (nestUnderModule) config.presents_as_top_level = false;
      return api.upsertOverride(activeSlug, {
        target_kind: target.target_kind,
        target_id: target.target_id,
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
          nestUnderModule={nestUnderModule}
          setNestUnderModule={setNestUnderModule}
          showNestToggle={showNestToggle}
          moduleName={moduleName}
        />
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800"
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
  const [nestUnderModule, setNestUnderModule] = useState(
    override.config?.presents_as_top_level === false,
  );
  const showGroupLabel = isModuleDefaultInstance(override.target_kind, override.target_id);
  const showNestToggle = override.target_kind === "instance" && !showGroupLabel;
  const moduleName = override.target_id.split(":")[0];
  const toast = useToast();

  const save = useMutation({
    mutationFn: () => {
      // Preserve any other config keys; only touch the ones this form owns.
      const config: Record<string, unknown> = { ...(override.config ?? {}) };
      const gl = groupLabel.trim();
      if (gl) config.group_label = gl;
      else delete config.group_label;
      if (nestUnderModule) config.presents_as_top_level = false;
      else delete config.presents_as_top_level;
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
          nestUnderModule={nestUnderModule}
          setNestUnderModule={setNestUnderModule}
          showNestToggle={showNestToggle}
          moduleName={moduleName}
        />
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800"
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
  nestUnderModule,
  setNestUnderModule,
  showNestToggle,
  moduleName,
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
  nestUnderModule?: boolean;
  setNestUnderModule?: (v: boolean) => void;
  showNestToggle?: boolean;
  moduleName?: string;
}) {
  return (
    <>
      <label className="block">
        <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
          Display label
        </span>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="(use manifest default)"
          className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
          autoFocus
        />
      </label>
      <label className="block">
        <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
          Plural label (optional)
        </span>
        <input
          type="text"
          value={plural}
          onChange={(e) => setPlural(e.target.value)}
          className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
        />
      </label>
      {showGroupLabel && setGroupLabel && (
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
            Specialisations heading (optional)
          </span>
          <input
            type="text"
            value={groupLabel ?? ""}
            onChange={(e) => setGroupLabel(e.target.value)}
            placeholder={`${(label || "module").toLowerCase()} specialisations`}
            className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
          />
          <span className="mt-1 block text-[11px] text-faint dark:text-slate-500">
            The heading over this module's dropdown of lenses / instances
            in the nav. Defaults to "{(label || "module").toLowerCase()}{" "}
            specialisations".
          </span>
        </label>
      )}
      <label className="block">
        <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
          Icon (lucide name, optional)
        </span>
        <input
          type="text"
          value={icon}
          onChange={(e) => setIcon(e.target.value)}
          placeholder="e.g. car, wrench, package"
          className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
        />
      </label>
      <label className="block">
        <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
          Nav order (optional)
        </span>
        <input
          type="number"
          value={navOrder}
          onChange={(e) => setNavOrder(e.target.value)}
          placeholder="lower numbers come first"
          className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
        />
      </label>
      {showNestToggle && setNestUnderModule && (
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={nestUnderModule ?? false}
            onChange={(e) => setNestUnderModule(e.target.checked)}
          />
          <span className="text-sm">
            Nest under <span className="font-medium">{moduleName ?? "its module"}</span>
            <span className="mt-0.5 block text-[11px] text-faint dark:text-slate-500">
              Off (default): shows as its own top-level nav heading. On: becomes a
              dropdown item under {moduleName ?? "its module"} — the "types of {moduleName ?? "thing"}" shape.
            </span>
          </span>
        </label>
      )}
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

// Per-kind field editor: relabel + show/hide a thing's NATIVE fields. Lists the
// fields the module declares (from the entity-kind registry) and writes
// native_field_overrides; the module's form reads them via useFieldPresentation.
function FieldsEditorModal({ entityKind, title, onClose }: { entityKind: string; title: string; onClose: () => void }) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const kinds = useQuery({
    queryKey: ["entity-kinds", activeSlug],
    queryFn: () => api.listEntityKinds(activeSlug),
    enabled: !!activeSlug,
  });
  const overrides = useQuery({
    queryKey: ["native-field-overrides", activeSlug, entityKind],
    queryFn: () => api.listNativeFieldOverrides(activeSlug, entityKind),
    enabled: !!activeSlug,
  });
  const fields = (kinds.data?.items.find((k) => k.id === entityKind)?.fields ?? []).filter(
    (f) => f.name !== "metadata",
  );
  const byName = new Map((overrides.data?.items ?? []).map((o) => [o.name, o]));
  const invalidate = () =>
    void qc.invalidateQueries({ queryKey: ["native-field-overrides", activeSlug, entityKind] });
  const save = useMutation({
    mutationFn: (b: { name: string; display_label?: string | null; hidden?: boolean }) =>
      api.putNativeFieldOverride(activeSlug, { entity_kind: entityKind, ...b }),
    onSuccess: invalidate,
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const reset = useMutation({
    mutationFn: (name: string) => api.deleteNativeFieldOverride(activeSlug, entityKind, name),
    onSuccess: invalidate,
  });
  return (
    <Modal open onClose={onClose} title={`Fields — ${title}`} size="md">
      <p className="text-sm text-muted mb-3">
        Rename or hide each native field on this thing's form — un-clutter the modal, speak your own
        language. (Custom fields added by bundles are managed where they're defined.)
      </p>
      <div className="space-y-1 max-h-[60vh] overflow-auto">
        {fields.map((f) => {
          const o = byName.get(f.name);
          const hidden = o?.hidden ?? false;
          return (
            <div
              key={f.name}
              className={
                "flex items-center gap-2 rounded border border-line dark:border-slate-700 px-2 py-1.5 " +
                (hidden ? "opacity-50" : "")
              }
            >
              <span className="w-32 shrink-0 text-[10px] font-mono text-faint truncate" title={f.name}>
                {f.name}
              </span>
              <input
                defaultValue={o?.display_label ?? ""}
                placeholder={f.name}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v !== (o?.display_label ?? "")) save.mutate({ name: f.name, display_label: v || null, hidden });
                }}
                className="flex-1 px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
              />
              <button
                type="button"
                title={hidden ? "Show on the form" : "Hide from the form"}
                onClick={() => save.mutate({ name: f.name, display_label: o?.display_label ?? null, hidden: !hidden })}
                className="text-faint hover:text-accent p-1"
              >
                {hidden ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
              {o && (
                <button type="button" title="Reset to default" onClick={() => reset.mutate(f.name)} className="text-faint hover:text-ember-500 p-1">
                  <RotateCcw size={13} />
                </button>
              )}
            </div>
          );
        })}
        {fields.length === 0 && <div className="text-sm text-muted italic">This kind declares no editable native fields.</div>}
      </div>
    </Modal>
  );
}
