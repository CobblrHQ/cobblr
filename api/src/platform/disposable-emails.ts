// Reject signups from known disposable / throwaway email providers. Enforced
// ONLY when COBBLR_BLOCK_DISPOSABLE_EMAILS=true (the trial box sets it); off by
// default, so self-host and prod are unaffected.
//
// A curated set of the highest-volume throwaway providers - not the exhaustive
// internet list (that's tens of thousands of churning domains), but the ones
// that actually show up in abuse. Extend as needed; a false block is worse for
// a real user than a false allow is for the trial, so keep it conservative.

const DISPOSABLE = new Set<string>([
  "mailinator.com", "guerrillamail.com", "guerrillamail.info", "guerrillamail.biz",
  "grr.la", "sharklasers.com", "spam4.me", "10minutemail.com", "10minutemail.net",
  "20minutemail.com", "temp-mail.org", "tempmail.com", "tempmailo.com", "tmpmail.org",
  "tmpmail.net", "tempr.email", "throwawaymail.com", "throwaway.email", "getnada.com",
  "nada.email", "yopmail.com", "yopmail.net", "yopmail.fr", "cool.fr.nf", "jetable.org",
  "mytemp.email", "maildrop.cc", "dispostable.com", "trashmail.com", "trashmail.de",
  "trash-mail.com", "wegwerfmail.de", "mailnesia.com", "mailcatch.com", "mohmal.com",
  "fakeinbox.com", "fakemailgenerator.com", "emailondeck.com", "mintemail.com",
  "spambog.com", "spamgourmet.com", "mailexpire.com", "mailnull.com", "moakt.com",
  "tempinbox.com", "tempmailaddress.com", "burnermail.io", "33mail.com", "anonaddy.me",
  "instantemailaddress.com", "luxusmail.org", "emailfake.com", "email-fake.com",
  "inboxkitten.com", "harakirimail.com", "spambox.us", "vomoto.com", "0-mail.com",
  "1secmail.com", "1secmail.org", "1secmail.net", "byom.de", "discard.email",
  "einrot.com", "fakemail.net", "gettempmail.com", "linshiyou.com", "mailde.de",
]);

export function blockDisposableEnabled(): boolean {
  return (process.env.COBBLR_BLOCK_DISPOSABLE_EMAILS ?? "").trim() === "true";
}

export function isDisposableEmail(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  return DISPOSABLE.has(email.slice(at + 1).toLowerCase().trim());
}
