export function bundleFieldReference(type: string, target?: string): string | null {
  if (type !== "relation") return null;
  if (!target?.trim()) throw new Error("A relation field needs a target kind.");
  return target.trim();
}
