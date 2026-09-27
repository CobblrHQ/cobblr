// What the strip at the foot of a sandbox or trial workspace says, as whole
// sentences.
//
// The strip used to glue a fragment ("an hour left.") after a sentence
// ("This is a sandbox. "), and read "This is a sandbox. an hour left." on a
// phone. Every line here is built whole, so no state can come out as a
// fragment; workspace-state-copy.test.ts renders each one and checks that.

/** How long is left, as the object of "You have … left." */
function timeLeft(msLeft: number): string {
  if (msLeft < 60_000) return "less than a minute";
  const mins = Math.round(msLeft / 60_000);
  if (mins <= 1) return "1 minute";
  if (mins < 60) return `${mins} minutes`;
  return "an hour";
}

/** The sandbox countdown, quiet (the chip) or urgent (the last stretch). */
export function sandboxLine(msLeft: number, urgent: boolean): string {
  if (msLeft <= 0) return "This sandbox has ended.";
  const left = `You have ${timeLeft(msLeft)} left.`;
  return urgent ? `This sandbox is nearly done. ${left}` : `This is a sandbox. ${left}`;
}

/** A trial's first sentence: "This workspace is yours until 12 Oct." */
export function trialLine(until: string | null): string {
  return until ? `This workspace is yours until ${until}.` : "This workspace is yours.";
}

/** The sentence before the address the sign-in link went to (the address and
 *  its full stop follow it). */
export function signInLinkLead(emailed: boolean | undefined): string {
  return emailed === false ? "We could not send your sign-in link to " : "We sent your sign-in link to ";
}

/** "24 hours", "an hour", "3 days": a hold, said plainly. */
export function holdPhrase(hours: number): string {
  if (hours % 24 === 0 && hours >= 48) return `${hours / 24} days`;
  if (hours === 1) return "one hour";
  return `${hours} hours`;
}

/** The ending page's words: a heading and one short paragraph, whole
 *  sentences, and only what is true. The page used to carry two long
 *  paragraphs and a "Stays here" list that contradicted the line above it. */
export function endedCopy(
  e: { kind: "trial" } | { kind: "sandbox"; holdHours: number },
): { heading: string; body: string } {
  if (e.kind === "trial") {
    return {
      heading: "Your trial has ended.",
      body: "This workspace was a trial on our demo site, and it will be deleted soon.",
    };
  }
  // The owner's words (2026-09-27): what happened, and what happened to the
  // work, before anything asks for a decision.
  if (e.holdHours > 0) {
    return { heading: "Your hour is over.", body: `Your sandbox is saved for ${holdPhrase(e.holdHours)}.` };
  }
  return { heading: "Your hour is over.", body: "This sandbox is closed and has been deleted." };
}
