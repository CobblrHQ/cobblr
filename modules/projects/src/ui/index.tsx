// Projects module UI export. Host mounts <ProjectsUI /> in its
// router; the navItems metadata drives the top-bar entry.

import { Routes, Route } from "react-router-dom";
import { Layers } from "lucide-react";
// Side-effect: registers the projects "at a glance" dashboard tile through
// platform-web's registerDashboardWidget seam when this UI bundle loads.
import "./DashboardWidget";
import { ProjectsProvider } from "./context";
import { ProjectsListPage } from "./ProjectsListPage";
import { ProjectDetailPage } from "./ProjectDetailPage";

export const navItems = [
  { label: "Projects", path: "/projects", icon: Layers },
];

interface ProjectsUIProps {
  orgSlug: string;
  getToken: () => string | null;
  /** When set, scopes project CRUD to this module instance. */
  instance?: string;
  /** Instance skin: heading label ("Outfits") + singular noun ("outfit") so the
   *  page reads as the user's thing, not "projects" / "New project". */
  displayName?: string;
  itemNoun?: string;
}

export function ProjectsUI({ orgSlug, getToken, instance, displayName, itemNoun }: ProjectsUIProps) {
  return (
    <ProjectsProvider orgSlug={orgSlug} getToken={getToken} instance={instance} displayName={displayName} itemNoun={itemNoun}>
      <Routes>
        <Route index element={<ProjectsListPage />} />
        {/* Bundle setup-cards / next-steps deep-link to
            /instances/<name>/items (the API path convention). Without an
            explicit static route, "items" would match :id and try to open
            a project with id "items". Map it to the list — and add a splat
            fallback — so a deep-link never dead-ends on a blank page. */}
        <Route path="items" element={<ProjectsListPage />} />
        <Route path=":id" element={<ProjectDetailPage />} />
        <Route path="*" element={<ProjectsListPage />} />
      </Routes>
    </ProjectsProvider>
  );
}

export { ProjectsApi } from "./api";
export type { Project, Task, TaskDependency } from "./api";
export default ProjectsUI;
