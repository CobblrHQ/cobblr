// Header workspace chip + popover. Click the active workspace name
// to open a popover listing every org the user belongs to (active
// one checkmarked) plus a "Create new workspace" footer that
// launches the CreateWorkspaceModal.
//
// Your OWNED workspaces are drag-to-reorder (a per-user order persisted via
// PATCH /me/workspaces/order) and renamable (owner-only; display name is safe,
// the URL slug is an advanced/risky opt-in). Shared workspaces stay grouped
// below in their persisted order.

import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { Check, Star, ChevronDown, GripVertical, Pencil, Plus, Sliders, Users } from "lucide-react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ApiError, api, type OrgMembership } from "../lib/api";
import { useAuth } from "../auth/AuthContext";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { displaySlug, slugifyHandle } from "../lib/workspaceSlug";
import { Modal, useToast } from "@cobblr/platform-web";
import { MembersModal } from "./MembersModal";

export function WorkspaceSwitcher({ inline = false }: { inline?: boolean } = {}) {
  const { orgs, setOrgs, refreshMe } = useAuth();
  const { activeOrg, activeSlug, setActiveSlug } = useActiveOrg();
  const navigate = useNavigate();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [manageSlug, setManageSlug] = useState<string | null>(null);
  const [renameSlug, setRenameSlug] = useState<string | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // The menu is portaled to <body> so the header's `overflow-x-clip` (which
  // also clips vertically per spec) + backdrop-blur don't hide it. Positioned
  // with `fixed` from the button's rect.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Drag only after a 6px move so a plain click on a row still selects it.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  useLayoutEffect(() => {
    if (!open || inline) return;
    const place = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (r) {
        // Clamp so the 288px (w-72) menu stays on-screen on narrow phones.
        const left = Math.max(8, Math.min(r.left, window.innerWidth - 288 - 8));
        setPos({ top: r.bottom + 4, left });
      }
    };
    place();
    // Reposition on scroll/resize so it stays anchored to the button.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  // Close on outside click (button OR the portaled menu).
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  function pick(slug: string) {
    setActiveSlug(slug);
    setOpen(false);
  }

  // Star = the workspace a fresh device opens into. Optimistic (flip the flag
  // locally so the star updates instantly), then persist; refreshMe reconciles.
  const defaultMut = useMutation({
    mutationFn: (slug: string | null) => api.setDefaultWorkspace(slug),
    onSuccess: () => { void refreshMe(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't set the default"),
  });
  function toggleDefault(slug: string, isDefault: boolean) {
    setOrgs(orgs.map((o) => ({ ...o, is_default: o.slug === slug ? !isDefault : false })));
    defaultMut.mutate(isDefault ? null : slug);
  }

  function openCreate() {
    setOpen(false);
    setCreateOpen(true);
  }

  function handleCreated(slug: string) {
    setCreateOpen(false);
    // Navigate straight into the new workspace. We can't use setActiveSlug here:
    // it looks the slug up in useAuth().orgs, which hasn't refreshed with the
    // just-created workspace yet, so it silently no-ops and you're stranded on
    // the old workspace (the reported bug). The full slug resolves as a URL
    // handle on the fresh load, where auth re-fetches orgs incl. the new one.
    window.location.assign(`/w/${slug}/dashboard`);
  }

  const owned = orgs.filter((o) => o.role === "owner");
  const shared = orgs.filter((o) => o.role !== "owner");

  // Persist a new order for the OWNED group. We optimistically reorder locally,
  // then persist the full sequence (owned-then-shared) so positions are stable.
  async function persistOrder(nextOwned: OrgMembership[]) {
    const next = [...nextOwned, ...shared];
    setOrgs(next);
    try {
      await api.reorderWorkspaces(next.map((o) => o.slug));
    } catch {
      toast.error("Couldn't save the new order.");
      await refreshMe(); // revert to the server's truth
    }
  }

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = owned.findIndex((o) => o.slug === active.id);
    const to = owned.findIndex((o) => o.slug === over.id);
    if (from < 0 || to < 0) return;
    void persistOrder(arrayMove(owned, from, to));
  }

  const header = (label: string, border: boolean) => (
    <li
      className={
        "px-3 pt-2 pb-1 text-[9px] font-mono uppercase tracking-widest text-muted dark:text-slate-500 " +
        (border ? "border-t border-line dark:border-slate-800 mt-1" : "")
      }
    >
      {label}
    </li>
  );

  // min-w-0 here AND on the button so the name actually truncates to the space
  // left after the icons — otherwise on a narrow (mobile) header the full
  // workspace name renders and the action icons overlap it.
  return (
    <div className="relative min-w-0">
      <button
        ref={btnRef}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 px-2 py-1 rounded text-sm text-content dark:text-mortar-100 hover:bg-subtle dark:hover:bg-slate-800 transition min-w-0 max-w-full"
        title={activeOrg ? `${activeOrg.name} · ${displaySlug(activeOrg.slug)}` : "Pick a workspace"}
      >
        {/* No hard max-width: show the full workspace name when the row has room.
            The flex min-w-0 above still truncates it FIRST (protecting the icons)
            only when the header genuinely runs out of space. */}
        <span className="truncate">{activeOrg?.name ?? "—"}</span>
        <ChevronDown size={12} className="text-faint shrink-0" />
      </button>
      {open && inline && (
        // Sidebar accordion ("no dropdowns in the sidebar"): the same body,
        // in-flow under the workspace row. Drag-reorder + manage/rename all
        // work identically — only the container changed. menuRef keeps the
        // click-outside handler from eating clicks INSIDE the accordion
        // (mousedown-close would fire before a row's onClick and swallow it).
        <div ref={menuRef} className="border-b border-line dark:border-slate-800 max-h-[50vh] overflow-y-auto">
          <ul className="max-h-80 overflow-y-auto">
            {owned.length > 0 && header("your workspaces", false)}
            {owned.length > 0 && (
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                <SortableContext items={owned.map((o) => o.slug)} strategy={verticalListSortingStrategy}>
                  {owned.map((o) => (
                    <SortableRow
                      key={o.id}
                      org={o}
                      active={o.slug === activeSlug}
                      onPick={() => pick(o.slug)}
                      onManage={() => { setOpen(false); setManageSlug(o.slug); }}
                      onRename={() => { setOpen(false); setRenameSlug(o.slug); }}
                      onSetDefault={() => toggleDefault(o.slug, !!o.is_default)}
                    />
                  ))}
                </SortableContext>
              </DndContext>
            )}
            {shared.length > 0 && header("shared with you", owned.length > 0)}
            {shared.map((o) => (
              <WorkspaceRow
                key={o.id}
                org={o}
                active={o.slug === activeSlug}
                onPick={() => pick(o.slug)}
                onManage={o.role === "admin" ? () => { setOpen(false); setManageSlug(o.slug); } : undefined}
                onSetDefault={() => toggleDefault(o.slug, !!o.is_default)}
              />
            ))}
          </ul>
          {/* Workspace-level actions live HERE, not as a dashboard bar — the old
              identity header spent the dashboard's top row repeating what this
              switcher already says. */}
          <button
            onClick={() => { setOpen(false); navigate("/configuration"); }}
            className="w-full text-left px-3 py-2 border-t border-line dark:border-slate-700 hover:bg-subtle dark:hover:bg-slate-800 transition flex items-center gap-2 text-sm text-content dark:text-mortar-200"
            title="Turn on modules, install a starter pack, customize this workspace"
          >
            <Sliders size={13} className="text-accent" />
            Customize workspace
          </button>
          <button
            onClick={openCreate}
            className="w-full text-left px-3 py-2 border-t border-line dark:border-slate-700 hover:bg-subtle dark:hover:bg-slate-800 transition flex items-center gap-2 text-sm text-accent dark:text-cobble-300"
          >
            <Plus size={13} />
            Create new workspace
          </button>
        </div>
      )}
      {open && !inline && pos && createPortal(
        <div
          ref={menuRef}
          style={{ position: "fixed", top: pos.top, left: pos.left }}
          className="w-72 max-w-[calc(100vw-1rem)] rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 shadow-lg z-[100] overflow-hidden"
        >
          <ul className="max-h-80 overflow-y-auto">
            {owned.length > 0 && header("your workspaces", false)}
            {owned.length > 0 && (
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                <SortableContext items={owned.map((o) => o.slug)} strategy={verticalListSortingStrategy}>
                  {owned.map((o) => (
                    <SortableRow
                      key={o.id}
                      org={o}
                      active={o.slug === activeSlug}
                      onPick={() => pick(o.slug)}
                      onManage={() => { setOpen(false); setManageSlug(o.slug); }}
                      onRename={() => { setOpen(false); setRenameSlug(o.slug); }}
                      onSetDefault={() => toggleDefault(o.slug, !!o.is_default)}
                    />
                  ))}
                </SortableContext>
              </DndContext>
            )}
            {shared.length > 0 && header("shared with you", owned.length > 0)}
            {shared.map((o) => (
              <WorkspaceRow
                key={o.id}
                org={o}
                active={o.slug === activeSlug}
                onPick={() => pick(o.slug)}
                onManage={o.role === "admin" ? () => { setOpen(false); setManageSlug(o.slug); } : undefined}
                onSetDefault={() => toggleDefault(o.slug, !!o.is_default)}
              />
            ))}
          </ul>
          {/* Workspace-level actions live HERE, not as a dashboard bar — the old
              identity header spent the dashboard's top row repeating what this
              switcher already says. */}
          <button
            onClick={() => { setOpen(false); navigate("/configuration"); }}
            className="w-full text-left px-3 py-2 border-t border-line dark:border-slate-700 hover:bg-subtle dark:hover:bg-slate-800 transition flex items-center gap-2 text-sm text-content dark:text-mortar-200"
            title="Turn on modules, install a starter pack, customize this workspace"
          >
            <Sliders size={13} className="text-accent" />
            Customize workspace
          </button>
          <button
            onClick={openCreate}
            className="w-full text-left px-3 py-2 border-t border-line dark:border-slate-700 hover:bg-subtle dark:hover:bg-slate-800 transition flex items-center gap-2 text-sm text-accent dark:text-cobble-300"
          >
            <Plus size={13} />
            Create new workspace
          </button>
        </div>,
        document.body,
      )}
      <CreateWorkspaceModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={handleCreated}
      />
      <MembersModal
        open={!!manageSlug}
        onClose={() => setManageSlug(null)}
        slug={manageSlug ?? ""}
      />
      <RenameWorkspaceModal
        open={!!renameSlug}
        org={orgs.find((o) => o.slug === renameSlug) ?? null}
        isActive={renameSlug === activeSlug}
        onClose={() => setRenameSlug(null)}
      />
    </div>
  );
}

