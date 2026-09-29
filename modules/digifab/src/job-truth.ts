// What a printer's report means for a job, decided in one place.
//
// A manager answers with the PRINTER's state, not the job's: OctoPrint says
// "Operational" both before a print starts and after one is cancelled, Klipper
// says "standby" while it heats for the print it was just given. Mapping those
// straight to "completed" finished Klipper jobs before they printed and counted
// a print stopped at the printer as a finished part, each charging a spool
// for filament that was never used (#4031). So a report is read against what
// Cobblr knows about the job: whether it has been seen printing, how far it
// got, and whether someone asked Cobblr to cancel it.

export type JobStatusName = "queued" | "assigning" | "sent" | "awaiting-assignment" | "printing" | "paused" | "completed" | "failed" | "cancelled";

/** How long a sent print may sit without the printer starting it. */
export const NEVER_STARTED_MS = 20 * 60_000;

/** A progress fraction at or above this is a finished print. */
const FINISHED = 0.99;

export interface JobTruthInput {
  /** What the driver mapped the printer's state to. */
  reported: string;
  /** 0..1, or null when the manager does not say. */
  progress: number | null;
  /** The job's status before this report. */
  prevStatus: string;
  /** Someone asked Cobblr to cancel it. */
  cancelRequested: boolean;
  /** When it reached the printer; null for a job sent before this was recorded. */
  sentAt: Date | null;
  now: Date;
}

export interface JobTruth {
  status: JobStatusName;
  /** A sentence for job.error when the outcome needs one, else null. */
  note: string | null;
}

/** Has the printer been seen working on this job? */
export function seenPrinting(prevStatus: string): boolean {
  return prevStatus === "printing" || prevStatus === "paused";
}

export function interpretReport(i: JobTruthInput): JobTruth {
  const prev = i.prevStatus as JobStatusName;
  const pct = i.progress != null ? Math.round(i.progress * 100) : null;

  // The printer is idle or reports the job over.
  if (i.reported === "completed") {
    if (i.cancelRequested) return { status: "cancelled", note: "Cancelled from Cobblr, and the printer stopped." };
    if (seenPrinting(prev)) {
      // Idle again before the end: somebody stopped it at the printer.
      if (i.progress != null && i.progress < FINISHED) {
        return { status: "cancelled", note: `Stopped at the printer at ${pct}%.` };
      }
      return { status: "completed", note: null };
    }
    // Never seen printing. Finished between two polls if the manager says it
    // got to the end; otherwise it has not started yet (a printer heating).
    if (i.progress != null && i.progress >= FINISHED) return { status: "completed", note: null };
    return notStarted(i, prev);
  }

  if (i.reported === "cancelled") {
    return { status: "cancelled", note: i.cancelRequested ? "Cancelled from Cobblr, and the printer stopped." : "Cancelled at the printer." };
  }

  if (i.reported === "failed") return { status: "failed", note: null };

  if (i.reported === "printing" || i.reported === "paused") {
    return { status: i.reported, note: i.cancelRequested ? "Cancel requested; waiting for the printer to stop." : null };
  }

  // queued / unknown / anything else: the manager did not say anything a job
  // can be in. Keep what Cobblr knew rather than writing its word onto the job.
  if (!seenPrinting(prev)) return notStarted(i, prev);
  return { status: prev, note: null };
}

function notStarted(i: JobTruthInput, prev: JobStatusName): JobTruth {
  if (i.sentAt && i.now.getTime() - i.sentAt.getTime() > NEVER_STARTED_MS) {
    return { status: "failed", note: `The printer never started this print (sent ${Math.round((i.now.getTime() - i.sentAt.getTime()) / 60_000)} minutes ago).` };
  }
  return { status: prev === "awaiting-assignment" ? "awaiting-assignment" : "sent", note: null };
}

/** An error whose message is already a sentence for the person: a bridge that
 *  refused a call and said why ("This bridge only reaches the addresses in its
 *  BRIDGE_ALLOW setting…"). Shown as said, never re-guessed from its status. */
export class DriverSaid extends Error {
  readonly status: number;
  constructor(status: number, sentence: string) {
    super(sentence);
    this.name = "DriverSaid";
    this.status = status;
  }
}

