// Projects module UI export. Host mounts <ProjectsUI /> in its
// router; the navItems metadata drives the top-bar entry.

import { Routes, Route } from "react-router-dom";
import { Layers } from "lucide-react";
import { ProjectsProvider } from "./context";
import { ProjectsListPage } from "./ProjectsListPage";
import { ProjectDetailPage } from "./ProjectDetailPage";

export const navItems = [
  { label: "Projects", path: "/projects", icon: Layers },
];

interface ProjectsUIProps {
  orgSlug: string;
  getToken: () => string | null;
}

export function ProjectsUI({ orgSlug, getToken }: ProjectsUIProps) {
  return (
    <ProjectsProvider orgSlug={orgSlug} getToken={getToken}>
      <Routes>
        <Route index element={<ProjectsListPage />} />
        <Route path=":id" element={<ProjectDetailPage />} />
      </Routes>
    </ProjectsProvider>
  );
}

export { ProjectsApi } from "./api";
export type { Project, Task, TaskDependency } from "./api";
export default ProjectsUI;
