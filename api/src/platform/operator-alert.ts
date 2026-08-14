// Tell the people who run this instance something they need to know.
//
// "Operator" is not "admin of a workspace" — it is whoever is on SUPERADMIN_EMAILS,
// the person who would go fix the box. There is exactly one way to reach them and it
// is here, because the alternative is what already happened twice: the database
// upgrade alert grew its own copy of "split SUPERADMIN_EMAILS and send an email", and
// the next caller would have grown a third that drifts in its own direction.
//
// Every alert is best effort. An operator alert that can fail a request is worse than
// the thing it was announcing.

import { env } from "../env.js";
import { sendAuthEmail } from "./hosted-seams.js";

/** Parse a SUPERADMIN_EMAILS value. Compose passes an unset var as "", so the empty
 *  result is the normal case on a self-host box, not an error: no operators, no alerts.
 *
 *  The value is a REQUIRED argument rather than a parameter defaulting to env, because a
 *  default makes the two cases indistinguishable: JS treats an explicit `undefined` as
 *  "use the default", so a test for the unset case silently read the real environment and
 *  passed or failed on whatever the machine happened to have set. CI caught exactly that. */
export function parseOperatorEmails(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Who this instance's alerts go to. */
export function operatorEmails(): string[] {
  return parseOperatorEmails(env.SUPERADMIN_EMAILS);
}

/** Email every operator. Never throws, and never blocks the caller's request. */
export async function notifyOperators(alert: { subject: string; text: string }): Promise<number> {
  const to = operatorEmails();
  let sent = 0;
  for (const address of to) {
    try {
      await sendAuthEmail({ to: address, kind: "notification", subject: alert.subject, text: alert.text });
      sent++;
    } catch (err) {
      // One bad address must not swallow the alert for everyone else on the list.
      console.error(`[operator-alert] send to ${address} failed:`, err);
    }
  }
  if (!to.length) console.warn(`[operator-alert] nobody to tell (SUPERADMIN_EMAILS is empty): ${alert.subject}`);
  return sent;
}
