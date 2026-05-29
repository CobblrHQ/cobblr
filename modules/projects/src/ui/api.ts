export type ProjectStatus = "planning" | "active" | "blocked" | "done" | "abandoned";
export type Priority = "low" | "med" | "high" | "urgent";
export type TaskStatus = "todo" | "doing" | "done" | "blocked" | "cancelled";
export type Energy = "small" | "medium" | "large";

export interface Project {
  id: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  priority: Priority | null;
  start_date: string | null;
  target_date: string | null;
  completion_date: string | null;
  color: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface Task {
  id: string;
  project_id: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: Priority | null;
  energy: Energy | null;
  due_date: string | null;
  completed_at: string | null;
  order_within: number;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  project_name?: string | null;
  blocked_deps?: number;
}

export interface TaskDependency {
  id: string;
  task_id: string;
  depends_on_task_id: string | null;
  target_module: string | null;
  target_entity_type: string | null;
  target_entity_id: string | null;
  satisfied: boolean;
  note: string | null;
  created_at: string;
}

export class ProjectsApi {
  constructor(
    private readonly slug: string,
    private readonly opts: { getToken: () => string | null; instance?: string },
  ) {}

  private base(): string {
    return `/api/v1/orgs/${this.slug}/modules/projects`;
  }

  /** Base for the primary-entity (projects) CRUD. Instance-scoped when
   *  an instance is set; the legacy module route otherwise. */
  private projectsBase(): string {
    return this.opts.instance
      ? `/api/v1/orgs/${this.slug}/instances/${this.opts.instance}/items`
      : `${this.base()}/projects`;
  }

  private async requestUrl<T>(method: string, url: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const token = this.opts.getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return undefined as T;
    const parsed = await res.json().catch(() => null);
    if (!res.ok) {
      const err = (parsed as { error?: { code?: string; message?: string } } | null)?.error;
      throw new Error(err?.message ?? `HTTP ${res.status}`);
    }
    return parsed as T;
  }

  private request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.requestUrl<T>(method, `${this.base()}${path}`, body);
  }
  private projectsRequest<T>(method: string, subpath: string, body?: unknown): Promise<T> {
    return this.requestUrl<T>(method, `${this.projectsBase()}${subpath}`, body);
  }

  listProjects = () => this.projectsRequest<{ items: Project[] }>("GET", "");
  getProject = (id: string) => this.projectsRequest<Project>("GET", `/${id}`);
  createProject = (b: { name: string; description?: string | null; status?: ProjectStatus; priority?: Priority | null }) =>
    this.projectsRequest<Project>("POST", "", b);
  updateProject = (id: string, b: Record<string, unknown>) =>
    this.projectsRequest<Project>("PATCH", `/${id}`, b);
  deleteProject = (id: string) => this.projectsRequest<void>("DELETE", `/${id}`);

  listTasks = (q: { project_id?: string; status?: TaskStatus; energy?: Energy } = {}) => {
    const params = new URLSearchParams();
    if (q.project_id) params.set("project_id", q.project_id);
    if (q.status) params.set("status", q.status);
    if (q.energy) params.set("energy", q.energy);
    const qs = params.toString();
    return this.request<{ items: Task[] }>("GET", `/tasks${qs ? "?" + qs : ""}`);
  };
  getTask = (id: string) => this.request<Task & { dependencies: TaskDependency[] }>("GET", `/tasks/${id}`);
  createTask = (b: { project_id?: string | null; title: string; status?: TaskStatus; priority?: Priority | null; energy?: Energy | null }) =>
    this.request<Task>("POST", "/tasks", b);
  updateTask = (id: string, b: Record<string, unknown>) =>
    this.request<Task>("PATCH", `/tasks/${id}`, b);
  deleteTask = (id: string) => this.request<void>("DELETE", `/tasks/${id}`);

  addDependency = (taskId: string, b: {
    depends_on_task_id?: string;
    target_module?: string;
    target_entity_type?: string;
    target_entity_id?: string;
    note?: string;
  }) => this.request<TaskDependency>("POST", `/tasks/${taskId}/dependencies`, b);
  removeDependency = (taskId: string, depId: string) =>
    this.request<void>("DELETE", `/tasks/${taskId}/dependencies/${depId}`);
}
