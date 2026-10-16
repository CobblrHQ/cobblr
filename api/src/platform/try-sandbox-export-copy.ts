import { productName } from "./product-name.js";
// The words the take-your-work email says.
//
// Its own file with no imports on purpose. The export module reaches the
// database and the env schema, and importing either to check a sentence boots
// the whole app inside the test runner - which is how the sandbox token and
// query helpers ended up split out too. Copy that has to be right is worth
// being able to test cheaply.
/** The email, as a pure function of what the modal showed.
 *
 *  Pulled out so "the email mirrors the modal" is something a test can hold us
 *  to rather than a claim in a comment. Both paths come from the same env the
 *  modal reads through GET /try/paths, so the two cannot point different places.
 */
export function takeYourWorkEmail(o: {
  link: string;
  days: number;
  /** Empty when this deployment does not offer that path; it is then left out
   *  rather than printed as a dead line. */
  cloudUrl?: string | null;
  selfhostUrl?: string | null;
  /** What is true of the sandbox right now, in the words the page uses
   *  (lifetimeSentence), so the email never says something the page does not. */
  lifetime: string;
  /** The hosted product's door that brings this file straight into a new
   *  workspace after sign-up or sign-in (/bring). When there is one it is the
   *  email's first link, and the file itself is the second: a .zip on a phone
   *  has nowhere useful to go (#4217). */
  continueUrl?: string | null;
}): { subject: string; text: string } {
  const paths: string[] = [];
  if (o.cloudUrl) paths.push(`  Hosted, nothing to run: ${o.cloudUrl}`);
  if (o.selfhostUrl) paths.push(`  On your own machine:    ${o.selfhostUrl}`);
  const carryOn =
    paths.length > 0
      ? `${paths.length > 1 ? "Two ways" : "A way"} to carry on, and the same file opens ` +
        `${paths.length > 1 ? "either one" : "it"}:\n\n${paths.join("\n")}\n\n` +
        `Make a workspace, then restore this file into it and you are back where you left off.\n`
      : `Make a workspace anywhere ${productName()} runs, restore this file into it, and you are back where you left off.\n`;
  if (o.continueUrl) {
    return {
      subject: `Your ${productName()} workspace, to keep`,
      text:
        `Carry on with everything you made in your ${productName()} sandbox. Open this, sign up or sign in, ` +
        `and it is all brought into a new workspace for you:\n\n${o.continueUrl}\n\n` +
        `${o.lifetime} This link and the file behind it work for ${o.days} days.\n\n` +
        `Or download a copy of the file, to keep or to run ${productName()} yourself:\n\n${o.link}\n` +
        (o.selfhostUrl ? `\nRunning it yourself: ${o.selfhostUrl}\n` : ""),
    };
  }
  return {
    subject: `Your ${productName()} workspace, to keep`,
    text:
      `Here is everything you made in your ${productName()} sandbox, as one file:\n\n${o.link}\n\n` +
      `The link works for ${o.days} days, then the file is deleted. ${o.lifetime}\n\n` +
      carryOn,
  };
}