/** The sentence in an error body a bridge or manager answered with, if any. */
export function sentenceIn(body: unknown): string | null {
  const e = (body as { error?: unknown } | null)?.error;
  const m = typeof e === "string" ? e : typeof (e as { message?: unknown } | null)?.message === "string" ? (e as { message: string }).message : null;
  return m && m.trim() ? m.trim().slice(0, 300) : null;
}

/** A driver error in words a person at the farm can act on. Never a URL, a
 *  JSON body or a stack: "OctoPrint refused the upload (HTTP 500)". */
export function plainDriverError(err: unknown, manager: string, doing: string): string {
  if (err instanceof DriverSaid) return `${manager}: ${/[.!?]$/.test(err.message) ? err.message : `${err.message}.`}`;
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : "";
  const text = `${raw} ${cause}`;
  if (/abort|timeout|timed out/i.test(text) || (err as { name?: string })?.name === "TimeoutError") {
    return `${manager} didn't answer while ${doing}.`;
  }
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|fetch failed|socket hang up|ECONNRESET/i.test(text)) {
    return `Can't reach ${manager} while ${doing}. Check that it is on and on the network.`;
  }
  const http = /(?:→|->|status)\s*(\d{3})\b/.exec(text)?.[1];
  if (http === "401" || http === "403") return `${manager} refused the key while ${doing}. Check the API key or login on this connection.`;
  if (http === "404") return `${manager} doesn't know what Cobblr asked for while ${doing} (HTTP 404).`;
  if (http === "413") return `${manager} refused the file as too large while ${doing}.`;
  if (http && http.startsWith("5")) return `${manager} had an error while ${doing} (HTTP ${http}).`;
  if (http) return `${manager} refused the request while ${doing} (HTTP ${http}).`;
  // Unrecognised: keep the first line, with anything that looks like a URL removed.
  const firstLine = raw.split("\n")[0]!.replace(/https?:\/\/\S+/g, "").replace(/\{.*$/, "").trim();
  return `${manager} failed while ${doing}${firstLine ? `: ${firstLine.slice(0, 160)}` : "."}`;
}

/** How long a live job's manager may stay out of reach before the job is
 *  given up. Long on purpose: the printer keeps printing while its manager
 *  restarts or the network drops, and failing the job then frees the bed for
 *  the next plate while a part is still on it. */
export const GIVE_UP_UNREACHABLE_MS = 6 * 60 * 60_000;
/** The poll interval for a real farm, and the ceiling a miss backs off to. */
export const POLL_MS = 30_000;
export const MAX_BACKOFF_MS = 5 * 60_000;

export interface UnreachablePlan {
  giveUp: boolean;
  /** When to ask again: doubling from the normal interval per miss, capped. */
  nextPollMs: number;
  /** The sentence for job.error, appended to the driver's plain error. */
  note: string;
}

/** What a missed poll means for a live job: keep its status and back off,
 *  until its manager has been out of reach for `giveUpMs`. `fast` is the mock
 *  driver's pace, so a test or a demo sees a give-up in seconds. */
export function unreachablePlan(i: { since: Date; now: Date; misses: number; fast?: boolean }): UnreachablePlan {
  const base = i.fast ? 4_000 : POLL_MS;
  const giveUpMs = i.fast ? 12_000 : GIVE_UP_UNREACHABLE_MS;
  const outFor = Math.max(0, i.now.getTime() - i.since.getTime());
  if (outFor >= giveUpMs) {
    return { giveUp: true, nextPollMs: base, note: `Gave up after ${duration(outFor)} out of reach.` };
  }
  const nextPollMs = i.fast ? base : Math.min(MAX_BACKOFF_MS, base * 2 ** Math.max(0, i.misses - 1));
  return {
    giveUp: false,
    nextPollMs,
    note: `Out of reach for ${duration(outFor)}; the print keeps its status and Cobblr keeps checking (gives up after ${duration(giveUpMs)}).`,
  };
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return "under a minute";
  if (s < 90) return "a minute";
  const m = Math.round(s / 60);
  if (m < 90) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.round(m / 6) / 10;
  return `${h} hours`;
}