/** One workspace row. `dragHandle` is supplied by SortableRow for owned rows. */
function WorkspaceRow({
  org: o,
  active,
  onPick,
  onManage,
  onRename,
  onSetDefault,
  dragHandle,
}: {
  org: OrgMembership;
  active: boolean;
  onPick: () => void;
  onManage?: () => void;
  onRename?: () => void;
  onSetDefault?: () => void;
  dragHandle?: React.ReactNode;
}) {
  return (
    <li className="group flex items-stretch hover:bg-subtle dark:hover:bg-slate-800 transition">
      {dragHandle}
      <button onClick={onPick} className="flex-1 text-left px-3 py-2 flex items-center gap-2 min-w-0">
        <Check size={12} className={active ? "text-accent dark:text-cobble-300" : "text-transparent"} />
        <div className="flex-1 min-w-0">
          <div className="text-sm text-content dark:text-mortar-100 truncate flex items-center gap-1.5">
            <span className="truncate">{o.name}</span>
            {/* On a workspace you don't own, your role is the key signal. */}
            {o.role !== "owner" && (
              <span className="shrink-0 text-[9px] font-mono uppercase tracking-wide px-1 py-0.5 rounded bg-cobble-50 dark:bg-cobble-900/30 text-accent dark:text-cobble-300">
                {o.role}
              </span>
            )}
          </div>
          <div className="text-[10px] font-mono text-faint dark:text-slate-500 truncate">
            {o.role !== "owner" && o.owner_name ? `owner: ${o.owner_name} · ` : ""}
            {displaySlug(o.slug)}
          </div>
        </div>
      </button>
      {/* The DEFAULT star stays visible at rest — it's a meaningful indicator. */}
      {onSetDefault && o.is_default && (
        <button
          onClick={(e) => { e.stopPropagation(); onSetDefault(); }}
          className="px-2 shrink-0 text-accent dark:text-cobble-300 transition"
          title="Default workspace — opens on a fresh device. Click to unset."
          aria-label="Unset default workspace"
        >
          <Star size={13} className="fill-current" />
        </button>
      )}
      {/* Reveal-on-hover actions collapse to zero WIDTH at rest (not just
          opacity-0) so they never steal room from the workspace name — in the
          narrow full-sidebar (w-56) an always-laid-out button cluster crushed
          names to a single letter (feedback: "names cut off in full sidebar"). */}
      <div className="flex items-stretch shrink-0 w-0 overflow-hidden opacity-0 transition-[width,opacity] group-hover:w-auto group-hover:opacity-100 group-focus-within:w-auto group-focus-within:opacity-100">
        {onSetDefault && !o.is_default && (
          <button
            onClick={(e) => { e.stopPropagation(); onSetDefault(); }}
            className="px-2 text-faint dark:text-slate-500 hover:text-accent dark:hover:text-cobble-300 transition"
            title={`Make ${o.name} the default a fresh device opens into`}
            aria-label="Set as default workspace"
          >
            <Star size={13} />
          </button>
        )}
        {onRename && (
          <button
            onClick={(e) => { e.stopPropagation(); onRename(); }}
            className="px-2 text-faint dark:text-slate-500 hover:text-accent dark:hover:text-cobble-300 transition"
            title={`Rename ${o.name}`}
          >
            <Pencil size={13} />
          </button>
        )}
        {onManage && (
          <button
            onClick={(e) => { e.stopPropagation(); onManage(); }}
            className="px-3 text-faint dark:text-slate-500 hover:text-accent dark:hover:text-cobble-300 transition"
            title={`Manage members + invites for ${o.name}`}
          >
            <Users size={13} />
          </button>
        )}
      </div>
    </li>
  );
}

