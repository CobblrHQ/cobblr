export function entityInitial(name: string): string {
  return name.trim().replace(/^(?:a|an|the)\s+/i, "").slice(0, 1).toUpperCase() || "?";
}
