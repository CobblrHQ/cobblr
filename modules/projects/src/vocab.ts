// The values a project's and a task's fields take. One list each, read by the
// writer (which refuses anything else) and by the manifest (which declares
// them as the field's choices, so a board's columns and a drop on one are
// always values the writer accepts).
export const PROJECT_STATUSES = ["planning", "active", "blocked", "done", "abandoned"] as const;
export const TASK_STATUSES = ["todo", "doing", "done", "blocked", "cancelled"] as const;
export const PRIORITIES = ["low", "med", "high", "urgent"] as const;
export const ENERGIES = ["small", "medium", "large"] as const;
