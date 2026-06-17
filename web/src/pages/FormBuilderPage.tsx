// /configuration/form-builder — visual form builder. Pick an entity kind, then
// drag its custom fields into order and under named SECTION headings. The list is
// one sortable column of items: section headers + field cards. A field's section
// is whichever header sits above it (fields above the first header are ungrouped).
// Save walks the list top→down, assigning each field its section + position and
// each section its order, via POST /field-defs/reorder. The grouped layout then
// shows on every create/edit form (CustomFieldsPanel renders by section).
//
// Single-container dnd-kit (verticalListSortingStrategy) — dragging a header
// moves a whole group; dragging a field re-homes + reorders it. Requested by
// Mary (visual drag-and-drop form designer).

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Trash2, FolderPlus, Loader2, Check } from "lucide-react";
import { api, ApiError, type FieldSection, type PlatformFieldDef } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useToast, usePageTitle } from "@cobblr/platform-web";

type Item =
  | { kind: "section"; id: string; name: string }
  | { kind: "field"; id: string; def: PlatformFieldDef };

function SortableRow({ item, children }: { item: Item; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      className={
        item.kind === "section"
          ? "flex items-center gap-2 rounded-lg bg-subtle dark:bg-slate-800/60 border border-line dark:border-slate-700 px-2 py-2 mt-3"
          : "flex items-center gap-2 rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-2 py-2 ml-5"
      }
    >
      <button {...attributes} {...listeners} className="cursor-grab text-faint hover:text-content dark:hover:text-mortar-100 touch-none" aria-label="Drag">
        <GripVertical size={16} />
      </button>
      {children}
    </div>
  );
}

