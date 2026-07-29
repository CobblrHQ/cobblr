// The "+ New thing" funnel. Single user-facing entry point for both
// lens-promotion and module-instance creation. Asks one question in
// human language; the system picks the right primitive under the
// hood.
//
// v0.1 ships the instance path only (lens creation requires
// lens-promotion's bundle build which lands next). When the user
// picks "sub-category" the modal explains that's a future capability
// and points them at bundle install for now.

import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Boxes } from "lucide-react";
import { Modal, useToast } from "@cobblr/platform-web";
import { ApiError, api, type OrgModuleListItem } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

// ONE screen: name it, say what it's like, create. It used to be three steps,
// and the first two were both broken (the author, 2026-07-18):
//   1. "What kind of thing do you want to add?" offered a choice between two
//      shapes, explained the difference, and then rendered exactly ONE button —
//      the second option (a lens) had been deleted long ago and the question
//      around it was left behind. A fork with one prong.
//   2. "What kind of thing is it LIKE?" listed "Like Inventory", "Like Assets",
//      "Like Machines" — asking the user to reason by analogy to the module
//      architecture, using manifest descriptions written for developers
//      ("polymorphic allocations", "the platform brokers").
// Now the name comes first (it's the only thing the user actually knows), and
// the kind is chosen from lines describing what YOU do with the thing.
type Step = "name" | "advanced";

/** What each stock module means in a sentence about the user's own stuff.
 *  Keyed by module name; anything unknown falls back to its manifest noun, so a
 *  new multi-instance module still appears (just less warmly). This is display
 *  copy for shipped modules, deliberately NOT a routing rule. */
const KIND_COPY: Record<string, { headline: string; hint: string }> = {
  inventory: {
    headline: "Stuff you have amounts of",
    hint: "Parts, supplies, ingredients, materials. You care how many are left.",
  },
  assets: {
    headline: "Things you own one of",
    hint: "Each one tracked individually, with its own history. Appliances, tools, collections, vehicles.",
  },
  machines: {
    headline: "Machines you run",
    hint: "Something you operate and maintain. Can connect to a printer or cutter later.",
  },
  projects: {
    headline: "Work you're doing",
    hint: "Projects and tasks, with things that wait on other things.",
  },
  purchases: {
    headline: "Things you bought",
    hint: "Orders and what they cost, linked to whatever they were for.",
  },
  sales: {
    headline: "Things you sell",
    hint: "Customer orders that draw down your stock when you fulfil them.",
  },
};

/** A NUDGE, never a decision: highlight the likeliest kind for what the user
 *  typed so the common case is one glance instead of a comparison. It only ever
 *  adds a "suggested" badge and preselects — the user still picks, because
 *  guessing wrong here silently files data in the wrong place. */
