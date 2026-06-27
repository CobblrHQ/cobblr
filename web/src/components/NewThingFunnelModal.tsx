// The "+ New thing" funnel. Single user-facing entry point for both
// lens-promotion and module-instance creation. Asks one question in
// human language; the system picks the right primitive under the
// hood.
//
// v0.1 ships the instance path only (lens creation requires
// lens-promotion's bundle build which lands next). When the user
// picks "sub-category" the modal explains that's a future capability
// and points them at bundle install for now.

import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Boxes } from "lucide-react";
import { Modal, useToast } from "@cobblr/platform-web";
import { ApiError, api, type OrgModuleListItem } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

type Step = "choose-shape" | "instance-pick-module" | "instance-name";

// Where the new instance shows up in the navbar.
//   "standalone" → its own top-level entry (the default; preserves the
//                  specialisations-as-top-level decision, e.g. 3D Printers).
//   "menu"       → folded into a navbar dropdown (a nav heading), so a
//                  workspace adding many categories of one kind (Pantry,
//                  Cleaning, Tools, … under "Inventory") gets ONE tidy menu
//                  instead of N sprawling top-level entries.
type Placement = "standalone" | "menu";
const NEW_MENU = "__new__";

export function NewThingFunnelModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [step, setStep] = useState<Step>("choose-shape");
  const [pickedModule, setPickedModule] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  // Navbar placement (resolved smartly when a module is picked, below).
  const [placement, setPlacement] = useState<Placement>("standalone");
  const [menuId, setMenuId] = useState<string>(NEW_MENU); // heading id or NEW_MENU
  const [newMenuName, setNewMenuName] = useState("");

  const modules = useQuery({
    queryKey: ["org-modules", activeSlug],
    queryFn: () => api.orgModules(activeSlug),
    enabled: !!activeSlug && open,
  });
  // Existing navbar menus + instances drive the smart placement default.
  const headings = useQuery({
    queryKey: ["nav-headings", activeSlug],
    queryFn: () => api.listNavHeadings(activeSlug),
    enabled: !!activeSlug && open,
  });
  const instances = useQuery({
    queryKey: ["instances", activeSlug],
    queryFn: () => api.listInstances(activeSlug),
    enabled: !!activeSlug && open,
  });

  // Pick a module → step forward AND resolve the navbar-placement default.
  // The rule that makes "add many categories" seamless WITHOUT changing the
  // top-level behaviour for the first one: if a navbar menu already holds an
  // instance of this same module ("sibling heading"), default the new one INTO
  // that menu. So the 2nd…Nth Inventory category auto-joins the "Inventory"
  // menu the 1st one created — no re-choosing — while a lone first instance (or
  // a Machines workspace that wants 3D Printers / Laser Cutters top-level) stays
  // standalone by default.
  function pickModule(name: string, moduleDisplay: string) {
    setPickedModule(name);
    const named = (instances.data?.items ?? []).filter(
      (i) => i.module_name === name && !i.is_default,
    );
    const siblingHeading = (headings.data?.items ?? []).find((h) =>
      h.members.some(
        (m) =>
          m.target_kind === "instance" &&
          named.some((i) => i.instance_name === m.target_id),
      ),
    );
    if (siblingHeading) {
      setPlacement("menu");
      setMenuId(siblingHeading.id);
    } else {
      setPlacement("standalone");
      setMenuId(NEW_MENU);
    }
    setNewMenuName(moduleDisplay); // sensible prefill: a menu named after the kind
    setStep("instance-name");
  }
  // Only multi-instance modules show in the picker — read from the manifest's
  // `instanceability` field (now on the /orgs/:slug/modules response), so a new
  // multi-instance module appears automatically and the funnel can't drift from
  // the real set. (Audit 2026-06-26 follow-up — was a hardcoded allowlist that
  // had already missed `sales`.)
  const candidates = (modules.data?.items ?? []).filter(
    (m) => m.instanceability === "multi",
  );

  const create = useMutation({
    mutationFn: async () => {
      if (!pickedModule) throw new Error("module not picked");
      const slug = slugify(displayName);
      const inst = await api.createInstance(activeSlug, {
        module_name: pickedModule,
        instance_name: slug,
        display_name: displayName.trim(),
      });
      // Fold it into a navbar menu (heading) when asked — creating the menu
      // first if it's new. This is the seam that makes "add categories → see
      // them in one dropdown" a single flow instead of a trip to Configuration.
      if (placement === "menu") {
        let headingId = menuId;
        if (menuId === NEW_MENU) {
          const name = newMenuName.trim() || (pickedModule ?? "Menu");
          headingId = (await api.createNavHeading(activeSlug, { name })).id;
        }
        await api.addNavHeadingMember(activeSlug, headingId, {
          target_kind: "instance",
          target_id: slug,
        });
      }
      return inst;
    },
    onSuccess: (inst) => {
      toast.success(
        placement === "menu"
          ? `Created '${inst.display_name}' in the navbar menu.`
          : `Created '${inst.display_name}'.`,
      );
      void qc.invalidateQueries({ queryKey: ["instances", activeSlug] });
      void qc.invalidateQueries({ queryKey: ["entity-kind-overrides", activeSlug] });
      void qc.invalidateQueries({ queryKey: ["nav-headings", activeSlug] });
      reset();
      onClose();
    },
    onError: (e: unknown) => {
      toast.error(e instanceof ApiError ? e.message : "Couldn't create.");
    },
  });

  function reset() {
    setStep("choose-shape");
    setPickedModule(null);
    setDisplayName("");
    setPlacement("standalone");
    setMenuId(NEW_MENU);
    setNewMenuName("");
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!displayName.trim()) return;
    create.mutate();
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="New thing in workspace"
      size="md"
    >
      {step === "choose-shape" && (
        <div className="space-y-3">
          <p className="text-sm text-content dark:text-mortar-200">
            What kind of thing do you want to add to your workspace?
          </p>
          <p className="text-xs text-muted dark:text-slate-400">
            The difference is how it's organized — a thing that stands on its own,
            or a category that lives inside one you already track.
          </p>
          <button
            type="button"
            onClick={() => setStep("instance-pick-module")}
            className="w-full text-left rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 hover:border-accent dark:hover:border-cobble-700 transition flex items-start gap-3"
          >
            <Boxes size={20} className="text-accent mt-0.5 shrink-0" />
            <div className="flex-1">
              <div className="font-medium text-content dark:text-mortar-100">
                Its own thing
              </div>
              <div className="text-xs text-muted dark:text-slate-400 mt-1">
                <span className="font-medium text-content dark:text-mortar-200">
                  Stands on its own.
                </span>{" "}
                Its own list with its own custom fields, and it can grow large
                (thousands of rows). Choose this when what you're adding doesn't
                belong inside anything you already track. Example: a "Cars" list,
                separate from your "Tools."
              </div>
            </div>
          </button>
          {/* The "Sub-category (lens)" option was removed: it dead-ended on a
              "ships next" panel, and the product direction is specialisations-
              as-INSTANCES, not standalone lenses (PR #180). Re-add only if a
              real lens-creation flow lands. (Audit 2026-06-26 follow-up.) */}
        </div>
      )}

      {step === "instance-pick-module" && (
        <div className="space-y-3">
          <p className="text-sm text-content dark:text-mortar-200">
            What kind of thing is it like?
          </p>
          {modules.isLoading && (
            <div className="text-sm text-muted">Loading…</div>
          )}
          {candidates.length === 0 && !modules.isLoading && (
            <div className="text-sm italic text-muted dark:text-slate-400">
              No multi-instance modules enabled. Enable one of: Assets,
              Inventory, Machines, Projects, Purchases.
            </div>
          )}
          {candidates.map((m: OrgModuleListItem) => (
            <button
              key={m.name}
              type="button"
              onClick={() => pickModule(m.name, m.displayName ?? m.name)}
              className="w-full text-left rounded border border-line dark:border-slate-700 p-3 hover:border-accent dark:hover:border-cobble-700 transition"
            >
              <div className="text-sm font-medium text-content dark:text-mortar-100">
                Like {m.displayName ?? m.name}
              </div>
              <div className="text-xs text-muted dark:text-slate-400 mt-0.5">
                {m.description}
              </div>
            </button>
          ))}
          <div className="flex justify-end pt-2">
            <button
              type="button"
              onClick={() => setStep("choose-shape")}
              className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800"
            >
              Back
            </button>
          </div>
        </div>
      )}

      {step === "instance-name" && (
        <form onSubmit={submit} className="space-y-3">
          <p className="text-sm text-content dark:text-mortar-200">
            What's this new thing called?
          </p>
          <label className="block">
            <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
              Name
            </span>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. Cars, Tools, Screws"
              className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
              autoFocus
            />
            {displayName && (
              <div className="text-[10px] text-muted mt-1 font-mono">
                URL slug: <code>{slugify(displayName)}</code>
              </div>
            )}
          </label>

          {/* Navbar placement — the seamless "group categories into one menu" seam. */}
          <fieldset className="space-y-2 rounded-lg border border-line dark:border-slate-700 p-3">
            <legend className="px-1 text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">
              In the navbar
            </legend>
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="radio"
                className="mt-1 accent-cobble-600"
                checked={placement === "standalone"}
                onChange={() => setPlacement("standalone")}
              />
              <span className="text-sm text-content dark:text-mortar-200">
                Its own menu item
                <span className="block text-xs text-muted dark:text-slate-400">
                  A top-level entry of its own.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="radio"
                className="mt-1 accent-cobble-600"
                checked={placement === "menu"}
                onChange={() => setPlacement("menu")}
              />
              <span className="flex-1 text-sm text-content dark:text-mortar-200">
                Inside a menu
                <span className="block text-xs text-muted dark:text-slate-400">
                  Grouped under a navbar dropdown — tidy when you have several of
                  the same kind.
                </span>
              </span>
            </label>
            {placement === "menu" && (
              <div className="ml-6 space-y-2">
                <select
                  value={menuId}
                  onChange={(e) => setMenuId(e.target.value)}
                  className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
                >
                  {(headings.data?.items ?? []).map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name}
                    </option>
                  ))}
                  <option value={NEW_MENU}>+ New menu…</option>
                </select>
                {menuId === NEW_MENU && (
                  <input
                    type="text"
                    value={newMenuName}
                    onChange={(e) => setNewMenuName(e.target.value)}
                    placeholder="Menu name — e.g. Inventory"
                    className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
                  />
                )}
              </div>
            )}
          </fieldset>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setStep("instance-pick-module")}
              className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800"
            >
              Back
            </button>
            <button
              type="submit"
              disabled={
                !displayName.trim() ||
                create.isPending ||
                (placement === "menu" && menuId === NEW_MENU && !newMenuName.trim())
              }
              className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white"
            >
              {create.isPending ? "Creating…" : "Create"}
            </button>
          </div>
        </form>
      )}

    </Modal>
  );
}

function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}
