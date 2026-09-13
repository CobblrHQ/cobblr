// What one press says afterwards, composed from what happened: the action's
// own verdict first, and a second line only when a step AFTER the action has
// something the person must do.
//
// A Print label press queued the label (the action's promise, kept) and then
// asked the workspace for a walk-up printer; the Print module was off, the
// list threw, and the surface showed `The "core-print" module isn't enabled`
// as if it were the verdict, over a success (#2884). Two outcomes from one
// press, and the second was not even a refusal: a workspace with no Print
// module has no printer intent, and nothing to print with means nothing to
// say. The queue holds the work either way.
//
// Pure, so the rule is pinned by a test rather than by pressing buttons.
import type { PrintDirectiveResult } from "./print-directive";

/** The verdict: the handler's own sentence when it wrote one, else the
 *  surface's one word for a success. */
export function verdictOf(result: unknown, fallback: string): string {
  const r = result as { summary?: unknown } | null;
  return r && typeof r === "object" && typeof r.summary === "string" && r.summary.trim() ? r.summary.trim() : fallback;
}

/** Whether a failed printer LIST means "no printer intent" (nothing to say)
 *  rather than a printer that cannot be reached. The Print module being off
 *  is the former: no module, no printers, no walk-up intent. */
export function printerListFailureIsNoIntent(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "module_not_enabled") return true;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /module isn't enabled for this workspace/i.test(msg);
}

/** The second line after a walk-up print attempt, or null when there is
 *  nothing the person needs to do. The queue still holds the label in every
 *  case below, so each sentence says what would make it print, never that
 *  something failed. */
export function printNextStep(outcome: { result: PrintDirectiveResult } | { error: unknown }): string | null {
  if ("error" in outcome) {
    if (printerListFailureIsNoIntent(outcome.error)) return null;
    const msg = outcome.error instanceof Error ? outcome.error.message : String(outcome.error ?? "");
    return `Queued, not printed: ${msg || "the printer did not answer"}. It is in the queue on the Labels page.`;
  }
  const r = outcome.result;
  if (r.printed) {
    return r.recordError ? "Printed, but the queue could not be updated. Refresh before printing again." : `Printed to ${r.deviceName}`;
  }
  switch (r.skipped) {
    case "no-browser-printer":
      // No walk-up printer is the default: the queue is the whole story.
      return null;
    case "no-web-bluetooth":
      return "In the queue. Printing straight from here needs Bluetooth in this browser; print it from the Labels page, or open this in a browser that has it.";
    case "no-web-serial":
      return "In the queue. Printing straight from here needs a browser that can reach the printer's cable; print it from the Labels page instead.";
    case "no-width":
      return "In the queue. The walk-up printer has no label width set yet: Labels, then Printers.";
    case "no-bridge-instance":
      return "In the queue. The walk-up printer's bridge has no printer chosen yet: Labels, then Printers.";
    default:
      return null;
  }
}
