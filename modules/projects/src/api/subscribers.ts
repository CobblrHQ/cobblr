// Legacy subscriber retained as a no-op so the import doesn't
// break. The auto-unblock behaviour now flows through user-
// configurable wires + the projects.set-dep-satisfied handler in
// handlers.ts. New code should not add direct subscribers — declare
// an action and let a wire fire it.

export function registerProjectsSubscribers(): void {
  // intentionally empty
}
