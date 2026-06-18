// Coarse device-state classification, shared by the fleet view and the
// assignment worker. Drivers report wildly different free-form state strings
// ("operational", "Printing", "idle", "offline", "error") — bucket them loosely.
// No imports → safe to use from anywhere without a cycle.

export type DeviceClass = "printing" | "idle" | "paused" | "complete" | "offline" | "error" | "unknown";

export function classify(state: string): DeviceClass {
  const s = (state || "").toLowerCase();
  if (/print|run|busy|active/.test(s)) return "printing";
  if (/error|fault|fail|alarm/.test(s)) return "error";
  if (/offline|disconnect|unreachable/.test(s)) return "offline";
  // A finished print leaves the part on the bed; a paused print is mid-job.
  // Neither is free to take new work — so they are NOT "idle". Keeping them out
  // of the idle bucket is half the bed-clear safety gate; the other half is the
  // persistent digifab_device_attention flag the assign worker also checks.
  if (/pause|held|hold/.test(s)) return "paused";
  if (/complete|finish|done/.test(s)) return "complete";
  if (/idle|operational|ready|online|standby/.test(s)) return "idle";
  return "unknown";
}

/** Free to be SENT a new job right now? Only a truly idle device. (The assign
 *  worker additionally checks the bed-clear attention flag.) */
export function isAssignable(state: string): boolean {
  return classify(state) === "idle";
}
