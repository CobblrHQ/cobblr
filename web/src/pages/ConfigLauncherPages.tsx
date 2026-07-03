// Configuration launcher PAGES (2026-07-03 settings-cohesion): every entry in
// the settings registry lands on a PAGE inside the sidebar layout — never an
// overlay ("the config links are sometimes whole pages, other times modals,
// it feels very disjointed"). The three launcher dialogs render their exact
// existing components via Modal's `inline` variant — same chrome, same logic,
// in document flow. The overlay variants stay for non-settings entry points
// (the dashboard funnel, nav shortcuts).

import { useNavigate } from "react-router-dom";
import { ModulePickerModal } from "../components/ModulePickerModal";
import { MembersModal } from "../components/MembersModal";
import { NewThingFunnelModal } from "../components/NewThingFunnelModal";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { usePageTitle } from "@cobblr/platform-web";

export function ConfigModulesPage() {
  usePageTitle("Modules");
  const navigate = useNavigate();
  return <ModulePickerModal open inline onClose={() => navigate("/configuration")} />;
}

export function ConfigMembersPage() {
  usePageTitle("Members");
  const navigate = useNavigate();
  const { activeSlug } = useActiveOrg();
  return <MembersModal open inline slug={activeSlug ?? ""} onClose={() => navigate("/configuration")} />;
}

export function ConfigNewThingPage() {
  usePageTitle("New thing");
  const navigate = useNavigate();
  return <NewThingFunnelModal open inline onClose={() => navigate("/configuration")} />;
}
