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

import { ModulePickerModal } from "../components/ModulePickerModal";
import { MembersModal } from "../components/MembersModal";
import { NewThingFunnelModal } from "../components/NewThingFunnelModal";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useCloseToOrigin, usePageTitle } from "@cobblr/platform-web";

export function ConfigModulesPage() {
  usePageTitle("Modules");
  const closeToBuild = useCloseToOrigin("/configuration/s/build");
  return (
    <div>
      <ModulePickerModal
        open
        inline
        chromeless
        onClose={closeToBuild}
      />
    </div>
  );
}

export function ConfigMembersPage({ focus }: { focus?: "invite" } = {}) {
  usePageTitle(focus === "invite" ? "Invite someone" : "Members");
  const closeToPeople = useCloseToOrigin("/configuration/s/people");
  const { activeSlug } = useActiveOrg();
  return (
    <div>
      <MembersModal
        open
        inline
        chromeless
        focus={focus}
        slug={activeSlug ?? ""}
        onClose={closeToPeople}
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
  usePageTitle("New thing");
  const closeToBuild = useCloseToOrigin("/configuration/s/build");
  return (
    <div>
      <NewThingFunnelModal
        open
        inline
        chromeless
        onClose={closeToBuild}
      />
    </div>
  );
}
