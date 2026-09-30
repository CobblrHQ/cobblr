// A task's own address (/projects/tasks/<id>) opens the project it is in,
// where its tasks are listed. A task in no project has no page of its own, so
// its address says what it is and leads back to the list rather than showing
// the list as if nothing had been asked for.
import { useQuery } from "@tanstack/react-query";
import { Link, Navigate, useParams } from "react-router-dom";
import { useProjects } from "./context";

export function TaskAddress() {
  const { id } = useParams<{ id: string }>();
  const { api, instance, displayName } = useProjects();
  const task = useQuery({ queryKey: ["project-task", id], queryFn: () => api.getTask(id!), enabled: !!id, retry: false });
  const back = instance ? `/instances/${instance}` : "/projects";
  if (task.data?.project_id) return <Navigate to={`${back}/${task.data.project_id}`} replace />;
  if (task.isLoading) return <div className="text-sm text-muted">Loading…</div>;
  return (
    <div className="space-y-2 max-w-2xl">
      {task.data ? (
        <>
          <h1 className="text-lg font-semibold text-content dark:text-mortar-100">{task.data.title}</h1>
          <p className="text-sm text-muted">This task is not in a project.</p>
        </>
      ) : (
        <p className="text-sm text-muted">That task is not here any more.</p>
      )}
      <Link to={back} className="text-sm text-accent hover:underline">
        All {displayName ? displayName.toLowerCase() : "projects"}
      </Link>
    </div>
  );
}
