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
import { Boxes, FolderPlus, Users } from "lucide-react";
import { ModulePickerModal } from "../components/ModulePickerModal";
import { MembersModal } from "../components/MembersModal";
import { NewThingFunnelModal } from "../components/NewThingFunnelModal";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { usePageTitle } from "@cobblr/platform-web";

/** Shared heading so these three match the pages either side of them in their
 *  section. The breadcrumb above them comes from ConfigurationLayout. */
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
      <PageHead
        icon={<Boxes size={22} />}
        title="Modules"
        blurb="Turn capabilities on and off for this workspace."
      />
      <ModulePickerModal
        open
        inline
        chromeless
        onClose={() => navigate("/configuration/s/build")}
      />
    </div>
  );
}

export function ConfigMembersPage() {
  usePageTitle("Members");
  const navigate = useNavigate();
  const { activeSlug } = useActiveOrg();
  return (
    <div className="max-w-4xl mx-auto">
      <PageHead
        icon={<Users size={22} />}
        title="Members & invites"
        blurb="Invite people to this workspace, change roles, revoke access."
      />
      <MembersModal
        open
        inline
        chromeless
        slug={activeSlug ?? ""}
        onClose={() => navigate("/configuration/s/people")}
      />
    </div>
  );
}

export function ConfigNewThingPage() {
  usePageTitle("New thing");
  const navigate = useNavigate();
  return (
    <div className="max-w-4xl mx-auto">
      <PageHead
        icon={<FolderPlus size={22} />}
        title="New thing in workspace"
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
