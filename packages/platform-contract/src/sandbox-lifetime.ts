// How long a sandbox's work lasts, said one way everywhere it is said.
//
// The ending page said "Your sandbox is saved for 24 hours" while the email
// sent the same minute said "Your sandbox itself is already gone" (#4217):
// the page read a configured number and the email a sentence written for a
// different moment. Both now read the sandbox's actual state from the server
// (live, held after its hour, kept as a trial, or gone) and put it in words
// here, so the two cannot disagree.

export type SandboxLifetimeState = "live" | "held" | "kept" | "gone";

export interface SandboxLifetime {
  state: SandboxLifetimeState;
  /** When the current state ends: the hour, the hold, or the trial. Null when gone. */
  until: string | null;
}

/** "about 23 hours", "about 40 minutes", "13 days": how long is left, rounded
 *  the way a person would say it. */
export function timeLeftPhrase(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `about ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `${days} days`;
}

/** One sentence: what happens to the sandbox and when. */
export function lifetimeSentence(l: SandboxLifetime, now: number = Date.now()): string {
  const left = l.until ? timeLeftPhrase(Date.parse(l.until) - now) : null;
  switch (l.state) {
    case "live":
      return `Your sandbox is open for ${left} more.`;
    case "held":
      return `Your sandbox is kept for ${left} more, then it is deleted.`;
    case "kept":
      return `Your workspace is kept as a trial for ${left} more.`;
    case "gone":
      return "Your sandbox has been deleted.";
  }
}
