export function undoWorkspaceState(value: unknown): string {
  return JSON.stringify(value, (key, field) => {
    if (["updated_at", "remaining", "available_qty"].includes(key)) return undefined;
    if (!field || typeof field !== "object" || Array.isArray(field)) return field;
    // Reads may lift the same custom fields in a different database order.
    return Object.fromEntries(Object.keys(field)
      .filter((name) => key !== "stock" || name !== "revision")
      .sort()
      .map((name) => [name, field[name]]));
  }, 1);
}
