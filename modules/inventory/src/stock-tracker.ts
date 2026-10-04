export function stockTrackerAllows(trackedBy: string | null, reporter?: string): boolean {
  return reporter === "firmware" ? trackedBy === "firmware" : !trackedBy;
}
