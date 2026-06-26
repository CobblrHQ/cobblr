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

  const modules = useQuery({
    queryKey: ["org-modules", activeSlug],
    queryFn: () => api.orgModules(activeSlug),
    enabled: !!activeSlug && open,
  });
  // Only multi-instance modules show in the picker — read from the manifest's
  // `instanceability` field (now on the /orgs/:slug/modules response), so a new
  // multi-instance module appears automatically and the funnel can't drift from
  // the real set. (Audit 2026-06-26 follow-up — was a hardcoded allowlist that
  // had already missed `sales`.)
  const candidates = (modules.data?.items ?? []).filter(
    (m) => m.instanceability === "multi",
  );

  const create = useMutation({
    mutationFn: () => {
      if (!pickedModule) throw new Error("module not picked");
      const slug = slugify(displayName);
      return api.createInstance(activeSlug, {
        module_name: pickedModule,
        instance_name: slug,
        display_name: displayName.trim(),
      });
    },
    onSuccess: (inst) => {
      toast.success(`Created '${inst.display_name}'.`);
      void qc.invalidateQueries({ queryKey: ["instances", activeSlug] });
      void qc.invalidateQueries({ queryKey: ["entity-kind-overrides", activeSlug] });
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
              onClick={() => {
                setPickedModule(m.name);
                setStep("instance-name");
              }}
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
              disabled={!displayName.trim() || create.isPending}
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
