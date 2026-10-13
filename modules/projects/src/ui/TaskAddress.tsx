// /projects/tasks/<id>: the address a task is reached by (search results, the
// assistant, a notification). It lands on the task's project with the task
// open, so the person sees it among its siblings; a task with no project opens
// over the list.

import { Navigate, useParams, useResolvedPath } from "react-router-dom";
import { useCloseToOrigin } from "@cobblr/platform-web";
import { useQuery } from "@tanstack/react-query";
import { useProjects } from "./context";
import { ProjectsListPage } from "./ProjectsListPage";
import { TaskSheet, taskKey } from "./TaskSheet";

export function TaskAddress() {
  const { id: taskId } = useParams<{ id: string }>();
  const { api } = useProjects();
  // Back to where the task was opened from, else the projects list (#6266).
  const close = useCloseToOrigin(useResolvedPath("../..", { relative: "path" }).pathname);
  const task = useQuery({ queryKey: taskKey(taskId ?? ""), queryFn: () => api.getTask(taskId!), enabled: !!taskId });
  if (task.data?.project_id) return <Navigate to={`../../${task.data.project_id}?task=${task.data.id}`} relative="path" replace />;
  return (
    <>
      <ProjectsListPage />
      {taskId && (task.data || task.isError) && <TaskSheet taskId={taskId} onClose={close} />}
    </>
  );
}
