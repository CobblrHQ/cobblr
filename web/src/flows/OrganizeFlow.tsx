// The Organize planner as a first-party FLOW — openable from anywhere via the
// shell flow host (an action's `ui` directive, a view bulk-action, a nav entry),
// not only from the scan page. Registered under id "core-scan:organize" in
// App.tsx. See docs/architecture/invokable-flows-and-lego-redesign.md.
//
// It wraps the same OrganizePlanSheet + OrganizeWalkSheet the scan page mounts,
// driven purely by args (no ScanInboxItem source): plan names come from the plan
// payload's item_names, so an empty itemsById is fine for entity/refs plans.

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@cobblr/platform-web";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { api, type OrganizeStoredPlan, type ScanInboxItem } from "../lib/api";
import { OrganizePlanSheet } from "../components/OrganizePlanSheet";
import { OrganizeWalkSheet } from "../components/OrganizeWalkSheet";

/** Flow args (all optional; the disassemble directive sends scope:"refs" + refs):
 *  - scope: "refs" | "unplaced" | "pending"
 *  - refs:  "<kind>::<uuid>"[] for scope:"refs"
 *  - hint:  free-text ground truth folded into the plan */
export function OrganizeFlow({
  args,
  onClose,
}: {
  args: Record<string, unknown>;
  onClose: () => void;
}) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();

  const scope =
    args.scope === "refs" || args.scope === "unplaced" || args.scope === "pending"
      ? (args.scope as "refs" | "unplaced" | "pending")
      : "unplaced";
  const refs = Array.isArray(args.refs)
    ? (args.refs as unknown[]).filter((r): r is string => typeof r === "string")
    : undefined;

  // The walk reuses the scan page's fileBin memory (last-confirmed bin), keyed by
  // workspace, so a walk started from a flow behaves like one started from scan.
  const fileBinKey = `cobblr.scanFileBin.${activeSlug ?? ""}`;
  const setFileBin = (v: string) => {
    if (v) localStorage.setItem(fileBinKey, v);
    else localStorage.removeItem(fileBinKey);
  };

  const [walkPlan, setWalkPlan] = useState<OrganizeStoredPlan | null>(null);
  const empty = new Map<string, ScanInboxItem>();

  const startWalk = async () => {
    try {
      const r = await api.getLatestOrganizePlan(activeSlug);
      if (r.plan && r.plan.applied_group_ids.length > 0) setWalkPlan(r.plan);
      else toast.error("Nothing applied to walk yet — accept a group first.");
    } catch {
      toast.error("Couldn't load the plan for the walk.");
    }
  };

  // The walk supersedes the plan sheet once it opens (same as the scan page).
  if (walkPlan) {
    return (
      <OrganizeWalkSheet
        slug={activeSlug}
        plan={walkPlan}
        itemsById={empty}
        setFileBin={setFileBin}
        onClose={() => {
          setWalkPlan(null);
          void qc.invalidateQueries({ queryKey: ["organize-plan-latest", activeSlug] });
          onClose();
        }}
      />
    );
  }

  return (
    <OrganizePlanSheet
      slug={activeSlug}
      scope={scope}
      refs={refs}
      itemIds={[]}
      itemsById={empty}
      open
      onClose={onClose}
      onApplied={() => {
        void qc.invalidateQueries({ queryKey: ["organize-plan-latest", activeSlug] });
        void qc.invalidateQueries({ queryKey: ["scan-inbox", activeSlug] });
      }}
      onStartWalk={() => void startWalk()}
    />
  );
}
