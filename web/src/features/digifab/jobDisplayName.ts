export function jobDisplayName(job: { file_ref: string; metadata?: Record<string, unknown> | null } | null | undefined): string {
  const name = job?.metadata?.display_name;
  return typeof name === "string" && name.trim() ? name : job?.file_ref ?? "";
}