const SUGGEST: Array<{ module: string; re: RegExp }> = [
  { module: "machines", re: /\b(printer|cutter|cnc|laser|lathe|mill|machine|router)s?\b/i },
  { module: "assets", re: /\b(car|vehicle|truck|bike|motorcycle|computer|laptop|monitor|instrument|appliance|furniture|camera)s?\b/i },
  { module: "purchases", re: /\b(order|purchase|receipt|invoice)s?\b/i },
  { module: "projects", re: /\b(project|task|build|job)s?\b/i },
  { module: "sales", re: /\b(sale|customer|shipment)s?\b/i },
];
function suggestModule(name: string, available: string[]): string | null {
  for (const s of SUGGEST) {
    if (s.re.test(name) && available.includes(s.module)) return s.module;
  }
  return null;
}

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
  inline,
}: {
  open: boolean;
  onClose: () => void;
  /** Render in-flow (settings page mode) instead of as an overlay. */
  inline?: boolean;
}) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [step, setStep] = useState<Step>("name");
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
  }
  // Only multi-instance modules show in the picker — read from the manifest's
  // `instanceability` field (now on the /orgs/:slug/modules response), so a new
  // multi-instance module appears automatically and the funnel can't drift from
  // the real set. (Audit 2026-06-26 follow-up — was a hardcoded allowlist that
  // had already missed `sales`.)
  const candidates = (modules.data?.items ?? []).filter(
    (m) => m.instanceability === "multi",
  );

  // The nudge. Preselects the likeliest kind AS YOU TYPE, and stops the moment
  // you make your own choice — a suggestion that overrode a deliberate pick
  // would be worse than none, since the kind decides where the data lives.
  const suggested = suggestModule(displayName, candidates.map((c) => c.name));
  const [userPicked, setUserPicked] = useState(false);
  useEffect(() => {
    if (userPicked || !suggested) return;
    const m = candidates.find((c) => c.name === suggested);
    if (m) pickModule(m.name, m.displayName ?? m.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggested, userPicked]);
  /** A click: same as the nudge, but it also switches the nudge off. */
  function choose(name: string, display: string) {
    setUserPicked(true);
    pickModule(name, display);
  }

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
    setStep("name");
    setPickedModule(null);
    setDisplayName("");
    setPlacement("standalone");
    setMenuId(NEW_MENU);
    setNewMenuName("");
    setUserPicked(false);
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
      inline={inline}
    >
      <form onSubmit={submit} className="space-y-4">
        {/* 1. The name. It's the only thing the user actually knows when they
            open this, so it leads — and every question below then reads with
            their word in it instead of an abstraction. */}
        <label className="block">
          <span className="block text-sm text-content dark:text-mortar-200 mb-1.5">
            What do you want to track?
          </span>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="e.g. Cars, Spices, Yarn, 3D Printers"
            className="w-full px-3 py-2 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
            autoFocus
          />
          {displayName.trim() && (
            <div className="text-[10px] text-muted mt-1 font-mono">
              URL slug: <code>{slugify(displayName)}</code>
            </div>
          )}
        </label>

        {/* 2. What is it? Described by what YOU do with the thing, never by
            which module implements it. The suggestion is a badge + preselect,
            not an auto-decision. */}
        {displayName.trim() && (
          <div className="space-y-2">
            <div className="text-sm text-content dark:text-mortar-200">
              What is {displayName.trim()}, roughly?
            </div>
            {modules.isLoading && <div className="text-sm text-muted">Loading…</div>}
            {candidates.length === 0 && !modules.isLoading && (
              <div className="text-sm italic text-muted dark:text-slate-400">
                No multi-instance modules enabled. Turn on one of: Assets, Inventory,
                Machines, Projects, Purchases.
              </div>
            )}
            {candidates.map((m: OrgModuleListItem) => {
              const copy = KIND_COPY[m.name];
              const picked = pickedModule === m.name;
              const isSuggested = suggested === m.name;
              return (
                <button
                  key={m.name}
                  type="button"
                  onClick={() => choose(m.name, m.displayName ?? m.name)}
                  className={
                    "w-full text-left rounded-lg border p-3 transition " +
                    (picked
                      ? "border-accent bg-accent/5 dark:bg-cobble-900/20"
                      : "border-line dark:border-slate-700 hover:border-accent dark:hover:border-cobble-700")
                  }
                >
                  <div className="flex items-center gap-2">
                    <Boxes size={15} className={picked ? "text-accent" : "text-faint"} />
                    <span className="text-sm font-medium text-content dark:text-mortar-100">
                      {copy?.headline ?? (m.displayName ?? m.name)}
                    </span>
                    {isSuggested && (
                      <span className="text-[10px] font-mono uppercase tracking-wider rounded-full bg-accent/10 text-accent px-1.5 py-0.5">
                        suggested
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted dark:text-slate-400 mt-1">
                    {copy?.hint ?? m.description}
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {/* 3. Navbar placement — a detail with a good default, not a step. It
            already resolves smartly (an nth category of the same kind joins the
            menu its siblings made), so it stays folded unless asked for. */}
        {pickedModule && (
          <div className="rounded-lg border border-line dark:border-slate-700">
            <button
              type="button"
              onClick={() => setStep(step === "advanced" ? "name" : "advanced")}
              className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left"
            >
              <span className="text-xs text-muted dark:text-slate-400">
                In the navbar:{" "}
                <span className="text-content dark:text-mortar-200">
                  {placement === "standalone"
                    ? "its own entry"
                    : `inside ${
                        menuId === NEW_MENU
                          ? `a new "${newMenuName.trim() || "menu"}" menu`
                          : ((headings.data?.items ?? []).find((h) => h.id === menuId)?.name ?? "a menu")
                      }`}
                </span>
              </span>
              <span className="text-xs text-accent shrink-0">
                {step === "advanced" ? "done" : "change"}
              </span>
            </button>
            {step === "advanced" && (
              <fieldset className="space-y-2 px-3 pb-3 border-t border-line dark:border-slate-800 pt-2">
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
                      Grouped under a navbar dropdown - tidy when you have several of
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
                        placeholder="Menu name - e.g. Inventory"
                        className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
                      />
                    )}
                  </div>
                )}
              </fieldset>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="submit"
            disabled={
              !displayName.trim() ||
              !pickedModule ||
              create.isPending ||
              (placement === "menu" && menuId === NEW_MENU && !newMenuName.trim())
            }
            className="px-4 py-2 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white font-medium"
          >
            {create.isPending ? "Creating…" : displayName.trim() ? `Create ${displayName.trim()}` : "Create"}
          </button>
        </div>
      </form>

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