export function FormBuilderPage() {
  usePageTitle("Form builder");
  const { activeSlug: slug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [kind, setKind] = useState<string>("");

  // All custom fields → the set of entity kinds to choose from.
  const allDefs = useQuery({
    queryKey: ["form-builder-kinds", slug],
    queryFn: () => api.listFieldDefs(slug),
    enabled: !!slug,
  });
  const kinds = useMemo(
    () => [...new Set((allDefs.data?.items ?? []).map((f) => f.entity_kind))].sort(),
    [allDefs.data],
  );
  useEffect(() => {
    if (!kind && kinds.length) setKind(kinds[0]!);
  }, [kinds, kind]);

  const defs = useQuery({
    queryKey: ["form-builder-defs", slug, kind],
    queryFn: () => api.listFieldDefs(slug, kind),
    enabled: !!slug && !!kind,
  });
  const sections = useQuery({
    queryKey: ["form-builder-sections", slug, kind],
    queryFn: () => api.listFieldSections(slug, kind),
    enabled: !!slug && !!kind,
  });

  // Build the flat ordered item list: ungrouped fields, then each section header
  // followed by its fields. Local working copy the user drags around.
  const [items, setItems] = useState<Item[]>([]);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!defs.data || !sections.data) return;
    const fields = defs.data.items.slice().sort((a, b) => a.position - b.position);
    const secs = (sections.data.items as FieldSection[]).slice().sort((a, b) => a.position - b.position);
    const next: Item[] = [];
    for (const f of fields.filter((f) => !f.section_id)) next.push({ kind: "field", id: `f:${f.name}`, def: f });
    for (const s of secs) {
      next.push({ kind: "section", id: `s:${s.id}`, name: s.name });
      for (const f of fields.filter((f) => f.section_id === s.id)) next.push({ kind: "field", id: `f:${f.name}`, def: f });
    }
    setItems(next);
    setDirty(false);
  }, [defs.data, sections.data]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    setItems((prev) => {
      const from = prev.findIndex((i) => i.id === active.id);
      const to = prev.findIndex((i) => i.id === over.id);
      if (from < 0 || to < 0) return prev;
      return arrayMove(prev, from, to);
    });
    setDirty(true);
  }

  const addSection = useMutation({
    mutationFn: () => api.createFieldSection(slug, { entity_kind: kind, name: "New section" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["form-builder-sections", slug, kind] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't add section"),
  });
  const renameSection = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.updateFieldSection(slug, id, { name }),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't rename"),
  });
  const deleteSection = useMutation({
    mutationFn: (id: string) => api.deleteFieldSection(slug, id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["form-builder-sections", slug, kind] });
      void qc.invalidateQueries({ queryKey: ["form-builder-defs", slug, kind] });
    },
  });

  const save = useMutation({
    mutationFn: () => {
      // Walk top→down: track current section; assign field section + position,
      // section order. Fields before the first header are ungrouped (null).
      let current: string | null = null;
      let fieldPos = 0;
      let secPos = 0;
      const fieldUpdates: Array<{ name: string; section_id: string | null; position: number }> = [];
      const secUpdates: Array<{ id: string; position: number }> = [];
      for (const it of items) {
        if (it.kind === "section") {
          current = it.id.slice(2);
          secUpdates.push({ id: current, position: secPos++ });
        } else {
          fieldUpdates.push({ name: it.def.name, section_id: current, position: fieldPos++ });
        }
      }
      return api.reorderFields(slug, { entity_kind: kind, sections: secUpdates, fields: fieldUpdates });
    },
    onSuccess: () => {
      setDirty(false);
      toast.success("Form layout saved.");
      void qc.invalidateQueries({ queryKey: ["form-builder-defs", slug, kind] });
      void qc.invalidateQueries({ queryKey: ["platform-field-defs", slug, kind] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't save"),
  });

  const btn = "inline-flex items-center gap-2 rounded-lg bg-cobble-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-cobble-700 disabled:opacity-50";
  const ghost = "inline-flex items-center gap-2 rounded-lg border border-line dark:border-slate-600 px-3 py-1.5 text-sm font-semibold text-content dark:text-mortar-100 hover:bg-subtle disabled:opacity-50";

  return (
    <div className="space-y-5 max-w-2xl">
      <div className="flex items-baseline gap-3 border-b border-line dark:border-slate-700 pb-3">
        <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 page-title">form builder</h1>
        <span className="page-subtitle">drag your fields into order and under sections</span>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-muted">
          Form for
          <select
            className="bg-transparent border border-line dark:border-slate-600 rounded px-2 py-1 text-content dark:text-mortar-100"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            {kinds.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <button className={ghost} onClick={() => addSection.mutate()} disabled={addSection.isPending || !kind}>
          <FolderPlus size={15} /> Add section
        </button>
        <div className="ml-auto">
          <button className={btn} onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
            {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Save layout
          </button>
        </div>
      </div>

      {kinds.length === 0 && !allDefs.isLoading && (
        <div className="text-sm text-faint italic">
          No custom fields yet. Add some in Configuration → Fields, then arrange them here.
        </div>
      )}

      {items.length > 0 && (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
            <div>
              {items.map((it) => (
                <SortableRow key={it.id} item={it}>
                  {it.kind === "section" ? (
                    <>
                      <input
                        defaultValue={it.name}
                        onBlur={(e) => {
                          const name = e.target.value.trim();
                          if (name && name !== it.name) renameSection.mutate({ id: it.id.slice(2), name });
                        }}
                        className="flex-1 bg-transparent font-semibold text-content dark:text-mortar-100 text-sm focus:outline-none border-b border-transparent focus:border-line"
                      />
                      <span className="text-[10px] font-mono uppercase tracking-widest text-faint">section</span>
                      <button
                        onClick={() => deleteSection.mutate(it.id.slice(2))}
                        className="text-faint hover:text-red-500 transition"
                        aria-label="Delete section"
                        title="Delete section (its fields become ungrouped)"
                      >
                        <Trash2 size={15} />
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="flex-1 text-sm text-content dark:text-mortar-100">{it.def.display_label}</span>
                      <span className="text-[10px] font-mono uppercase tracking-widest text-faint">{it.def.type}</span>
                    </>
                  )}
                </SortableRow>
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {items.length === 0 && kinds.length > 0 && !defs.isLoading && (
        <div className="text-sm text-faint italic">This kind has no custom fields to arrange yet.</div>
      )}

      <p className="text-xs text-faint dark:text-slate-500">
        Fields under a section heading are grouped under it on the form. Fields above the first heading are ungrouped (shown first).
        Add custom fields in <strong>Configuration → Fields</strong>.
      </p>
    </div>
  );
}