/** An owned row wrapped for drag-to-reorder (grip handle on the left). */
function SortableRow(props: {
  org: OrgMembership;
  active: boolean;
  onPick: () => void;
  onManage: () => void;
  onRename: () => void;
  onSetDefault: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: props.org.slug });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : 1 }}>
      <WorkspaceRow
        {...props}
        onManage={props.org.role === "owner" || props.org.role === "admin" ? props.onManage : undefined}
        dragHandle={
          <button
            type="button"
            {...attributes}
            {...listeners}
            className="px-1.5 flex items-center text-faint dark:text-slate-600 hover:text-muted dark:hover:text-slate-400 cursor-grab active:cursor-grabbing touch-none"
            title="Drag to reorder"
            aria-label="Drag to reorder"
          >
            <GripVertical size={13} />
          </button>
        }
      />
    </div>
  );
}

/** Owner-only rename. Display name is the safe, recommended path; changing the
 *  URL slug is an explicit "advanced" opt-in (it breaks existing links). */
export function RenameWorkspaceModal({
  open,
  org,
  isActive,
  onClose,
}: {
  open: boolean;
  org: OrgMembership | null;
  isActive: boolean;
  onClose: () => void;
}) {
  const { refreshMe } = useAuth();
  const toast = useToast();
  const [name, setName] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [slug, setSlug] = useState("");
  // While false, the handle tracks the name (auto-suggested). Once the user
  // edits the handle directly, it stops following so we don't clobber their
  // choice. A bare rename never saves the suggested handle anyway — the slug is
  // only persisted when Advanced is expanded (see the rename mutation).
  const [slugTouched, setSlugTouched] = useState(false);

  useEffect(() => {
    if (open && org) {
      setName(org.name);
      setSlug(displaySlug(org.slug));
      setAdvanced(false);
      setSlugTouched(false);
    }
  }, [open, org]);

  const rename = useMutation({
    mutationFn: () => {
      const body: { name?: string; slug?: string } = {};
      if (org && name.trim() && name.trim() !== org.name) body.name = name.trim();
      if (org && advanced && slug.trim() && slug.trim() !== displaySlug(org.slug)) body.slug = slug.trim();
      return api.renameOrg(org!.slug, body);
    },
    onSuccess: async (r) => {
      toast.success("Workspace renamed.");
      onClose();
      // If the slug changed for the workspace we're currently in, the URL
      // basename is now stale — hard-navigate to the new one. Otherwise just
      // refresh the orgs list so the new name shows in the switcher.
      if (org && r.slug !== org.slug && isActive) {
        window.location.assign(`/w/${r.slug}/dashboard`);
      } else {
        await refreshMe();
      }
    },
    onError: (e: unknown) => {
      toast.error(e instanceof ApiError ? e.message : "Couldn't rename the workspace.");
    },
  });

  const slugChanged = !!org && advanced && slug.trim() !== "" && slug.trim() !== displaySlug(org.slug);
  const nameChanged = !!org && name.trim() !== "" && name.trim() !== org.name;
  const canSave = !!org && (nameChanged || slugChanged) && !rename.isPending;
  // A handle the current name would produce, offered as a one-tap fill when it
  // differs from what's in the field (e.g. the slug was auto-generated from a
  // username at signup and no longer matches a renamed workspace).
  const slugSuggestion = slugifyHandle(name);
  const showSlugSuggestion = slugSuggestion !== "" && slugSuggestion !== slug.trim();

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    rename.mutate();
  }

  return (
    <Modal open={open} onClose={onClose} title="Rename workspace" size="sm">
      <form onSubmit={submit} className="space-y-4">
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
            Workspace name
          </span>
          <input
            value={name}
            onChange={(e) => {
              const v = e.target.value;
              setName(v);
              if (!slugTouched) setSlug(slugifyHandle(v));
            }}
            className="input"
            autoFocus
            maxLength={120}
          />
          <span className="mt-1 block text-[11px] text-muted dark:text-slate-400">
            Safe to change anytime — only the display name updates. Links keep working.
          </span>
        </label>

        {!advanced ? (
          <button
            type="button"
            onClick={() => setAdvanced(true)}
            className="text-[11px] text-faint dark:text-slate-500 hover:text-accent transition"
          >
            Advanced — change the URL too →
          </button>
        ) : (
          <label className="block">
            <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
              URL handle
            </span>
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-mono text-faint dark:text-slate-500 shrink-0">/w/</span>
              <input
                value={slug}
                onChange={(e) => {
                  setSlug(e.target.value);
                  setSlugTouched(true);
                }}
                className="input font-mono"
                maxLength={60}
                placeholder="my-workspace"
              />
            </div>
            {showSlugSuggestion && (
              <button
                type="button"
                onClick={() => {
                  setSlug(slugSuggestion);
                  setSlugTouched(true);
                }}
                className="mt-1 text-[11px] text-accent hover:underline"
              >
                Suggest from name: /w/{slugSuggestion}
              </button>
            )}
            <span className="mt-1 block text-[11px] text-ember-600 dark:text-ember-400">
              ⚠ Risky — every existing bookmark, shared link, and API token that
              uses the old URL will break. Only change this if you know what you're doing.
            </span>
          </label>
        )}

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-line dark:border-slate-700">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-sm font-medium text-content dark:text-slate-300 hover:bg-subtle dark:hover:bg-slate-800 transition"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSave}
            className="px-3 py-1.5 rounded-md text-sm font-medium bg-slate-700 hover:bg-slate-600 text-mortar-50 transition disabled:opacity-50"
          >
            {rename.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function CreateWorkspaceModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (slug: string) => void;
}) {
  const [name, setName] = useState("");
  // "A friend sent me their setup" — an exported blueprint file seeds the new
  // workspace's whole configuration (modules, trackers, fields, views).
  const [blueprint, setBlueprint] = useState<{ manifest: unknown; label: string } | null>(null);
  const [bpError, setBpError] = useState<string | null>(null);
  const toast = useToast();

  // Reset the form whenever the modal re-opens.
  useEffect(() => {
    if (open) {
      setName("");
      setBlueprint(null);
      setBpError(null);
    }
  }, [open]);

  const create = useMutation({
    mutationFn: () => api.createOrg(name.trim(), blueprint ? { blueprint: blueprint.manifest } : undefined),
    onSuccess: (r) => {
      toast.success(
        r.blueprint_applied
          ? `Workspace "${r.org.name}" created from "${r.blueprint_applied.name}".`
          : `Workspace "${r.org.name}" created.`,
      );
      onCreated(r.slug);
    },
    onError: (e: unknown) => {
      toast.error(e instanceof ApiError ? e.message : "Couldn't create workspace.");
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    create.mutate();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New workspace"
      subtitle="separate tenant DB · separate data · same login"
      size="sm"
    >
      <form onSubmit={submit} className="space-y-4">
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
            Workspace name
          </span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Lego hoard"
            className="input"
            autoFocus
            maxLength={120}
          />
        </label>
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
            Start from a blueprint (optional)
          </span>
          <input
            type="file"
            accept="application/json,.json"
            onChange={(e) => {
              setBpError(null);
              setBlueprint(null);
              const f = e.target.files?.[0];
              if (!f) return;
              void f.text().then((txt) => {
                try {
                  const manifest = JSON.parse(txt) as { name?: unknown };
                  setBlueprint({ manifest, label: typeof manifest.name === "string" ? manifest.name : f.name });
                  if (!name.trim() && typeof manifest.name === "string") setName(manifest.name.slice(0, 120));
                } catch {
                  setBpError("That file isn't valid JSON — export a blueprint from Settings → Blueprint.");
                }
              });
            }}
            className="block w-full text-xs text-muted dark:text-slate-400 file:mr-2 file:rounded file:border-0 file:bg-subtle dark:file:bg-slate-800 file:px-2 file:py-1 file:text-xs file:text-content dark:file:text-mortar-200"
          />
          {blueprint && (
            <span className="mt-1 block text-[11px] text-moss-700 dark:text-moss-300">
              Will be set up from “{blueprint.label}” — a friend's exported setup works here (config only, no data).
            </span>
          )}
          {bpError && <span className="mt-1 block text-[11px] text-ember-600 dark:text-ember-300">{bpError}</span>}
        </label>
        <p className="text-xs text-muted dark:text-slate-400">
          Cobblr will provision a fresh tenant Postgres database, enable
          all installed modules, and seed default wires. Inventory in
          this workspace is invisible to your other workspaces.
        </p>
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-line dark:border-slate-700">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-sm font-medium text-content dark:text-slate-300 hover:bg-subtle dark:hover:bg-slate-800 transition"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!name.trim() || create.isPending}
            className="px-3 py-1.5 rounded-md text-sm font-medium bg-slate-700 hover:bg-slate-600 text-mortar-50 transition disabled:opacity-50"
          >
            {create.isPending ? "Creating…" : "Create workspace"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
