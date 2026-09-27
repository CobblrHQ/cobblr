// How long a kept sandbox stays: ours to set, never the visitor's to pick.
//
// A sandbox lives an hour. Keeping it makes it a trial on the same demo box,
// short on purpose (#3254: "we don't want people to actually use it for
// real"). It used to be a choice of a week, two weeks or a month; the owner's
// call is that the length is a product setting, two weeks by default
// (TRY_SANDBOX_TRIAL_DAYS on the api), and the server ignores any length a
// client sends. The web reads the configured number back and says it in words.
//
// Buildless subpath: no runtime import of a sibling.

/** The length when nothing configures one. */
export const DEFAULT_TRIAL_DAYS = 14;

/** "a week", "two weeks", "a month", "10 days": a length said in a sentence. */
export function trialLengthPhrase(days: number): string {
  const words = ["", "one", "two", "three", "four", "five", "six", "seven", "eight"];
  if (days === 1) return "a day";
  if (days === 7) return "a week";
  if (days === 30 || days === 31) return "a month";
  if (days % 7 === 0 && days / 7 < words.length) return `${words[days / 7]} weeks`;
  return `${days} days`;
}

/** The same length said as time ON TOP of what someone has had: "two more
 *  weeks", "another week", "10 more days". */
export function trialLengthMorePhrase(days: number): string {
  const p = trialLengthPhrase(days);
  if (p.startsWith("a ")) return `another ${p.slice(2)}`;
  const [n, ...rest] = p.split(" ");
  return `${n} more ${rest.join(" ")}`;
}
