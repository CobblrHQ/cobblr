// Configuration launcher PAGES: three settings destinations whose UI was
// written as a dialog before it had a route of its own.
//
// They render the SAME components the overlay uses, but `chromeless` so the
// dialog's card border, title bar and ✕ are dropped and each route supplies a
// plain page heading like every other settings page. With `inline` alone they
// still drew the dialog's own header, so Modules read as a modal stranded on a
// page while Units, Templates and the rest beside it were ordinary pages.
//
// The overlay variants stay for non-settings entry points (the dashboard funnel,
// nav shortcuts) — those genuinely are dialogs opened over something else.

import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { FolderPlus } from "lucide-react";
import { ModulePickerModal } from "../components/ModulePickerModal";
import { MembersModal } from "../components/MembersModal";
import { NewThingFunnelModal } from "../components/NewThingFunnelModal";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { usePageTitle } from "@cobblr/platform-web";

/** A heading for a launcher route the settings shell does NOT know about.
 *
 *  ConfigPageHeader draws the header for every route in CONFIG_DESTINATIONS,
 *  which is why a page must not draw its own — Modules and Members both did,
 *  and both printed their title twice (caught 2026-08-20, and the exact defect
 *  ConfigPageHeader's own comment says it was written to end). Use this ONLY on
 *  a route with no registry entry, like /configuration/new-thing.
 *  ConfigurationPage.render.test.tsx enforces that. */
function PageHead({ icon, title, blurb }: { icon: ReactNode; title: string; blurb: string }) {
  return (
    <div className="border-b border-line dark:border-slate-700 pb-3 mb-4">
      <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 flex items-center gap-2">
        {icon} {title}
      </h1>
      <p className="text-xs text-faint mt-1">{blurb}</p>
    </div>
  );
}

export function ConfigModulesPage() {
  usePageTitle("Modules");
  const navigate = useNavigate();
  return (
    <div className="max-w-4xl mx-auto">
      <ModulePickerModal
        open
        inline
        chromeless
        onClose={() => navigate("/configuration/s/build")}
      />
    </div>
  );
}

export function ConfigMembersPage({ focus }: { focus?: "invite" } = {}) {
  usePageTitle(focus === "invite" ? "Invite someone" : "Members");
  const navigate = useNavigate();
  const { activeSlug } = useActiveOrg();
  return (
    <div className="max-w-4xl mx-auto">
      <MembersModal
        open
        inline
        chromeless
        focus={focus}
        slug={activeSlug ?? ""}
        onClose={() => navigate("/configuration/s/people")}
      />
    </div>
  );
}

/** Same page, arriving at the invite form. A section's action must land
 *  somewhere its leaf does not (see configuration-revamp.md, "Section
 *  actions"), and "Members & invites" is already the leaf for the list. */
export function ConfigInvitePage() {
  return <ConfigMembersPage focus="invite" />;
}

export function ConfigNewThingPage() {
  usePageTitle("New category");
  const navigate = useNavigate();
  return (
    <div className="max-w-4xl mx-auto">
      <PageHead
        icon={<FolderPlus size={22} />}
        title="New category"
        blurb="Add a top-level thing to track. Pick whether it is its own separate thing or a sub-category of something you already have."
      />
      <NewThingFunnelModal
        open
        inline
        chromeless
        onClose={() => navigate("/configuration/s/build")}
      />
    </div>
  );
}
